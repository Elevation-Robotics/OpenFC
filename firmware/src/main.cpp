// Copyright 2026 Mack Kemper
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
//
// OpenFC v1.4 — main firmware
//
// ESP32-S3 firmware for a 4-port USB-powered VEX V5 field controller.
//
// VEX, VEX Robotics and V5 are trademarks of Innovation First, Inc. (IFI).
// OpenFC is an independent project of Elevation Robotics and is not affiliated
// with, manufactured, endorsed, approved or sponsored by Innovation First, Inc.,
// VEX Robotics or the Robotics Education & Competition Foundation (RECF).
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
// Proto 3 adds period tokens, for hosts that lose and re-establish the link
// mid-match (a page reload, a reconnect, a replug). A period is identified by
// (match_id, period_seq), so a reconnecting host can replay start_period to say
// "this is the period you are already running" instead of asking for a new one,
// and the board can tell that apart from a genuinely new period. Alongside:
//   - resync:     adjust a running period's deadline, outputs untouched.
//   - end_period: operator abort, reported distinguishably from a fault.
//   - device_id binding, so a host that selected the wrong serial port on a
//     multi-field event cannot enable another field's robots.
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

// Period token (proto 3). Valid only while timerActive; tokenValid records
// whether the host that started the period supplied one at all, since a legacy
// host starts an untokenised period that must keep behaving as it did in v2.
static bool     tokenValid    = false;
static String   tokenMatchId;
static uint32_t tokenSeq      = 0;

// Device binding (proto 3). Latched when a period starts WITH a device_id, and
// then required on every command that affects that period. Fail closed: a host
// that proved which board it meant must keep proving it, so a second host that
// picked the wrong port cannot resync or end someone else's match. A period
// started without a device_id leaves this false and stays unbound.
static bool     tokenBound    = false;

// Tokens of completed periods, retained so a reconnecting host cannot replay
// one and start a fresh period after the match is over — the re-enable hole.
//
// Retirement is keyed on match_id and holds a high-water period_seq: every seq
// at or below the recorded one is retired. A single scalar slot was not enough,
// because in a two-period match the driver period's retirement would evict the
// auto period's, and a host replaying auto's start_period afterwards would find
// nothing to refuse it and run a second 15 s auto period with robots enabled —
// the same hole, one period further back. A high-water mark closes every
// earlier period in the match at no extra cost, and the several slots cover
// replays from earlier matches.
//
// Deliberately NOT cleared by estop: an estop followed by a replay of the same
// start_period is exactly what a confused reconnecting host produces, and
// re-enabling robots after an emergency stop is the worst available outcome. A
// new period after an estop needs a new period_seq.
// Cleared only by reboot (these are zero-initialised at boot).
static const size_t RETIRED_SLOTS = 4;
struct RetiredMatch {
    bool     valid  = false;
    String   matchId;
    uint32_t maxSeq = 0;
};
static RetiredMatch retired[RETIRED_SLOTS];
// Round-robin victim when a new match needs a slot, and the slot holding the
// most recently retired period (what emitTimerState reports).
static size_t retiredNext   = 0;
static int    retiredRecent = -1;

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
static void startPeriod(const String& mode, uint32_t durationMs,
                        bool hasToken, const String& matchId, uint32_t seq,
                        bool bind);
static void endPeriod(const char* reason, uint32_t elapsedMs);
static void retirePeriodToken();
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
                JsonDocument doc;
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
        JsonDocument hb;
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
static void startPeriod(const String& mode, uint32_t durationMs,
                        bool hasToken, const String& matchId, uint32_t seq,
                        bool bind) {
    // Atomic enable + countdown start. Suspends the comms watchdog implicitly
    // (the watchdog check is skipped while timerActive is true).
    timerActive   = true;
    timerMode     = mode;
    timerDuration = durationMs;
    timerStartMs  = millis();

    tokenValid    = hasToken;
    tokenMatchId  = hasToken ? matchId : String();
    tokenSeq      = hasToken ? seq : 0;
    tokenBound    = hasToken && bind;

    // TWDT backstop: duration + 10s. Resets the chip if the firmware hangs.
    twdtBegin(durationMs + TWDT_BACKSTOP_MS);

    enforceState(mode == "auto" ? State::S_ENABLED_AUTO : State::S_ENABLED_DRIVER);

    emitState();

    JsonDocument ack; ack["evt"]="ack"; ack["cmd"]="start_period";
    serializeJson(ack, Serial); Serial.println();
}

// True if this token names a period that has already completed. Any seq at or
// below the match's high-water mark counts: periods advance monotonically
// within a match, so an earlier seq is necessarily an earlier period.
static bool isRetiredToken(const String& matchId, uint32_t seq) {
    for (size_t i = 0; i < RETIRED_SLOTS; i++) {
        if (retired[i].valid && retired[i].matchId == matchId) {
            return seq <= retired[i].maxSeq;
        }
    }
    return false;
}

// Retire the active period's token, so replaying it — or any earlier period of
// the same match — can never start a second period. See the retired[]
// declarations for why estop does this too, and why nothing but a reboot
// clears it.
static void retirePeriodToken() {
    if (tokenValid) {
        int slot = -1;
        for (size_t i = 0; i < RETIRED_SLOTS; i++) {
            if (retired[i].valid && retired[i].matchId == tokenMatchId) {
                slot = (int)i;
                break;
            }
        }
        if (slot < 0) {
            // Prefer a free slot; otherwise evict round-robin, which retires
            // the oldest match rather than the one in progress.
            for (size_t i = 0; i < RETIRED_SLOTS && slot < 0; i++) {
                if (!retired[i].valid) slot = (int)i;
            }
            if (slot < 0) {
                slot = (int)retiredNext;
                retiredNext = (retiredNext + 1) % RETIRED_SLOTS;
            }
            retired[slot].valid   = true;
            retired[slot].matchId = tokenMatchId;
            retired[slot].maxSeq  = tokenSeq;
        } else if (tokenSeq > retired[slot].maxSeq) {
            retired[slot].maxSeq = tokenSeq;
        }
        retiredRecent = slot;
    }
    tokenValid = false;
    tokenBound = false;
    tokenMatchId = String();
    tokenSeq = 0;
}

// reason is "timer" (ran to completion) or "ended" (operator abort via
// end_period). Both disable the outputs; only expiry is an estop. An abort is a
// deliberate act, not a fault, and a host that surfaced it as one would show a
// hardware alarm every time a referee stopped a match early.
static void endPeriod(const char* reason, uint32_t elapsedMs) {
    String modeStr = timerMode;
    uint32_t duration = timerDuration;

    enforceState(State::S_DISABLED);
    twdtEnd();

    JsonDocument te;
    te["evt"] = "timer_expired";
    te["mode"] = modeStr;
    te["duration_ms"] = duration;
    te["elapsed_ms"] = elapsedMs;
    te["reason"] = reason;
    if (tokenValid) {
        te["match_id"] = tokenMatchId;
        te["period_seq"] = tokenSeq;
    }
    serializeJson(te, Serial); Serial.println();

    if (strcmp(reason, "timer") == 0) emitEstop("timer");

    retirePeriodToken();
    timerActive = false;
    timerDuration = 0;
    emitState();
}

// ─── Proto-3 token helpers ───

// Remaining time on the active period, 0 once it has run out.
static uint32_t periodRemaining(uint32_t now) {
    uint32_t elapsed = now - timerStartMs;
    return elapsed >= timerDuration ? 0 : timerDuration - elapsed;
}

// Reads and validates match_id/period_seq. Returns false and emits
// invalid_token if they are malformed or only one of the pair is present.
// present=false with a true return means a legacy, untokenised command.
static bool readToken(const JsonDocument& doc, const char* cmd, bool* present,
                      String* matchId, uint32_t* seq) {
    const bool hasId  = doc["match_id"].is<const char*>();
    // is<uint32_t> rejects negatives and out-of-range values outright.
    const bool hasSeq = doc["period_seq"].is<uint32_t>();
    if (!hasId && !hasSeq) { *present = false; return true; }
    if (hasId != hasSeq) { emitError("invalid_token", cmd); return false; }

    String id = doc["match_id"].as<const char*>();
    if (id.length() == 0 || id.length() > MATCH_ID_MAX_LEN) {
        emitError("invalid_token", cmd); return false;
    }
    *present = true;
    *matchId = id;
    *seq = doc["period_seq"].as<uint32_t>();
    return true;
}

// device_id binding. A command carrying a device_id that is not ours is never
// obeyed: on a multi-field event every board enumerates under the same USB
// name, so selecting the wrong port is the one mistake tokens cannot catch —
// the token is valid, it is simply meant for another board.
//
// Fail closed on the way back: once a period is bound, a command that affects
// it must keep naming the board. Otherwise a host that proved its identity to
// start the match could have that match resynced or ended by a second host that
// picked the wrong port and sends no device_id at all.
//
// estop deliberately never calls this. Refusing to disable robots because the
// wrong page asked is not a safety property worth having.
static bool checkDevice(const JsonDocument& doc, const char* cmd,
                        bool bindingApplies) {
    if (doc["device_id"].is<const char*>()) {
        if (getDeviceId() != doc["device_id"].as<const char*>()) {
            emitError("wrong_device", cmd);
            return false;
        }
        return true;
    }
    if (bindingApplies && timerActive && tokenBound) {
        emitError("wrong_device", cmd);
        return false;
    }
    return true;
}

// Shared token check for resync/end_period: the command must name exactly the
// period that is running.
static bool requireActiveToken(const JsonDocument& doc, const char* cmd) {
    bool present = false;
    String matchId;
    uint32_t seq = 0;
    if (!readToken(doc, cmd, &present, &matchId, &seq)) return false;
    if (!present || !timerActive || !tokenValid ||
        tokenMatchId != matchId || tokenSeq != seq) {
        emitError("token_mismatch", cmd);
        return false;
    }
    return true;
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

        JsonDocument ack; ack["evt"]="ack"; ack["cmd"]="set";
        serializeJson(ack, Serial); Serial.println();
        emitState();

    } else if (strcmp(cmd, "start_period") == 0) {
        if (!checkDevice(doc, "start_period", true)) return;

        bool hasToken = false;
        String matchId;
        uint32_t seq = 0;
        if (!readToken(doc, "start_period", &hasToken, &matchId, &seq)) return;

        if (hasToken && timerActive && tokenValid &&
            tokenMatchId == matchId && tokenSeq == seq) {
            // The host is replaying the token of the period we are already
            // running — it reconnected and is re-establishing context, not
            // asking for a new period. Ack without touching the countdown or
            // re-firing the enable. Duration corrections go through resync.
            JsonDocument ack; ack["evt"]="ack"; ack["cmd"]="start_period";
            serializeJson(ack, Serial); Serial.println();
            emitState();
            return;
        }
        if (timerActive) { emitError("timer_active", "start_period"); return; }

        // A token that already ran to completion must not start a second
        // period: without this, a host that died just before expiry reconnects,
        // sees no active period, replays its start_period and re-enables the
        // robots after the match is over.
        if (hasToken && isRetiredToken(matchId, seq)) {
            emitError("period_complete", "start_period"); return;
        }

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
        startPeriod(modeStr, (uint32_t)duration, hasToken, matchId, seq,
                    doc["device_id"].is<const char*>());

    } else if (strcmp(cmd, "resync") == 0) {
        // Correct the deadline of the running period against the host's
        // authoritative clock. Deliberately inert on the outputs: it never
        // enables, disables, changes mode or re-fires a start.
        if (!checkDevice(doc, "resync", true)) return;
        if (!requireActiveToken(doc, "resync")) return;
        if (!doc["remaining_ms"].is<uint32_t>()) {
            emitError("invalid_duration", "resync"); return;
        }
        uint32_t wanted = doc["remaining_ms"].as<uint32_t>();
        uint32_t now = millis();
        uint32_t current = periodRemaining(now);

        // Asymmetric on purpose. Shortening a period is always safe, so it is
        // unrestricted; extending one keeps robots live past when the match
        // says they should be, so it is capped. A host asking for a large
        // extension has a wrong clock, not a longer match.
        if (wanted > current && (wanted - current) > RESYNC_EXTEND_MAX_MS) {
            emitError("resync_out_of_range", "resync"); return;
        }
        uint32_t elapsed = now - timerStartMs;
        if (elapsed > timerDuration) elapsed = timerDuration;
        timerDuration = elapsed + wanted;
        twdtBegin(wanted + TWDT_BACKSTOP_MS);

        JsonDocument ack;
        ack["evt"] = "ack";
        ack["cmd"] = "resync";
        ack["delta_ms"] = (int32_t)wanted - (int32_t)current;
        serializeJson(ack, Serial); Serial.println();

    } else if (strcmp(cmd, "end_period") == 0) {
        // Operator abort (a referee stopping a match early). Ends the period
        // and disables, but reports reason:"ended" rather than an estop so the
        // host does not surface a deliberate act as a hardware fault.
        if (!checkDevice(doc, "end_period", true)) return;
        if (!requireActiveToken(doc, "end_period")) return;
        uint32_t elapsed = millis() - timerStartMs;
        if (elapsed > timerDuration) elapsed = timerDuration;

        JsonDocument ack; ack["evt"]="ack"; ack["cmd"]="end_period";
        serializeJson(ack, Serial); Serial.println();
        endPeriod("ended", elapsed);

    } else if (strcmp(cmd, "get_timer") == 0) {
        emitTimerState();

    } else if (strcmp(cmd, "estop") == 0) {
        // Immediate disable in both manual and timed modes. Never gated on
        // device_id or a token: anything that can reach the board is allowed to
        // stop the robots, and a rejected estop is a far worse failure than one
        // delivered to the wrong field.
        if (timerActive) {
            retirePeriodToken();
            timerActive = false;
            timerDuration = 0;
            twdtEnd();
        }
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
        JsonDocument ack; ack["evt"]="ack"; ack["cmd"]="set_pin";
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
        JsonDocument ack; ack["evt"]="ack"; ack["cmd"]="identify";
        serializeJson(ack, Serial); Serial.println();

    } else if (strcmp(cmd, "ping") == 0) {
        // Keepalive. Like every command it refreshes the comms watchdog above,
        // which is what keeps a manual enable (or raw set_pin diagnostic) alive.
        // During a timed period the watchdog is suspended, so pings are inert.
        JsonDocument ack; ack["evt"]="ack"; ack["cmd"]="ping";
        serializeJson(ack, Serial); Serial.println();

    } else {
        emitError("unknown_command", cmd[0] ? cmd : nullptr);
    }
}

// ─── Event emitters ───
// These use a heap-backed JsonDocument rather than a fixed-capacity one. The
// token fields push the worst case (32-char match_id plus period_seq, every
// optional field present) past the old StaticJsonDocument sizes, and
// ArduinoJson truncates silently on overflow rather than erroring — the failure
// would surface as an intermittently malformed event, not a crash.
static void emitHello() {
    JsonDocument doc;
    doc["evt"] = "hello";
    doc["proto"] = OPENFC_PROTO_VERSION;
    doc["fw_version"] = OPENFC_FW_VERSION;
    doc["hw_version"] = OPENFC_HW_VERSION;
    doc["device_id"] = getDeviceId();
    doc["fw_hash"] = getAppHash();
    serializeJson(doc, Serial); Serial.println();
}

static void emitState() {
    JsonDocument doc;
    doc["evt"] = "state";
    doc["enable"] = reportedEnabled;
    doc["mode"] = currentMode;
    doc["state"] = stateName(currentState);
    // Raw diagnostics have desynced the pins from the state machine; tell the
    // host so it does not trust `enable`/`mode` blindly.
    if (diagActive) doc["diag"] = true;
    if (timerActive) {
        doc["timed"] = true;
        doc["duration_ms"] = timerDuration;
        doc["remaining_ms"] = periodRemaining(millis());
        if (tokenValid) {
            doc["match_id"] = tokenMatchId;
            doc["period_seq"] = tokenSeq;
            doc["bound"] = tokenBound;
        }
    }
    doc["uptime_ms"] = millis();
    serializeJson(doc, Serial); Serial.println();
}

// The reconciliation path: a reconnecting host must learn from one round trip
// which period the board thinks it is running and how much of it is left. When
// nothing is running, the retired token answers the other half of the question
// — "did the period I was tracking already finish, or did it never start?".
static void emitTimerState() {
    JsonDocument doc;
    doc["evt"] = "timer_state";
    doc["active"] = timerActive;
    if (timerActive) {
        uint32_t elapsed = millis() - timerStartMs;
        if (elapsed > timerDuration) elapsed = timerDuration;
        doc["mode"] = timerMode;
        doc["duration_ms"] = timerDuration;
        doc["remaining_ms"] = timerDuration - elapsed;
        doc["elapsed_ms"] = elapsed;
        if (tokenValid) {
            doc["match_id"] = tokenMatchId;
            doc["period_seq"] = tokenSeq;
            doc["bound"] = tokenBound;
        }
    } else if (retiredRecent >= 0) {
        // The most recently retired period. A host reconciling an earlier
        // period of the same match will not see its own seq here, so it must
        // compare with <= rather than == — last_period_seq is a high-water
        // mark for last_match_id, not just the final period's number.
        doc["last_match_id"] = retired[retiredRecent].matchId;
        doc["last_period_seq"] = retired[retiredRecent].maxSeq;
    }
    serializeJson(doc, Serial); Serial.println();
}

static void emitPins() {
    JsonDocument doc;
    doc["evt"] = "pins";
    JsonArray arr = doc["pins"].to<JsonArray>();
    for (int i = 0; i < 4; i++) {
        JsonObject o = arr.add<JsonObject>();
        o["pin"]   = PINS_AD[i];
        o["label"] = PIN_LABELS[i];
        o["value"] = (outShadow[i] == HIGH);
    }
    for (int i = 0; i < 4; i++) {
        JsonObject o = arr.add<JsonObject>();
        o["pin"]   = PINS_ED[i];
        o["label"] = PIN_LABELS[4 + i];
        o["value"] = (outShadow[4 + i] == HIGH);
    }
    serializeJson(doc, Serial); Serial.println();
}

static void emitEstop(const char* source) {
    JsonDocument doc;
    doc["evt"] = "estop";
    doc["source"] = source;
    doc["uptime_ms"] = millis();
    serializeJson(doc, Serial); Serial.println();
}

static void emitError(const char* reason, const char* cmd) {
    JsonDocument e;
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
