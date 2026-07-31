// OpenFC v1.2 — main firmware
//
// ESP32-S3 firmware for a 4-port USB-powered VEX V5 field controller.
//
// Protocol: JSON-lines over USB CDC at 115200 baud (spec §5). Adds timed-period
// support on top of the v1.1 manual-control firmware:
//   - start_period: atomically enable + start an internal countdown, suspending
//     the comms watchdog for the duration (spec §4, §5.1).
//   - get_timer:    report current timer state (timer_state event).
//   - get_info:     re-emit the hello event on demand. hello is otherwise only
//     sent at boot, which a host that attaches to an already-running board never
//     sees, leaving it unable to read fw_version/device_id/fw_hash.
//   - timer_expired + estop(source="timer") on normal expiry.
//   - fw_hash in hello (spec §8): SHA-256 of the running app partition,
//     computed at runtime (no build-time embedding, so no circular hash).
//   - ESP32 Task Watchdog Timer (TWDT) backstop = duration_ms + 10s during a
//     timed period, so a firmware hang still disables the robots.
//
// Output polarity & pins live in openfc_pins.h. All 4 ports move in unison.
// Boots into a SAFE (Disabled) state; see the safety notes in openfc_pins.h.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <esp_task_wdt.h>
#include <esp_partition.h>
#include <esp_ota_ops.h>

#include "openfc_pins.h"

namespace openfc {

const char* stateName(State s) {
    switch (s) {
        case State::S_BOOT:           return "BOOT";
        case State::S_DISABLED:       return "DISABLED";
        case State::S_ENABLED_DRIVER: return "ENABLED_DRIVER";
        case State::S_ENABLED_AUTO:   return "ENABLED_AUTO";
        case State::S_ESTOP_WATCHDOG: return "ESTOP_WATCHDOG";
    }
    return "?";
}

String getDeviceId() {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char buf[16];
    snprintf(buf, sizeof(buf), "openfc-%02X%02X%02X", mac[3], mac[4], mac[5]);
    return String(buf);
}

// SHA-256 of the running application partition, as a lowercase hex string.
// Returns the digest esptool appended to the app image at build time (the same
// value reproducible offline from firmware.bin), so the web manifest can verify
// a connected board without any build-time hash embedding. Empty on failure.
String getAppHash() {
    const esp_partition_t* running = esp_ota_get_running_partition();
    if (!running) return String();
    uint8_t sha[32];
    if (esp_partition_get_sha256(running, sha) != ESP_OK) return String();
    char hex[65];
    for (int i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", sha[i]);
    hex[64] = '\0';
    return String(hex);
}

}  // namespace openfc

using namespace openfc;

// ─── Module-scope state ───
static State currentState = State::S_BOOT;
static bool reportedEnabled = false;
static String currentMode = "driver";

static uint32_t lastHostCommandMs = 0;
static uint32_t lastHeartbeatMs   = 0;
static uint32_t identifyEndMs     = 0;
static bool identifying = false;

// True once set_pin has taken raw ownership of the opto GPIOs, until the next
// high-level transition reclaims them (setOutputs clears it). Raw diagnostics
// can assert ENABLE on a live V5, so they are covered by the same comms
// watchdog as a manual enable — see the watchdog check in loop().
static bool diagActive = false;

// Timed-period state (spec §4.2, §5.1).
static bool     timerActive   = false;
static String   timerMode     = "auto";
static uint32_t timerDuration = 0;   // ms
static uint32_t timerStartMs  = 0;   // millis() at start
static bool     twdtActive    = false;

static String inputBuf;

// Raw-output shadow for diagnostics (get_pins/set_pin). Index 0..3 = AD1..AD4,
// 4..7 = ED1..ED4. Mirrors the last level driven onto each opto GPIO so the host
// can read back pin state without relying on digitalRead of an OUTPUT pin.
static int outShadow[8];
static const char* PIN_LABELS[8] = {
    "AD1", "AD2", "AD3", "AD4", "ED1", "ED2", "ED3", "ED4",
};

// Map a GPIO number to its outShadow index, or -1 if it is not a controlled pin.
static int pinIndex(int pin) {
    for (int i = 0; i < 4; i++) {
        if (PINS_AD[i] == pin) return i;
        if (PINS_ED[i] == pin) return 4 + i;
    }
    return -1;
}

// ─── Forward decls ───
static void setOutputs(bool enable, const String& mode);
static void enforceState(State s);
static void handleCommand(const JsonDocument& doc);
static void emitState();
static void emitHello();
static void emitEstop(const char* source);
static void startPeriod(const String& mode, uint32_t durationMs);
static void endPeriod(const char* reason, uint32_t elapsedMs);
static void emitTimerState();
static void emitError(const char* reason, const char* cmd);
static void emitPins();
static void twdtBegin(uint32_t windowMs);
static void twdtEnd();

// ─── Setup ───
void setup() {
    // SAFETY FIRST: drive all ports to Disabled before anything else.
    for (int i = 0; i < 4; i++) {
        pinMode(PINS_AD[i], OUTPUT);
        pinMode(PINS_ED[i], OUTPUT);
        digitalWrite(PINS_AD[i], OPTO_OFF);   // Driver
        digitalWrite(PINS_ED[i], OPTO_ON);    // Disabled (safe): E/D HIGH
        outShadow[i]     = OPTO_OFF;
        outShadow[4 + i] = OPTO_ON;
    }

    pinMode(PIN_BOOT_BTN, INPUT_PULLUP);

    Serial.begin(115200);
    Serial.setTimeout(50);

    currentState = State::S_DISABLED;
    reportedEnabled = false;
    currentMode = "driver";

#if ARDUINO_USB_CDC_ON_BOOT
    // Native USB-Serial-JTAG (HWCDC) silently discards TX until the host has
    // opened and is draining the CDC endpoint. A fixed delay races that link, so
    // the boot hello/state were being dropped. Wait (bounded) for the link, then
    // let it settle, so the first events are actually delivered.
    Serial.setTxTimeoutMs(0);   // never block the loop on a busy/absent host
    for (uint32_t t0 = millis(); !Serial && (millis() - t0) < 3000; ) delay(10);
    delay(50);
#else
    delay(150);  // UART0 (CH340C): allow the bridge/host to settle
#endif

    emitHello();
    emitState();
}

// ─── Loop ───
void loop() {
    // NOTE: the TWDT is a one-shot backstop, not a fed watchdog. It is armed to
    // duration_ms + 10s when a period starts (twdtBegin) and disarmed by
    // endPeriod()/twdtEnd() when the period ends normally. We deliberately do
    // NOT call esp_task_wdt_reset() here: if the firmware hangs and never ends
    // the period, the TWDT elapses at duration_ms + 10s and reboots the chip
    // into the safe Disabled state (spec §12).

    // Read incoming JSON lines
    while (Serial.available()) {
        char c = (char) Serial.read();
        if (c == '\n' || c == '\r') {
            if (inputBuf.length() > 0) {
                StaticJsonDocument<256> doc;
                DeserializationError err = deserializeJson(doc, inputBuf);
                if (err) {
                    emitError("parse_error", nullptr);
                } else {
                    handleCommand(doc);
                }
                inputBuf = "";
            }
        } else if (inputBuf.length() < 240) {
            inputBuf += c;
        }
    }

    // Capture the time AFTER draining input: a command handled this iteration
    // has already refreshed lastHostCommandMs. If we sampled `now` before the
    // read (as we used to), a freshly enabling `set` left lastHostCommandMs >
    // now, so the unsigned watchdog subtraction (now - lastHostCommandMs)
    // underflowed and tripped ESTOP the instant we enabled.
    uint32_t now = millis();

    // Timed period expiry (authoritative safety countdown, host-independent).
    if (timerActive && (now - timerStartMs) >= timerDuration) {
        endPeriod("timer", now - timerStartMs);
    }

    // Comms watchdog — suspended while a timed period is active (spec §4.2).
    // Also covers raw set_pin diagnostics: those bypass the state machine, so
    // without this a host that asserted ENABLE via set_pin and then died would
    // leave the robots live indefinitely while the board still reported
    // DISABLED.
    bool isEnabled = (currentState == State::S_ENABLED_DRIVER ||
                      currentState == State::S_ENABLED_AUTO);
    if (!timerActive && (isEnabled || diagActive) &&
        (now - lastHostCommandMs) > WATCHDOG_TIMEOUT_MS) {
        enforceState(State::S_ESTOP_WATCHDOG);
        emitEstop("watchdog");
        emitState();
    }

    // Heartbeat
    if (now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatMs = now;
        StaticJsonDocument<96> hb;
        hb["evt"] = "heartbeat";
        hb["uptime_ms"] = now;
        serializeJson(hb, Serial);
        Serial.println();
    }

    if (identifying && now >= identifyEndMs) identifying = false;
}

// ─── Output control (unison) ───
static void setOutputs(bool enable, const String& mode) {
    bool autoMode = (mode == "auto");
    int adVal = (enable && autoMode) ? OPTO_ON : OPTO_OFF;  // AD: HIGH = Autonomous
    int edVal = enable ? OPTO_OFF : OPTO_ON;                // ED: HIGH = Disabled

    for (int i = 0; i < 4; i++) {
        digitalWrite(PINS_AD[i], adVal);
        digitalWrite(PINS_ED[i], edVal);
        outShadow[i]     = adVal;
        outShadow[4 + i] = edVal;
    }
    reportedEnabled = enable;
    currentMode = mode;
    // A high-level transition reclaims the outputs from raw diagnostics, so the
    // reported state and the pins are back in agreement.
    diagActive = false;
}

static void enforceState(State s) {
    currentState = s;
    switch (s) {
        case State::S_BOOT:
        case State::S_DISABLED:
        case State::S_ESTOP_WATCHDOG:
            setOutputs(false, "driver");
            break;
        case State::S_ENABLED_DRIVER:
            setOutputs(true, "driver");
            break;
        case State::S_ENABLED_AUTO:
            setOutputs(true, "auto");
            break;
    }
}

// ─── Timed period (spec §4.2, §5.1) ───
static void startPeriod(const String& mode, uint32_t durationMs) {
    // Atomic enable + countdown start. Suspends the comms watchdog implicitly
    // (the watchdog check is skipped while timerActive is true).
    timerActive   = true;
    timerMode     = mode;
    timerDuration = durationMs;
    timerStartMs  = millis();

    // TWDT backstop: duration + 10s. Resets the chip if the firmware hangs.
    twdtBegin(durationMs + TWDT_BACKSTOP_MS);

    enforceState(mode == "auto" ? State::S_ENABLED_AUTO : State::S_ENABLED_DRIVER);

    StaticJsonDocument<160> st;
    st["evt"] = "state";
    st["enable"] = true;
    st["mode"] = mode;
    st["state"] = stateName(currentState);
    st["timed"] = true;
    st["duration_ms"] = durationMs;
    st["remaining_ms"] = durationMs;
    st["uptime_ms"] = millis();
    serializeJson(st, Serial); Serial.println();

    StaticJsonDocument<64> ack; ack["evt"]="ack"; ack["cmd"]="start_period";
    serializeJson(ack, Serial); Serial.println();
}

static void endPeriod(const char* reason, uint32_t elapsedMs) {
    String modeStr = timerMode;
    uint32_t duration = timerDuration;

    enforceState(State::S_DISABLED);
    twdtEnd();

    if (strcmp(reason, "timer") == 0) {
        StaticJsonDocument<128> te;
        te["evt"] = "timer_expired";
        te["mode"] = modeStr;
        te["duration_ms"] = duration;
        te["elapsed_ms"] = elapsedMs;
        serializeJson(te, Serial); Serial.println();
        emitEstop("timer");
    }

    timerActive = false;
    timerDuration = 0;
    emitState();
}

// ─── Command dispatch ───
static void handleCommand(const JsonDocument& doc) {
    lastHostCommandMs = millis();
    const char* cmd = doc["cmd"] | "";

    if (strcmp(cmd, "set") == 0) {
        // Manual control. Reject while a timed period owns the outputs.
        if (timerActive) { emitError("timer_active", "set"); return; }
        bool enable = doc["enable"] | false;
        const char* mode = doc["mode"] | "driver";
        String modeStr(mode);
        if (modeStr != "driver" && modeStr != "auto") modeStr = "driver";

        if (enable && modeStr == "auto")      enforceState(State::S_ENABLED_AUTO);
        else if (enable)                       enforceState(State::S_ENABLED_DRIVER);
        else                                   enforceState(State::S_DISABLED);

        StaticJsonDocument<64> ack; ack["evt"]="ack"; ack["cmd"]="set";
        serializeJson(ack, Serial); Serial.println();
        emitState();

    } else if (strcmp(cmd, "start_period") == 0) {
        if (timerActive) { emitError("timer_active", "start_period"); return; }
        const char* mode = doc["mode"] | "";
        String modeStr(mode);
        if (modeStr != "driver" && modeStr != "auto") {
            emitError("invalid_mode", "start_period"); return;
        }
        if (!doc["duration_ms"].is<uint32_t>() && !doc["duration_ms"].is<int>()) {
            emitError("invalid_duration", "start_period"); return;
        }
        long duration = doc["duration_ms"] | 0;
        if (duration < (long)PERIOD_MIN_MS || duration > (long)PERIOD_MAX_MS) {
            emitError("invalid_duration", "start_period"); return;
        }
        startPeriod(modeStr, (uint32_t)duration);

    } else if (strcmp(cmd, "get_timer") == 0) {
        emitTimerState();

    } else if (strcmp(cmd, "estop") == 0) {
        // Immediate disable in both manual and timed modes.
        if (timerActive) { timerActive = false; timerDuration = 0; twdtEnd(); }
        enforceState(State::S_DISABLED);
        emitEstop("software");
        emitState();

    } else if (strcmp(cmd, "set_pin") == 0) {
        // Raw single-GPIO diagnostic. value=true drives the pin HIGH (selects the
        // active choice). Rejected while a timed period owns the outputs.
        if (timerActive) { emitError("timer_active", "set_pin"); return; }
        if (!doc["pin"].is<int>()) { emitError("invalid_pin", "set_pin"); return; }
        int pin = doc["pin"] | -1;
        int idx = pinIndex(pin);
        if (idx < 0) { emitError("invalid_pin", "set_pin"); return; }
        int level = (doc["value"] | false) ? HIGH : LOW;
        digitalWrite(pin, level);
        outShadow[idx] = level;
        diagActive = true;
        StaticJsonDocument<64> ack; ack["evt"]="ack"; ack["cmd"]="set_pin";
        serializeJson(ack, Serial); Serial.println();
        emitPins();
        // The host needs the diag flag to know it must now feed the watchdog.
        emitState();

    } else if (strcmp(cmd, "get_pins") == 0) {
        emitPins();

    } else if (strcmp(cmd, "get_state") == 0) {
        emitState();

    } else if (strcmp(cmd, "get_info") == 0) {
        // Re-emit the boot identity so a host that attached mid-run can read
        // fw_version / hw_version / device_id / fw_hash.
        emitHello();

    } else if (strcmp(cmd, "identify") == 0) {
        identifying = true;
        identifyEndMs = millis() + IDENTIFY_DURATION_MS;
        StaticJsonDocument<64> ack; ack["evt"]="ack"; ack["cmd"]="identify";
        serializeJson(ack, Serial); Serial.println();

    } else if (strcmp(cmd, "ping") == 0) {
        // Keepalive. Like every command it refreshes the comms watchdog above,
        // which is what keeps a manual enable (or raw set_pin diagnostic) alive.
        // During a timed period the watchdog is suspended, so pings are inert.
        StaticJsonDocument<64> ack; ack["evt"]="ack"; ack["cmd"]="ping";
        serializeJson(ack, Serial); Serial.println();

    } else {
        emitError("unknown_command", cmd[0] ? cmd : nullptr);
    }
}

// ─── Event emitters ───
static void emitHello() {
    StaticJsonDocument<256> doc;
    doc["evt"] = "hello";
    doc["proto"] = OPENFC_PROTO_VERSION;
    doc["fw_version"] = OPENFC_FW_VERSION;
    doc["hw_version"] = OPENFC_HW_VERSION;
    doc["device_id"] = getDeviceId();
    doc["fw_hash"] = getAppHash();
    serializeJson(doc, Serial); Serial.println();
}

static void emitState() {
    StaticJsonDocument<256> doc;
    doc["evt"] = "state";
    doc["enable"] = reportedEnabled;
    doc["mode"] = currentMode;
    doc["state"] = stateName(currentState);
    // Raw diagnostics have desynced the pins from the state machine; tell the
    // host so it does not trust `enable`/`mode` blindly.
    if (diagActive) doc["diag"] = true;
    if (timerActive) {
        uint32_t elapsed = millis() - timerStartMs;
        uint32_t remaining = elapsed >= timerDuration ? 0 : timerDuration - elapsed;
        doc["timed"] = true;
        doc["duration_ms"] = timerDuration;
        doc["remaining_ms"] = remaining;
    }
    doc["uptime_ms"] = millis();
    serializeJson(doc, Serial); Serial.println();
}

static void emitTimerState() {
    StaticJsonDocument<160> doc;
    doc["evt"] = "timer_state";
    doc["active"] = timerActive;
    if (timerActive) {
        uint32_t elapsed = millis() - timerStartMs;
        if (elapsed > timerDuration) elapsed = timerDuration;
        doc["mode"] = timerMode;
        doc["duration_ms"] = timerDuration;
        doc["remaining_ms"] = timerDuration - elapsed;
        doc["elapsed_ms"] = elapsed;
    }
    serializeJson(doc, Serial); Serial.println();
}

static void emitPins() {
    StaticJsonDocument<512> doc;
    doc["evt"] = "pins";
    JsonArray arr = doc.createNestedArray("pins");
    for (int i = 0; i < 4; i++) {
        JsonObject o = arr.createNestedObject();
        o["pin"]   = PINS_AD[i];
        o["label"] = PIN_LABELS[i];
        o["value"] = (outShadow[i] == HIGH);
    }
    for (int i = 0; i < 4; i++) {
        JsonObject o = arr.createNestedObject();
        o["pin"]   = PINS_ED[i];
        o["label"] = PIN_LABELS[4 + i];
        o["value"] = (outShadow[4 + i] == HIGH);
    }
    serializeJson(doc, Serial); Serial.println();
}

static void emitEstop(const char* source) {
    StaticJsonDocument<96> doc;
    doc["evt"] = "estop";
    doc["source"] = source;
    doc["uptime_ms"] = millis();
    serializeJson(doc, Serial); Serial.println();
}

static void emitError(const char* reason, const char* cmd) {
    StaticJsonDocument<128> e;
    e["evt"] = "error";
    e["reason"] = reason;
    if (cmd) e["cmd"] = cmd;
    serializeJson(e, Serial); Serial.println();
}

// ─── ESP32 Task Watchdog (TWDT) backstop ───
static void twdtBegin(uint32_t windowMs) {
    // Reconfigure the TWDT to fire after windowMs if not reset (panic = reboot).
    // Arduino-ESP32 2.0.x (IDF 4.4) uses the legacy API: timeout in whole
    // seconds, panic flag. Round the window up so we never undershoot.
    uint32_t windowS = (windowMs + 999) / 1000;
    if (windowS < 1) windowS = 1;
    esp_task_wdt_deinit();
    esp_task_wdt_init(windowS, true);   // panic = reboot on timeout
    esp_task_wdt_add(NULL);             // subscribe the loop (Arduino) task
    twdtActive = true;
}

static void twdtEnd() {
    if (!twdtActive) return;
    esp_task_wdt_delete(NULL);
    esp_task_wdt_deinit();
    twdtActive = false;
}
