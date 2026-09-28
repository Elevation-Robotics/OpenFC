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
// OpenFC V1_3 BRING-UP firmware (ESP32-S3 side) — NOT production firmware.
//
// Exercises every subsystem on the new "Open_FC_V1_3 REV A" prototype in
// isolation, over the same JSON-lines-over-USB framing style as the
// certified firmware/src/main.cpp, so it's easy to test from a browser
// console/terminal before any production protocol work happens on this
// board. See docs in openfc_pins_v13.h for the pin map and what is/isn't
// verified yet.
//
// Commands (host -> board, {"cmd":...}):
//   get_info                                   -> bu_hello
//   ping                                        -> ack
//   legacy_set   {enable,mode}                  -> bu_legacy_state
//   legacy_raw   {ed,ad}                        -> bu_legacy_state (diag=true)
//   rs485_raw    {port:"A"|"B", de, bytes:[..]} -> bu_rs485_rx
//   rs485_linktest {port:"A"|"B"}               -> bu_linktest_result
//   rp2350_ctrl  {run, boot_ctrl}               -> bu_rp2350_state
//   rp2350_spi   {op:"ping"|"rs485_raw"|"linktest", port, de, bytes}
//                                                -> bu_spi_result /
//                                                   bu_rs485_rx / bu_linktest_result
//   rp2350_swd_probe                            -> bu_swd_probe
//   rp2350_flash_begin {size}                   -> bu_flash_status
//   rp2350_flash_data  {b64}                    -> bu_flash_status
//   rp2350_flash_end                            -> bu_flash_status
//   field_engage {on, interlock}                -> bu_field
//   field_state  {state:"disabled"|"driver"|"auton"} -> bu_field
//   field_period {driver,auton}  (ms)           -> bu_field
//   capture      {ports:["A","B","C","D"], on, stream} -> bu_cap_status
//   capture      {dump:true}                    -> bu_cap per record, then bu_cap_status done
//   relay        {ms, hold_us}                  -> bu_relay_result (blocks for ms; then dump)
//   led_set      {index,r,g,b}                  -> ack
//   identify                                    -> ack (then animates)
//
// Events (board -> host, {"evt":...}): bu_hello, bu_state (1 Hz heartbeat),
// bu_legacy_state, bu_rs485_rx, bu_linktest_result, bu_rp2350_state,
// bu_spi_result, bu_cap, bu_cap_status, bu_rp2350_reset, bu_relay_result,
// ack, bu_error.

#include <Arduino.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <Adafruit_NeoPixel.h>
#include <driver/uart.h>

#include "openfc_pins_v13.h"
#include "openfc_frames.h"
#include "openfc_spi_link.h"
#include "openfc_capture.h"
#include "devtools.h"
#include "smart_link.h"
#include "swd_rp2350.h"

namespace openfc_bringup {

String getDeviceId() {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    char buf[24];
    snprintf(buf, sizeof(buf), "openfc-v13-%02X%02X%02X", mac[3], mac[4], mac[5]);
    return String(buf);
}

}  // namespace openfc_bringup

using namespace openfc_bringup;

// ─── Module-scope state ───
static String inputBuf;
static uint32_t lastHeartbeatMs = 0;
static bool identifying = false;
static uint32_t identifyEndMs = 0;

static bool legacyEnable = false;
static String legacyMode = "driver";
static bool legacyDiag = false;

static bool rp2350Run = false;        // released at the end of setup()
static bool rp2350BootCtrl = false;

static Adafruit_NeoPixel pixels(NEOPIXEL_COUNT, PIN_WS2812_DATA, NEO_GRBW + NEO_KHZ800);

enum class StatusShown { Unknown, Disabled, Auton, Driver };
static StatusShown ledsShown = StatusShown::Unknown;

static HardwareSerial BusA(1);
static HardwareSerial BusB(2);

// ─── Field-control session engines (ports A/B; the "real" protocol) ───
// Global field state shared by both engines — a field drives every port in
// unison. See smart_link.h for the engine's provenance.
openfc_state_t g_field_state = STATE_DISABLED;
uint32_t g_driver_period_ms = 105000;   // standard VRC 1:45 driver
uint32_t g_auton_period_ms = 15000;     // 15 s auton
bool g_field_interlock = false;
static bool fieldEngaged = false;
static uint32_t lastHostPingMs = 0;

// ─── Ports C/D status, proxied from the RP2350 over SPI ───
// The session engines for C/D run ON the RP2350 (smart_link_rp.*, identical
// protocol logic to linkA/linkB); this ESP32 only relays field_engage/
// field_state/field_period out and polls field status back, at ~5 Hz —
// fast enough for the UI, far under the RP2350's own 50 Hz A7 tick which
// runs independently of this link.
struct Rp2350PortStatus {
    bool linkUp = false;
    int streamKind = 0;
    uint16_t pollAckCount = 0;
    uint8_t linkAckCount = 0;
    uint8_t swreplugCount = 0;
    char robotName[7] = {0};
    bool haveStatus = false;   // false until the first successful poll
};
static Rp2350PortStatus portC, portD;
static uint32_t lastRp2350PollMs = 0;
static bool rp2350Reachable = false;
// Consecutive failed requests; three in a row pulses RUN (rp2350Recover).
static uint8_t  rp2350Fails = 0;
static uint32_t rp2350Resets = 0;
static uint32_t rp2350LastResetMs = 0;
// True between rp2350_flash_begin and the end (or failure) of the session:
// the RP2350 is halted, so SPI polling and auto-recovery must stay off.
static bool rp2350Flashing = false;
// After a reset pulse: no SPI until the RP2350 has booted, then re-send the
// field state once it answers. Recovery backs off while it keeps failing.
static uint32_t rp2350HoldoffUntilMs = 0;
static bool rp2350NeedFieldSet = false;
static uint32_t rp2350RetryMs = 5000;
// Chrome throttles background tabs to >=1 s timers; 2500 ms tolerates that
// (same rationale as the proven firmware's watchdog).
static const uint32_t FIELD_WATCHDOG_MS = 2500;
static SmartLink linkA, linkB;

static const char* fieldStateName(openfc_state_t s) {
    return (s == STATE_DISABLED) ? "disabled" : (s == STATE_DRIVER) ? "driver" : "auton";
}

// Minimal base64 decoder for the RP2350 flash-data stream.
static size_t b64Decode(const char* in, uint8_t* out, size_t outCap) {
    auto val = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };
    size_t n = 0;
    uint32_t acc = 0;
    int bits = 0;
    for (const char* p = in; *p && *p != '='; p++) {
        int v = val(*p);
        if (v < 0) return 0;   // invalid character: reject the whole line
        acc = (acc << 6) | (uint32_t)v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (n >= outCap) return 0;
            out[n++] = (uint8_t)(acc >> bits);
        }
    }
    return n;
}

// ─── Forward decls ───
static void handleCommand(const JsonDocument& doc);
static void emitHello();
static void emitError(const char* reason, const char* cmd);
static void emitFieldState();
static void emitLegacyState();
static void emitRp2350State();
static void emitHeartbeat();
static void doLegacySet(bool enable, const String& mode);
static void doLegacyRaw(bool ed, bool ad);
static void doRs485Raw(const JsonDocument& doc);
static void doRs485Listen(const JsonDocument& doc);
static void doRs485SelfTest(const JsonDocument& doc);
static void doRs485CrossTest(const JsonDocument& doc);
static void doRs485LinkTest(const JsonDocument& doc);
static void doRp2350Ctrl(const JsonDocument& doc);
static void doRp2350Spi(const JsonDocument& doc);
static void sendFieldSetToRp2350();
static void pollRp2350FieldStatus();
static void rp2350Recover();
static void doLedSet(const JsonDocument& doc);
static StatusShown statusFor(bool engaged, openfc_state_t field, int edLevel, int adLevel);
static StatusShown currentStatus();
static void showStatus(StatusShown s);
static HardwareSerial* busForPort(char port, int* dePin);
static void spiTransact(const uint8_t out[SPI_LINK_FRAME_LEN],
                        uint8_t in[SPI_LINK_FRAME_LEN]);
static bool spiRequestAndWait(SpiLinkCmd cmd, uint8_t port, uint8_t flags,
                              const uint8_t* payload, uint8_t len,
                              SpiLinkFrame* result, uint32_t timeoutMs);

// ─── Setup ───
void setup() {
    // SAFETY FIRST, same posture as the production firmware: drive the
    // legacy ports to Disabled before anything else, RS-485 to receive.
    pinMode(PIN_LEGACY_ED, OUTPUT);
    pinMode(PIN_LEGACY_AD, OUTPUT);
    digitalWrite(PIN_LEGACY_ED, LEGACY_OPTO_ON);   // Disabled (assumed-safe polarity)
    digitalWrite(PIN_LEGACY_AD, LEGACY_OPTO_OFF);  // Driver

    pinMode(PIN_RS485A_DE, OUTPUT);
    pinMode(PIN_RS485B_DE, OUTPUT);
    digitalWrite(PIN_RS485A_DE, LOW);   // receive
    digitalWrite(PIN_RS485B_DE, LOW);

    pinMode(PIN_RP2350_RUN, OUTPUT);
    pinMode(PIN_RP2350_BOOT_CTRL, OUTPUT);
    digitalWrite(PIN_RP2350_RUN, LOW);        // hold in reset until commanded
    digitalWrite(PIN_RP2350_BOOT_CTRL, HIGH); // assumed-inactive; unverified
    pinMode(PIN_RP2350_IRQ, INPUT);
    pinMode(PIN_ESP_READY, OUTPUT);
    digitalWrite(PIN_ESP_READY, LOW);

    pinMode(PIN_BOOT_BTN, INPUT_PULLUP);
    pinMode(PIN_BTN1, INPUT_PULLUP);
    pinMode(PIN_BTN2, INPUT_PULLUP);

    pixels.begin();
    showStatus(currentStatus());

    BusA.begin(1600000, SERIAL_8N1, PIN_RS485A_RX, PIN_RS485A_TX);
    BusB.begin(1600000, SERIAL_8N1, PIN_RS485B_RX, PIN_RS485B_TX);
    // A 16-byte announce never reaches the default IDF RXFIFO_FULL threshold
    // (120), so without this it is delivered only via the slower idle-timeout
    // path — the exact ~200 µs reply-latency bug OpenFC-Smart diagnosed and
    // fixed on 2026-07-05 (its findings doc, "Reply latency measured from
    // captures"). FULL fires the instant the 16th byte lands; timeout 1 stays
    // as the trailing-byte fallback.
    BusA.setRxFIFOFull(16);
    BusA.setRxTimeout(1);
    BusB.setRxFIFOFull(16);
    BusB.setRxTimeout(1);

    pinMode(PIN_RP2350_CS, OUTPUT);
    digitalWrite(PIN_RP2350_CS, HIGH);
    SPI.begin(PIN_SPI_SCLK, PIN_SPI_MISO, PIN_SPI_MOSI, PIN_RP2350_CS);

    linkA.begin(&BusA, UART_NUM_1, PIN_RS485A_DE, 'A');
    linkB.begin(&BusB, UART_NUM_2, PIN_RS485B_DE, 'B');
#if OPENFC_DEVTOOLS
    devtoolsBegin();
    linkA.capSink = linkB.capSink = devtoolsCapSink;
#endif

    Serial.setTxBufferSize(2048);   // must precede begin(); keeps long events from stalling the engines
    Serial.setRxBufferSize(2048);   // a 550-byte rp2350_flash_data line must fit while the engines run
    Serial.begin(115200);
    Serial.setTimeout(50);
    delay(150);  // UART0 (CH340C): allow the bridge/host to settle

    digitalWrite(PIN_ESP_READY, HIGH);

    // Boot engaged and Disabled, so a controller plugged into an idle board
    // links and shows Disabled without a host. field_engage {on:false} hands
    // the ports back for raw diagnostics or the relay.
    digitalWrite(PIN_RP2350_RUN, HIGH);
    rp2350Run = true;
    delay(300);   // RP2350 boot, before the first SPI exchange
    fieldEngaged = true;
    g_field_state = STATE_DISABLED;
    linkA.reset(millis());
    linkB.reset(millis());
    lastHostPingMs = millis();
    sendFieldSetToRp2350();

    emitHello();
    emitLegacyState();
    emitRp2350State();
    emitFieldState();
}

// ─── Loop ───
void loop() {
    while (Serial.available()) {
        char c = (char)Serial.read();
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
        } else if (inputBuf.length() < 600) {   // b64 flash-data lines run long
            inputBuf += c;
        }
    }

    uint32_t now = millis();

    if (identifying && now >= identifyEndMs) {
        identifying = false;
        ledsShown = StatusShown::Unknown;
    } else if (identifying) {
        uint32_t phase = (now / 200) % 3;
        pixels.clear();
        uint32_t color = phase == 0 ? pixels.Color(255, 0, 0, 0)
                        : phase == 1 ? pixels.Color(0, 255, 0, 0)
                                     : pixels.Color(0, 0, 255, 0);
        for (int i = 0; i < NEOPIXEL_COUNT; i++) pixels.setPixelColor(i, color);
        pixels.show();
    }
    showStatus(currentStatus());
#if OPENFC_DEVTOOLS
    devtoolsService();
#endif

    if (fieldEngaged) {
        // Host watchdog: drop to disabled if pings stop while enabled.
        if (g_field_state != STATE_DISABLED &&
            (now - lastHostPingMs >= FIELD_WATCHDOG_MS)) {
            g_field_state = STATE_DISABLED;
            showStatus(currentStatus());
            sendFieldSetToRp2350();  // C/D must disable too
            JsonDocument d; d["evt"] = "bu_field_watchdog";
            serializeJson(d, Serial); Serial.println();
            emitFieldState();
        }

        linkA.service(now);
        linkB.service(now);

        // Poll C/D status at ~5 Hz — plenty for the UI; the RP2350's own
        // 50 Hz A7 tick runs independently of this link (see main.cpp
        // there), so this cadence doesn't affect the controller session.
        if (!rp2350Flashing && (int32_t)(now - rp2350HoldoffUntilMs) >= 0 &&
            now - lastRp2350PollMs >= (rp2350Reachable ? 200u : 2000u)) {
            lastRp2350PollMs = now;
            pollRp2350FieldStatus();
        }

        // First port whose countdown expires ends the match for all ports.
        // KNOWN GAP: the RP2350 also auto-disables ITS copy of g_field_state
        // locally if C/D's countdown expires first, but does not report
        // that back over FIELD_STATUS — so on a C/D-triggered match end,
        // A/B keeps streaming the old enabled state until the operator (or
        // this watchdog) notices. Fine for today's link/session bring-up;
        // flagging for whoever wires match-end symmetry properly.
        if (linkA.matchEndPending || linkB.matchEndPending) {
            linkA.matchEndPending = linkB.matchEndPending = false;
            if (g_field_state != STATE_DISABLED) {
                g_field_state = STATE_DISABLED;
                showStatus(currentStatus());
                sendFieldSetToRp2350();
                JsonDocument d; d["evt"] = "bu_match_end";
                serializeJson(d, Serial); Serial.println();
                emitFieldState();
            }
        }
        for (SmartLink* l : {&linkA, &linkB}) {
            if (l->swreplugPending) {
                l->swreplugPending = false;
                JsonDocument d;
                d["evt"] = "bu_swreplug";
                d["port"] = String(l->name);
                serializeJson(d, Serial); Serial.println();
            }
        }
    }

    if (now - lastHeartbeatMs >= HEARTBEAT_INTERVAL_MS) {
        lastHeartbeatMs = now;
        emitHeartbeat();
        if (fieldEngaged) emitFieldState();
    }

    if (rp2350Run && !rp2350Flashing && rp2350Fails >= 3 && now - rp2350LastResetMs > rp2350RetryMs) rp2350Recover();
}

// ─── Command dispatch ───
static void handleCommand(const JsonDocument& doc) {
    const char* cmd = doc["cmd"] | "";

    if (strcmp(cmd, "get_info") == 0) {
        emitHello();

    } else if (strcmp(cmd, "ping") == 0) {
        lastHostPingMs = millis();  // feeds the field watchdog while enabled
        JsonDocument ack; ack["evt"] = "ack"; ack["cmd"] = "ping";
        serializeJson(ack, Serial); Serial.println();

    } else if (strcmp(cmd, "field_engage") == 0) {
        bool on = doc["on"] | false;
        uint32_t now = millis();
        fieldEngaged = on;
        g_field_interlock = doc["interlock"] | false;
        g_field_state = STATE_DISABLED;
        showStatus(currentStatus());
        linkA.reset(now);
        linkB.reset(now);
        lastHostPingMs = now;
        sendFieldSetToRp2350();
        emitFieldState();

    } else if (strcmp(cmd, "field_state") == 0) {
        if (!fieldEngaged) { emitError("not_engaged", "field_state"); return; }
        const char* st = doc["state"] | "disabled";
        g_field_state = (strcmp(st, "driver") == 0) ? STATE_DRIVER
                      : (strcmp(st, "auton") == 0)  ? STATE_AUTON
                                                    : STATE_DISABLED;
        showStatus(currentStatus());
        lastHostPingMs = millis();
        sendFieldSetToRp2350();
        emitFieldState();

    } else if (strcmp(cmd, "field_period") == 0) {
        if (doc["driver"].is<int>()) g_driver_period_ms = (uint32_t)(int)doc["driver"];
        if (doc["auton"].is<int>()) g_auton_period_ms = (uint32_t)(int)doc["auton"];
        sendFieldSetToRp2350();
        emitFieldState();

#if OPENFC_DEVTOOLS
    } else if (devtoolsCommand(cmd, doc)) {
        // capture, relay
#endif
    } else if (strcmp(cmd, "legacy_set") == 0) {
        bool enable = doc["enable"] | false;
        const char* mode = doc["mode"] | "driver";
        String modeStr(mode);
        if (modeStr != "driver" && modeStr != "auto") modeStr = "driver";
        doLegacySet(enable, modeStr);
        JsonDocument ack; ack["evt"] = "ack"; ack["cmd"] = "legacy_set";
        serializeJson(ack, Serial); Serial.println();
        emitLegacyState();

    } else if (strcmp(cmd, "legacy_raw") == 0) {
        bool ed = doc["ed"] | false;
        bool ad = doc["ad"] | false;
        doLegacyRaw(ed, ad);
        JsonDocument ack; ack["evt"] = "ack"; ack["cmd"] = "legacy_raw";
        serializeJson(ack, Serial); Serial.println();
        emitLegacyState();

    } else if (strcmp(cmd, "rs485_raw") == 0 ||
               strcmp(cmd, "rs485_listen") == 0 ||
               strcmp(cmd, "rs485_selftest") == 0 ||
               strcmp(cmd, "rs485_crosstest") == 0 ||
               strcmp(cmd, "rs485_linktest") == 0) {
        // The field engines own the buses while engaged; a diagnostic
        // transmitting or draining RX mid-session would corrupt the link.
        if (fieldEngaged) { emitError("field_engaged", cmd); return; }
        if (strcmp(cmd, "rs485_raw") == 0) doRs485Raw(doc);
        else if (strcmp(cmd, "rs485_listen") == 0) doRs485Listen(doc);
        else if (strcmp(cmd, "rs485_selftest") == 0) doRs485SelfTest(doc);
        else if (strcmp(cmd, "rs485_crosstest") == 0) doRs485CrossTest(doc);
        else doRs485LinkTest(doc);

    } else if (strcmp(cmd, "rp2350_ctrl") == 0) {
        doRp2350Ctrl(doc);

    } else if (strcmp(cmd, "rp2350_swd_probe") == 0) {
        SwdProbeInfo info;
        swdProbe(&info);
        JsonDocument out;
        out["evt"] = "bu_swd_probe";
        out["ok"] = info.ok;
        char hex[12];
        snprintf(hex, sizeof(hex), "%08X", (unsigned)info.dpidr);
        out["dpidr"] = hex;
        snprintf(hex, sizeof(hex), "%08X", (unsigned)info.bootromMagic);
        out["bootrom_magic"] = hex;
        out["pins_swapped"] = info.pinsSwapped;
        if (!info.ok) out["fail"] = info.fail;
        serializeJson(out, Serial); Serial.println();

    } else if (strcmp(cmd, "rp2350_mem_read") == 0) {
        // addr as a hex STRING, not a JSON number: many addresses here
        // (e.g. SIO at 0xd0000000+) exceed INT32_MAX, and ArduinoJson's
        // `doc["addr"] | 0` deduces int from the default and silently
        // returns 0 for a value that doesn't fit — found live on the bench
        // when every "SIO" read came back as address 0.
        const char* addrHex = doc["addr"] | "0";
        uint32_t addr = (uint32_t)strtoul(addrHex, nullptr, 16);
        uint32_t val = 0;
        bool ok = swdMemPeek(addr, &val);
        JsonDocument out;
        out["evt"] = "bu_mem_read";
        out["ok"] = ok;
        char hex[12];
        snprintf(hex, sizeof(hex), "%08X", (unsigned)addr);
        out["addr"] = hex;
        snprintf(hex, sizeof(hex), "%08X", (unsigned)val);
        out["val"] = hex;
        serializeJson(out, Serial); Serial.println();

    } else if (strcmp(cmd, "rp2350_swd_diag") == 0) {
        char buf[400];
        swdDiag(buf, sizeof(buf));
        JsonDocument out;
        out["evt"] = "bu_swd_diag";
        out["r"] = buf;
        serializeJson(out, Serial); Serial.println();

    } else if (strcmp(cmd, "rp2350_flash_begin") == 0) {
        uint32_t size = (uint32_t)(doc["size"] | 0);
        const char* fail = "";
        rp2350Flashing = true;
        bool ok = size > 0 && swdFlashBegin(size, &fail);
        if (!ok) rp2350Flashing = false;
        JsonDocument out;
        out["evt"] = "bu_flash_status";
        out["stage"] = "begin";
        out["ok"] = ok;
        if (!ok) out["fail"] = size > 0 ? fail : "no_size";
        serializeJson(out, Serial); Serial.println();

    } else if (strcmp(cmd, "rp2350_flash_data") == 0) {
        const char* b64 = doc["b64"] | "";
        uint8_t bin[384];
        size_t n = b64Decode(b64, bin, sizeof(bin));
        const char* fail = "";
        bool ok = n > 0 && swdFlashData(bin, n, &fail);
        if (!ok) rp2350Flashing = false;
        JsonDocument out;
        out["evt"] = "bu_flash_status";
        out["stage"] = "data";
        out["ok"] = ok;
        out["received"] = (int)swdFlashCount();
        if (!ok) out["fail"] = n > 0 ? fail : "bad_b64";
        serializeJson(out, Serial); Serial.println();

    } else if (strcmp(cmd, "rp2350_flash_end") == 0) {
        const char* fail = "";
        bool ok = swdFlashEnd(&fail);
        rp2350Run = true;   // swdFlashEnd released RUN to boot the new image
        rp2350Flashing = false;
        rp2350Fails = 0;
        if (ok && fieldEngaged) {
            delay(300);
            sendFieldSetToRp2350();
        }
        JsonDocument out;
        out["evt"] = "bu_flash_status";
        out["stage"] = "end";
        out["ok"] = ok;
        out["received"] = (int)swdFlashCount();
        if (!ok) out["fail"] = fail;
        serializeJson(out, Serial); Serial.println();

    } else if (strcmp(cmd, "rp2350_spi") == 0) {
        doRp2350Spi(doc);

    } else if (strcmp(cmd, "led_set") == 0) {
        doLedSet(doc);

    } else if (strcmp(cmd, "identify") == 0) {
        identifying = true;
        identifyEndMs = millis() + IDENTIFY_DURATION_MS;
        JsonDocument ack; ack["evt"] = "ack"; ack["cmd"] = "identify";
        serializeJson(ack, Serial); Serial.println();

    } else {
        emitError("unknown_command", cmd[0] ? cmd : nullptr);
    }
}

// ─── Legacy ports ───
static void doLegacySet(bool enable, const String& mode) {
    bool autoMode = (mode == "auto");
    int ad = (enable && autoMode) ? LEGACY_OPTO_ON : LEGACY_OPTO_OFF;
    int ed = enable ? LEGACY_OPTO_OFF : LEGACY_OPTO_ON;
    showStatus(statusFor(fieldEngaged, g_field_state, ed, ad));
    digitalWrite(PIN_LEGACY_AD, ad);
    digitalWrite(PIN_LEGACY_ED, ed);
    legacyEnable = enable;
    legacyMode = mode;
    legacyDiag = false;
}

static void doLegacyRaw(bool ed, bool ad) {
    showStatus(statusFor(fieldEngaged, g_field_state, ed ? HIGH : LOW, ad ? HIGH : LOW));
    digitalWrite(PIN_LEGACY_ED, ed ? HIGH : LOW);
    digitalWrite(PIN_LEGACY_AD, ad ? HIGH : LOW);
    legacyDiag = true;
}

// ─── RS-485 A/B raw + link test ───
static HardwareSerial* busForPort(char port, int* dePin) {
    if (port == 'A') { *dePin = PIN_RS485A_DE; return &BusA; }
    if (port == 'B') { *dePin = PIN_RS485B_DE; return &BusB; }
    return nullptr;
}

static void doRs485Raw(const JsonDocument& doc) {
    const char* portStr = doc["port"] | "";
    char port = portStr[0];
    int dePin = -1;
    HardwareSerial* bus = busForPort(port, &dePin);
    if (!bus) { emitError("invalid_port", "rs485_raw"); return; }

    JsonArrayConst bytes = doc["bytes"].as<JsonArrayConst>();
    uint8_t buf[64];
    size_t n = 0;
    for (JsonVariantConst v : bytes) {
        if (n >= sizeof(buf)) break;
        buf[n++] = (uint8_t)(v.as<int>() & 0xFF);
    }

    if (n > 0) {
        digitalWrite(dePin, HIGH);  // drive
        bus->write(buf, n);
        bus->flush();
        delayMicroseconds(50);
    }
    digitalWrite(dePin, LOW);  // receive

    uint8_t rx[128];
    size_t rxn = 0;
    uint32_t deadline = millis() + RS485_RX_WINDOW_MS;
    while (millis() < deadline && rxn < sizeof(rx)) {
        while (bus->available() && rxn < sizeof(rx)) rx[rxn++] = (uint8_t)bus->read();
    }

    JsonDocument out;
    out["evt"] = "bu_rs485_rx";
    out["port"] = portStr;
    JsonArray arr = out["bytes"].to<JsonArray>();
    for (size_t i = 0; i < rxn; i++) arr.add(rx[i]);
    serializeJson(out, Serial); Serial.println();
}

// Pure passive capture, no TX at all — DE stays low (receive) the whole
// time. Added because rs485_raw's 50ms window is an echo test (send, then
// briefly listen for a reply); it's too short to catch a peer's own
// periodic, asynchronous chatter (e.g. a V5 controller announcing at
// ~1-2 Hz). This is the first thing to try when a port "does nothing" —
// it answers "is anything arriving on this wire at all" independently of
// whether this firmware's reply content is correct.
static void doRs485Listen(const JsonDocument& doc) {
    const char* portStr = doc["port"] | "";
    char port = portStr[0];
    int dePin = -1;
    HardwareSerial* bus = busForPort(port, &dePin);
    if (!bus) { emitError("invalid_port", "rs485_listen"); return; }

    uint32_t ms = doc["ms"] | 2000;
    if (ms > 10000) ms = 10000;

    digitalWrite(dePin, LOW);  // receive, unconditionally
    while (bus->available()) bus->read();  // drop anything stale first

    uint8_t rx[256];
    size_t rxn = 0;
    uint32_t deadline = millis() + ms;
    while (millis() < deadline && rxn < sizeof(rx)) {
        while (bus->available() && rxn < sizeof(rx)) rx[rxn++] = (uint8_t)bus->read();
    }

    JsonDocument out;
    out["evt"] = "bu_rs485_rx";
    out["port"] = portStr;
    JsonArray arr = out["bytes"].to<JsonArray>();
    for (size_t i = 0; i < rxn; i++) arr.add(rx[i]);
    serializeJson(out, Serial); Serial.println();
}

// Self-echo test — needs NO controller or other peer on the bus at all.
// Half-duplex RS-485 transceivers with RE tied to GND (independent of DE)
// echo the driver's own transmitted bytes back on the receiver the whole
// time; ones with RE tied to DE (this board's presumed wiring, see
// openfc_pins_v13.h) only echo once DE drops back to receive. Either way,
// seeing our own bytes come back on RX proves: the UART TX path, the
// transceiver, the A/B bus pair, and the UART RX path are all electrically
// connected and working, independent of any controller, any protocol
// content, and any assumption about which RE/DE wiring this board actually
// uses. Seeing NOTHING in either phase points at a wiring/pin-mapping/
// assembly problem on this board rather than a timing or protocol issue.
// Reads whatever has arrived within `ms`, appending to *n (capped at cap).
static void drainFor(HardwareSerial* bus, uint32_t ms, uint8_t* buf, size_t* n, size_t cap) {
    uint32_t deadline = millis() + ms;
    while (millis() < deadline && *n < cap) {
        while (bus->available() && *n < cap) buf[(*n)++] = (uint8_t)bus->read();
    }
}

// BusA/BusB are HardwareSerial(1)/HardwareSerial(2); their underlying IDF
// uart_port_t numbers are fixed by that constructor argument.
static uart_port_t uartNumForPort(char port) {
    return port == 'A' ? UART_NUM_1 : UART_NUM_2;
}

static void doRs485SelfTest(const JsonDocument& doc) {
    const char* portStr = doc["port"] | "";
    char port = portStr[0];
    int dePin = -1;
    HardwareSerial* bus = busForPort(port, &dePin);
    if (!bus) { emitError("invalid_port", "rs485_selftest"); return; }

    static const uint8_t PATTERN[] = {0xAA, 0x55, 0x01, 0x02, 0x03, 0xFE};

    // Phase 0: internal UART loopback (IDF uart_set_loop_back), which
    // connects this UART's TX to its own RX INSIDE the peripheral, before
    // the signal ever reaches a GPIO pin. If this phase is empty too, the
    // fault is in our own UART setup (wrong uart_num, begin() never took),
    // not in the GPIO pins, wiring, or transceiver — worth knowing before
    // chasing hardware. DE is left alone here; it plays no part in this path.
    uart_port_t uartNum = uartNumForPort(port);
    while (bus->available()) bus->read();
    uart_set_loop_back(uartNum, true);
    bus->write(PATTERN, sizeof(PATTERN));
    bus->flush();
    uint8_t loop[64];
    size_t nLoop = 0;
    drainFor(bus, 20, loop, &nLoop, sizeof(loop));
    uart_set_loop_back(uartNum, false);
    while (bus->available()) bus->read();  // drop any loopback residue

    // Tries BOTH DE polarities for "transmit", not just the HIGH=transmit
    // assumption elsewhere in this firmware: if that assumption is itself
    // backwards, a test that only ever drives DE high while writing would
    // see silence forever and never find out why. Four buckets fully cover
    // {DE active-high, DE active-low} x {RE tied to DE, RE tied to a fixed
    // rail} without betting on which combination this board actually is.
    uint8_t hiTx[64], hiThenLo[64], loTx[64], loThenHi[64];
    size_t nHiTx = 0, nHiThenLo = 0, nLoTx = 0, nLoThenHi = 0;

    digitalWrite(dePin, HIGH);
    bus->write(PATTERN, sizeof(PATTERN));
    bus->flush();
    drainFor(bus, 20, hiTx, &nHiTx, sizeof(hiTx));
    digitalWrite(dePin, LOW);
    drainFor(bus, 20, hiThenLo, &nHiThenLo, sizeof(hiThenLo));

    delay(5);
    while (bus->available()) bus->read();

    digitalWrite(dePin, LOW);
    bus->write(PATTERN, sizeof(PATTERN));
    bus->flush();
    drainFor(bus, 20, loTx, &nLoTx, sizeof(loTx));
    digitalWrite(dePin, HIGH);
    drainFor(bus, 20, loThenHi, &nLoThenHi, sizeof(loThenHi));
    digitalWrite(dePin, LOW);  // leave receiving, the normal idle state

    auto addArr = [](JsonDocument& d, const char* key, const uint8_t* buf, size_t n) {
        JsonArray a = d[key].to<JsonArray>();
        for (size_t i = 0; i < n; i++) a.add(buf[i]);
    };
    JsonDocument out;
    out["evt"] = "bu_selftest_result";
    out["port"] = portStr;
    addArr(out, "sent", PATTERN, sizeof(PATTERN));
    addArr(out, "echo_internal_loopback", loop, nLoop);
    addArr(out, "echo_while_de_high", hiTx, nHiTx);
    addArr(out, "echo_after_de_low", hiThenLo, nHiThenLo);
    addArr(out, "echo_while_de_low", loTx, nLoTx);
    addArr(out, "echo_after_de_high", loThenHi, nLoThenHi);
    out["ok"] = (nLoop + nHiTx + nHiThenLo + nLoTx + nLoThenHi) > 0;
    serializeJson(out, Serial); Serial.println();
}

// Cross-port test: transmit a known pattern on one port, capture on the
// other. With a single smart cable looped between ports A and B (nothing
// else attached), this proves the sender's full TX chain AND the
// receiver's full RX chain end to end, out the physical jack and back in —
// the one thing self-test cannot prove on this board, because its RE-gated
// transceivers never echo their own TX. Run both directions to cover all
// four paths.
static void doRs485CrossTest(const JsonDocument& doc) {
    const char* fromStr = doc["from"] | "";
    const char* toStr = doc["to"] | "";
    int fromDe = -1, toDe = -1;
    HardwareSerial* fromBus = busForPort(fromStr[0], &fromDe);
    HardwareSerial* toBus = busForPort(toStr[0], &toDe);
    if (!fromBus || !toBus || fromBus == toBus) {
        emitError("invalid_port", "rs485_crosstest");
        return;
    }

    while (fromBus->available()) fromBus->read();
    while (toBus->available()) toBus->read();

    static const uint8_t PATTERN[] = {0xAA, 0x55, 0x01, 0x02, 0x03, 0xFE};
    digitalWrite(toDe, LOW);        // receiver side listening
    digitalWrite(fromDe, HIGH);     // sender side driving
    fromBus->write(PATTERN, sizeof(PATTERN));
    fromBus->flush();
    delayMicroseconds(50);
    digitalWrite(fromDe, LOW);

    uint8_t rx[64];
    size_t n = 0;
    drainFor(toBus, 30, rx, &n, sizeof(rx));

    JsonDocument out;
    out["evt"] = "bu_crosstest_result";
    out["from"] = fromStr;
    out["to"] = toStr;
    JsonArray sent = out["sent"].to<JsonArray>();
    for (uint8_t b : PATTERN) sent.add(b);
    JsonArray got = out["received"].to<JsonArray>();
    for (size_t i = 0; i < n; i++) got.add(rx[i]);
    out["ok"] = (n == sizeof(PATTERN)) && memcmp(rx, PATTERN, sizeof(PATTERN)) == 0;
    serializeJson(out, Serial); Serial.println();
}

// rs485_linktest runs the competition-switch controller<->field-control
// handshake OpenFC-Smart reverse engineered (openfc_frames.h) — confirmed
// (2026-09-01 bench session) to be the correct protocol for this port and
// these exact controllers (30 E9 4B on A, 8E C7 81 on B — both appear
// throughout OpenFC-Smart's findings doc).
//
// PERSISTENT engine, not a one-shot: everything OpenFC-Smart learned says a
// single answered announce proves nothing —
//   - the real brain itself ignored 7 consecutive cold announces and won on
//     the 9th ("brainController3_digital.csv", 2026-07-05);
//   - the cold window only exists for 1-2 announces right after controller
//     power-on, then the controller flips to a warm state that can go
//     SILENT until re-primed or truly power-cycled (2026-07-06 notes);
//   - answering into the controller's boot-time cold-announce FLOOD (dozens
//     back-to-back in ~90 ms) earns silence; the win condition is answering
//     an ISOLATED cold announce (the cold-isolation gate);
//   - one reply pair per announce, enforced by a post-reply refractory,
//     or the TX echo/turnaround can retrigger reply storms (esp14).
// So this runs for `ms` (default 10 s, max 30 s), answers every eligible
// announce with those gates applied, and reports statistics. To test a cold
// handshake, START THIS FIRST, then power-cycle the controller while it
// runs. Blocks the main loop for the duration (heartbeats pause) — fine for
// a diagnostic.
static void doRs485LinkTest(const JsonDocument& doc) {
    const char* portStr = doc["port"] | "";
    char port = portStr[0];
    int dePin = -1;
    HardwareSerial* bus = busForPort(port, &dePin);
    if (!bus) { emitError("invalid_port", "rs485_linktest"); return; }

    uint32_t duration = doc["ms"] | 10000;
    if (duration > 30000) duration = 30000;

    while (bus->available()) bus->read();  // drain stale bytes

    uint8_t win[LINK16_SIZE];             // rolling 16-byte announce window
    size_t wn = 0;
    uint32_t deadline = millis() + duration;
    uint32_t lastAnnounceUs = 0;
    uint32_t lastReplyUs = 0;
    uint32_t announces = 0, colds = 0, warms = 0, replies = 0, skippedFlood = 0;
    uint32_t acksLink = 0, acksSession = 0;
    uint8_t firstAck[LINK16_SIZE];
    bool haveAck = false, gotSession = false, lastAnsweredCold = false;

    while (millis() < deadline) {
        if (!bus->available()) continue;
        uint8_t b = (uint8_t)bus->read();
        if (wn == LINK16_SIZE) {
            memmove(win, win + 1, LINK16_SIZE - 1);
            win[LINK16_SIZE - 1] = b;
        } else {
            win[wn++] = b;
        }
        if (wn < LINK16_SIZE) continue;
        if (win[0] != LINKPOLL_FIRST || win[1] != 0x4B) continue;
        uint16_t c = crc16_ccitt_false(win, LINK16_CRC_COV);
        if (win[14] != ((c >> 8) & 0xFF) || win[15] != (c & 0xFF)) continue;

        // Valid 0A 4B announce. byte13: 0x00 = COLD (fresh power-on, the
        // only state that can grant the full cold handshake), 0x20+ = WARM.
        uint32_t nowUs = micros();
        uint32_t gapUs = lastAnnounceUs ? (nowUs - lastAnnounceUs) : 0xFFFFFFFFu;
        lastAnnounceUs = nowUs;
        announces++;
        bool cold = (win[13] == 0x00);
        if (cold) colds++; else warms++;
        wn = 0;

        // Cold-isolation gate: skip the boot flood, answer the isolated one.
        if (cold && gapUs < 120000) { skippedFlood++; continue; }
        // Post-reply refractory: exactly one reply pair per isolated announce.
        if (lastReplyUs && (nowUs - lastReplyUs) < 250000) continue;

        uint8_t reply2[LINK16_SIZE];
        build_link_reply2(win, reply2);
        const uint8_t* reply1 = cold ? LINK_REPLY1_COLD : LINK_REPLY1;
        lastAnsweredCold = cold;

        // HELD DE across both frames (OpenFC-Smart's final verdict: TOGGLE
        // releases the driver in the gap and the bus differential collapses
        // before reply2's start bit; measured and fixed 2026-07-05). Golden
        // capture shows ~103-131 us of line idle between the two replies.
        digitalWrite(dePin, HIGH);
        bus->write(reply1, LINK16_SIZE);
        bus->flush();
        delayMicroseconds(103);
        bus->write(reply2, LINK16_SIZE);
        bus->flush();
        delayMicroseconds(20);
        digitalWrite(dePin, LOW);
        replies++;
        lastReplyUs = micros();

        // The 02 13 ack lands ~50-370 us after reply2. Capture a 5 ms window
        // and scan for a CRC-valid ack anywhere in it. On this board the
        // transceiver's RE is gated by DE (self-test proved no TX echo), so
        // unlike OpenFC-Smart's rig there is no own-echo to skip past —
        // anything here was driven by the controller.
        uint8_t ab[48];
        size_t an = 0;
        uint32_t t0 = micros();
        while ((micros() - t0) < 5000 && an < sizeof(ab)) {
            if (bus->available()) ab[an++] = (uint8_t)bus->read();
        }
        for (size_t k = 0; k + LINK16_SIZE <= an; k++) {
            if (ab[k] != 0x02 || ab[k + 1] != 0x13) continue;
            uint16_t cc = crc16_ccitt_false(ab + k, LINK16_CRC_COV);
            if (ab[k + 14] != ((cc >> 8) & 0xFF) || ab[k + 15] != (cc & 0xFF)) continue;
            if (!haveAck) { memcpy(firstAck, ab + k, LINK16_SIZE); haveAck = true; }
            if (ab[k + 2] == 0x01) { acksSession++; gotSession = true; }  // F3 78
            else acksLink++;                                              // 86 B9
            break;
        }
        if (gotSession) break;  // full session grant — nothing left to prove
    }

    JsonDocument out;
    out["evt"] = "bu_linktest_result";
    out["port"] = portStr;
    out["ok"] = haveAck;
    out["stage"] = haveAck ? "ack"
                 : replies > 0 ? "no_ack"
                 : announces > 0 ? "no_eligible"
                                 : "no_poll";
    out["announces"] = (int)announces;
    out["cold_announces"] = (int)colds;
    out["warm_announces"] = (int)warms;
    out["replies_sent"] = (int)replies;
    out["skipped_flood"] = (int)skippedFlood;
    out["acks_link"] = (int)acksLink;
    out["acks_session"] = (int)acksSession;
    out["cold"] = lastAnsweredCold;
    if (haveAck) {
        JsonArray arr = out["ack_bytes"].to<JsonArray>();
        for (int i = 0; i < LINK16_SIZE; i++) arr.add(firstAck[i]);
        out["session"] = gotSession;
    }
    serializeJson(out, Serial); Serial.println();
}

// ─── RP2350 link ───
static void doRp2350Ctrl(const JsonDocument& doc) {
    if (doc["run"].is<bool>()) {
        rp2350Run = doc["run"].as<bool>();
        digitalWrite(PIN_RP2350_RUN, rp2350Run ? HIGH : LOW);
    }
    if (doc["boot_ctrl"].is<bool>()) {
        rp2350BootCtrl = doc["boot_ctrl"].as<bool>();
        digitalWrite(PIN_RP2350_BOOT_CTRL, rp2350BootCtrl ? HIGH : LOW);
    }
    JsonDocument ack; ack["evt"] = "ack"; ack["cmd"] = "rp2350_ctrl";
    serializeJson(ack, Serial); Serial.println();
    emitRp2350State();
}

static void spiTransact(const uint8_t out[SPI_LINK_FRAME_LEN],
                        uint8_t in[SPI_LINK_FRAME_LEN]) {
    // Mode 1 (CPHA=1): required for the RP2350 PL022 slave when CS is held
    // low across the whole frame. Must match spiPeriphInit() on the RP2350.
    SPI.beginTransaction(SPISettings(SPI_LINK_HZ, MSBFIRST, SPI_MODE1));
    digitalWrite(PIN_RP2350_CS, LOW);
    for (size_t i = 0; i < SPI_LINK_FRAME_LEN; i++) {
        in[i] = SPI.transfer(out[i]);
    }
    digitalWrite(PIN_RP2350_CS, HIGH);
    SPI.endTransaction();
}

// Sends a request frame, then polls GET_RESULT until the slave reports a
// terminal status or timeoutMs elapses. See openfc_spi_link.h for the
// two-transaction-shape rationale (the RP2350 is a slave; it cannot push).
static bool spiRequestAndWait(SpiLinkCmd cmd, uint8_t port, uint8_t flags,
                              const uint8_t* payload, uint8_t len,
                              SpiLinkFrame* result, uint32_t timeoutMs) {
    SpiLinkFrame req = {};
    req.b0 = cmd;
    req.port = port;
    req.flags = flags;
    req.len = len;
    if (payload && len) memcpy(req.payload, payload, len);
    uint8_t reqBuf[SPI_LINK_FRAME_LEN];
    uint8_t rxBuf[SPI_LINK_FRAME_LEN];
    spi_link_pack(req, reqBuf);
    delay(1);   // let the slave finish the previous transaction and preload
    spiTransact(reqBuf, rxBuf);  // fire the request; MISO here is stale/ignored

    SpiLinkFrame poll = {};
    poll.b0 = SPI_CMD_GET_RESULT;
    uint8_t pollBuf[SPI_LINK_FRAME_LEN];
    spi_link_pack(poll, pollBuf);

    uint32_t deadline = millis() + timeoutMs;
    while (millis() < deadline) {
        delay(5);
        spiTransact(pollBuf, rxBuf);
        if (!spi_link_unpack(rxBuf, result)) continue;  // checksum garbage, retry
        if (result->b0 != SPI_STATUS_PENDING) { rp2350Fails = 0; return true; }
    }
    if (rp2350Fails < 255) rp2350Fails++;
    return false;
}

// Pulse RUN and re-send the field state. Clears the RP2350's capture ring
// and its C/D capture mask, so the C/D capture is over after a reset.
static void rp2350Recover() {
    // Never block here: the A/B engines share this loop.
    digitalWrite(PIN_RP2350_RUN, LOW);
    delayMicroseconds(500);
    digitalWrite(PIN_RP2350_RUN, HIGH);
    rp2350Fails = 0;
    rp2350Resets++;
    rp2350LastResetMs = millis();
    rp2350HoldoffUntilMs = rp2350LastResetMs + 300;
    rp2350NeedFieldSet = true;
    rp2350RetryMs = rp2350RetryMs >= 30000 ? 60000 : rp2350RetryMs * 2;
#if OPENFC_DEVTOOLS
    devtoolsOnRp2350Reset();
#endif
    JsonDocument d;
    d["evt"] = "bu_rp2350_reset";
    d["count"] = rp2350Resets;
    serializeJson(d, Serial); Serial.println();
}

// Push the current field command to the RP2350. Payload layout must match
// SPI_CMD_FIELD_SET's documented format in openfc_spi_link.h exactly.
static void sendFieldSetToRp2350() {
    if (rp2350Flashing) return;
    uint8_t payload[11];
    payload[0] = fieldEngaged ? 1 : 0;
    payload[1] = (g_field_state == STATE_DRIVER) ? 1 : (g_field_state == STATE_AUTON) ? 2 : 0;
    memcpy(payload + 2, &g_driver_period_ms, 4);
    memcpy(payload + 6, &g_auton_period_ms, 4);
    payload[10] = g_field_interlock ? 1 : 0;
    SpiLinkFrame result;
    // Answered on the first poll (~6 ms); a short timeout keeps an absent
    // RP2350 from stalling the A/B engines.
    rp2350Reachable = spiRequestAndWait(SPI_CMD_FIELD_SET, 0, 0, payload, sizeof(payload),
                                        &result, 30) && result.b0 == SPI_STATUS_OK;
}

// Pull C/D status. Payload layout must match SPI_CMD_FIELD_STATUS's
// documented format in openfc_spi_link.h exactly.
static void pollRp2350FieldStatus() {
    SpiLinkFrame result;
    bool ok = spiRequestAndWait(SPI_CMD_FIELD_STATUS, 0, 0, nullptr, 0, &result, 30) &&
              result.b0 == SPI_STATUS_OK && result.len >= 14;
    rp2350Reachable = ok;
    if (!ok) return;
    rp2350RetryMs = 5000;
    if (rp2350NeedFieldSet) {
        rp2350NeedFieldSet = false;
        sendFieldSetToRp2350();
    }
    const uint8_t* p = result.payload;
    const size_t stride = result.len >= 26 ? 12 : 6;   // 6: RP2350 firmware without names
    Rp2350PortStatus* ports[2] = {&portC, &portD};
    for (int i = 0; i < 2; i++) {
        const uint8_t* pp = p + 2 + i * stride;
        ports[i]->linkUp = pp[0] != 0;
        ports[i]->streamKind = pp[1];
        ports[i]->pollAckCount = (uint16_t)pp[2] | ((uint16_t)pp[3] << 8);
        ports[i]->linkAckCount = pp[4];
        ports[i]->swreplugCount = pp[5];
        if (stride == 12) {
            memcpy(ports[i]->robotName, pp + 6, 6);
            ports[i]->robotName[6] = 0;
        }
        ports[i]->haveStatus = true;
    }
}

static void doRp2350Spi(const JsonDocument& doc) {
    const char* op = doc["op"] | "";
    const char* portStr = doc["port"] | "";
    uint8_t port = portStr[0] ? (uint8_t)portStr[0] : 0;
    bool de = doc["de"] | false;

    uint8_t payload[SPI_LINK_MAX_PAYLOAD];
    uint8_t len = 0;
    JsonArrayConst bytes = doc["bytes"].as<JsonArrayConst>();
    for (JsonVariantConst v : bytes) {
        if (len >= SPI_LINK_MAX_PAYLOAD) break;
        payload[len++] = (uint8_t)(v.as<int>() & 0xFF);
    }

    SpiLinkFrame result = {};
    bool got = false;

    if (strcmp(op, "ping") == 0) {
        got = spiRequestAndWait(SPI_CMD_PING, 0, 0, nullptr, 0, &result, 500);
        JsonDocument out;
        out["evt"] = "bu_spi_result";
        out["op"] = "ping";
        out["ok"] = got && result.b0 == SPI_STATUS_OK;
        serializeJson(out, Serial); Serial.println();
        return;
    }

    if (strcmp(op, "rs485_raw") == 0) {
        got = spiRequestAndWait(SPI_CMD_RS485_RAW, port, de ? 1 : 0, payload, len,
                                &result, 300);
        JsonDocument out;
        out["evt"] = "bu_rs485_rx";
        out["port"] = portStr;
        out["ok"] = got && result.b0 == SPI_STATUS_OK;
        // RS485_RAW result flags = total bytes the RP2350 has seen on that
        // port since boot (mod 256) — distinguishes "quiet bus" from "dead".
        if (got) out["seen"] = result.flags;
        JsonArray arr = out["bytes"].to<JsonArray>();
        if (got && result.b0 == SPI_STATUS_OK) {
            for (uint8_t i = 0; i < result.len; i++) arr.add(result.payload[i]);
        }
        serializeJson(out, Serial); Serial.println();
        return;
    }

    if (strcmp(op, "linktest") == 0) {
        got = spiRequestAndWait(SPI_CMD_LINKTEST, port, 0, nullptr, 0, &result, 4000);
        JsonDocument out;
        out["evt"] = "bu_linktest_result";
        out["port"] = portStr;
        out["ok"] = got && result.b0 == SPI_STATUS_OK;
        if (got && result.len > 0) {
            JsonArray arr = out["ack_bytes"].to<JsonArray>();
            for (uint8_t i = 0; i < result.len; i++) arr.add(result.payload[i]);
        }
        serializeJson(out, Serial); Serial.println();
        return;
    }

    emitError("invalid_op", "rp2350_spi");
}

// ─── NeoPixel ───
// Status LEDs: 0 red = Disabled, 1 amber = Autonomous, 2 green = Driver.
static const uint8_t LED_DISABLED_RGB[3] = {96, 0, 0};
static const uint8_t LED_AUTON_RGB[3]    = {96, 40, 0};
static const uint8_t LED_DRIVER_RGB[3]   = {0, 96, 0};

static StatusShown statusFor(bool engaged, openfc_state_t field, int edLevel, int adLevel) {
    if (engaged && field == STATE_DRIVER) return StatusShown::Driver;
    if (engaged && field == STATE_AUTON) return StatusShown::Auton;
    if (edLevel == LEGACY_OPTO_ON) return StatusShown::Disabled;
    return adLevel == LEGACY_OPTO_ON ? StatusShown::Auton : StatusShown::Driver;
}

static StatusShown currentStatus() {
    return statusFor(fieldEngaged, g_field_state,
                     digitalRead(PIN_LEGACY_ED), digitalRead(PIN_LEGACY_AD));
}

static void showStatus(StatusShown s) {
    if (identifying || s == ledsShown) return;
    ledsShown = s;
    auto color = [](const uint8_t* rgb) { return pixels.Color(rgb[0], rgb[1], rgb[2], 0); };
    pixels.clear();
    if (s == StatusShown::Disabled) pixels.setPixelColor(0, color(LED_DISABLED_RGB));
    if (s == StatusShown::Auton)    pixels.setPixelColor(1, color(LED_AUTON_RGB));
    if (s == StatusShown::Driver)   pixels.setPixelColor(2, color(LED_DRIVER_RGB));
    pixels.show();
}

static void doLedSet(const JsonDocument& doc) {
    int index = doc["index"] | -1;
    if (index < 0 || index >= NEOPIXEL_COUNT) { emitError("invalid_index", "led_set"); return; }
    uint8_t r = doc["r"] | 0;
    uint8_t g = doc["g"] | 0;
    uint8_t b = doc["b"] | 0;
    identifying = false;
    pixels.setPixelColor(index, pixels.Color(r, g, b, 0));
    pixels.show();
    JsonDocument ack; ack["evt"] = "ack"; ack["cmd"] = "led_set";
    serializeJson(ack, Serial); Serial.println();
}

// ─── Event emitters ───
static void emitHello() {
    JsonDocument doc;
    doc["evt"] = "bu_hello";
    doc["fw_version"] = OPENFC_FW_VERSION;
    doc["hw_version"] = OPENFC_HW_VERSION;
    doc["device_id"] = getDeviceId();
    doc["leds"] = "field";
    doc["devtools"] = (bool)OPENFC_DEVTOOLS;
    serializeJson(doc, Serial); Serial.println();
}

static void emitLegacyState() {
    JsonDocument doc;
    doc["evt"] = "bu_legacy_state";
    doc["enable"] = legacyEnable;
    doc["mode"] = legacyMode;
    doc["diag"] = legacyDiag;
    doc["ed_pin_level"] = digitalRead(PIN_LEGACY_ED) == HIGH;
    doc["ad_pin_level"] = digitalRead(PIN_LEGACY_AD) == HIGH;
    serializeJson(doc, Serial); Serial.println();
}

static void emitRp2350State() {
    JsonDocument doc;
    doc["evt"] = "bu_rp2350_state";
    doc["run"] = rp2350Run;
    doc["boot_ctrl"] = rp2350BootCtrl;
    doc["irq"] = digitalRead(PIN_RP2350_IRQ) == HIGH;
    serializeJson(doc, Serial); Serial.println();
}

static void emitHeartbeat() {
    JsonDocument doc;
    doc["evt"] = "bu_state";
    doc["uptime_ms"] = millis();
    doc["boot_btn"] = digitalRead(PIN_BOOT_BTN) == LOW;
    doc["btn1"] = digitalRead(PIN_BTN1) == LOW;
    doc["btn2"] = digitalRead(PIN_BTN2) == LOW;
    doc["rp2350_irq"] = digitalRead(PIN_RP2350_IRQ) == HIGH;
    doc["rp2350"] = rp2350Reachable;
    doc["rp2350_resets"] = rp2350Resets;
    serializeJson(doc, Serial); Serial.println();
}

static void emitFieldState() {
    uint32_t now = millis();
    JsonDocument doc;
    doc["evt"] = "bu_field";
    doc["engaged"] = fieldEngaged;
    doc["state"] = fieldStateName(g_field_state);
    doc["driver_ms"] = (int)g_driver_period_ms;
    doc["auton_ms"] = (int)g_auton_period_ms;
    doc["interlock"] = g_field_interlock;
    JsonArray ports = doc["ports"].to<JsonArray>();
    for (SmartLink* l : {&linkA, &linkB}) {
        JsonObject p = ports.add<JsonObject>();
        p["port"] = String(l->name);
        p["link"] = l->linkUp;
        p["ctrl"] = l->ctrlPresent(now);
        // fm: 2 = A7 field mode (states display), 1 = A0 joystick-only,
        // 0 = no stream. Stale after 500 ms without stream frames.
        bool fresh = (now - l->lastCtrlRxMs) < 500;
        p["fm"] = fresh ? l->streamKind : 0;
        if (fresh && l->streamKind == 2) p["robot"] = (const char*)l->robotName;
        p["lack"] = (int)l->linkAckCount;
        p["sack"] = (int)l->sessionAckCount;
        p["pack"] = (int)l->pollAckCount;
        p["enumreq"] = (int)l->enumReqCount;
        p["swreplug"] = (int)l->swreplugCount;
    }
    // C/D run on the RP2350; report what the last SPI poll returned. Omit
    // entirely (rather than showing stale/zeroed fields) until reachable —
    // the UI should say "no RP2350" instead of implying a real link status.
    if (rp2350Reachable) {
        Rp2350PortStatus* rpPorts[2] = {&portC, &portD};
        char names[2] = {'C', 'D'};
        for (int i = 0; i < 2; i++) {
            if (!rpPorts[i]->haveStatus) continue;
            JsonObject p = ports.add<JsonObject>();
            p["port"] = String(names[i]);
            p["link"] = rpPorts[i]->linkUp;
            p["ctrl"] = rpPorts[i]->linkUp || rpPorts[i]->streamKind > 0;
            p["fm"] = rpPorts[i]->streamKind;
            if (rpPorts[i]->streamKind == 2 && rpPorts[i]->robotName[0]) {
                p["robot"] = (const char*)rpPorts[i]->robotName;
            }
            p["lack"] = (int)rpPorts[i]->linkAckCount;
            p["sack"] = 0;   // not tracked over this link's compact status frame
            p["pack"] = (int)rpPorts[i]->pollAckCount;
            p["enumreq"] = 0;
            p["swreplug"] = (int)rpPorts[i]->swreplugCount;
        }
    }
    doc["rp2350"] = rp2350Reachable;
    serializeJson(doc, Serial);
    Serial.println();
}

// ─── Services for devtools.cpp ───
bool mainFieldEngaged() { return fieldEngaged; }
bool mainRp2350Run() { return rp2350Run; }
void mainEmitError(const char* reason, const char* cmd) { emitError(reason, cmd); }
bool mainSpiRequest(uint8_t cmd, const uint8_t* payload, uint8_t len, SpiLinkFrame* result,
                    uint32_t timeoutMs) {
    return spiRequestAndWait((SpiLinkCmd)cmd, 0, 0, payload, len, result, timeoutMs);
}

static void emitError(const char* reason, const char* cmd) {
    JsonDocument e;
    e["evt"] = "bu_error";
    e["reason"] = reason;
    if (cmd) e["cmd"] = cmd;
    serializeJson(e, Serial); Serial.println();
}
