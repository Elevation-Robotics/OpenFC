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
// Development tools: Smart-port bus capture and the A<->B relay. Built only
// with OPENFC_DEVTOOLS=1 (see platformio.ini); release builds leave them out.

#include "devtools.h"

#if OPENFC_DEVTOOLS

#include <Arduino.h>
#include <ArduinoJson.h>
#include <driver/uart.h>
#include <hal/uart_ll.h>

#include "openfc_pins_v13.h"
#include "openfc_capture.h"

// Bus capture for A/B: one FIFO of timestamped records, held until dumped
// (or drained live in stream mode). C/D records live in the RP2350's ring.
static CaptureRing capRing;
static bool capStream = false;
static bool capDumping = false;
static uint8_t capMaskAB = 0;   // bit0 A, bit1 B
static uint8_t capMaskCD = 0;   // bit0 C, bit1 D, mirrors the RP2350

struct CdCapStatus {
    bool ok = false, recording = false;
    uint32_t used = 0, size = 0, dropped = 0, records = 0;
};

static void emitCapStatus(bool done);
static CdCapStatus rp2350Capture(uint8_t op, uint8_t mask);
static void dumpCd();
static void doRelay(const JsonDocument& doc);

void devtoolsBegin() {
    for (size_t sz = 128 * 1024; sz >= 32 * 1024; sz /= 2) {
        uint8_t* mem = (uint8_t*)malloc(sz);
        if (mem) { capRing.init(mem, sz); break; }
    }
}

void devtoolsOnRp2350Reset() {
    capMaskCD = 0;   // the RP2350's ring and mask were cleared by the reset
}

bool devtoolsCommand(const char* cmd, const JsonDocument& doc) {
    if (strcmp(cmd, "capture") == 0) {
        if (doc["on"].is<bool>()) {
            bool on = doc["on"].as<bool>();
            uint8_t ab = 0, cd = 0;
            for (JsonVariantConst v : doc["ports"].as<JsonArrayConst>()) {
                const char* s = v | "";
                if (s[0] == 'A') ab |= 1; else if (s[0] == 'B') ab |= 2;
                else if (s[0] == 'C') cd |= 1; else if (s[0] == 'D') cd |= 2;
            }
            if (!ab && !cd) { ab = 3; cd = 3; }
            capDumping = false;
            if (on) { capRing.clear(); capStream = doc["stream"] | false; }
            capMaskAB = on ? ab : 0;
            if (on ? cd : capMaskCD) {
                capMaskCD = (on && rp2350Capture(1, cd).ok) ? cd : 0;
                if (!on) rp2350Capture(0, 0);
            }
        }
        if (doc["dump"] | false) {
            capMaskAB = 0;
            if (capMaskCD) { rp2350Capture(0, 0); capMaskCD = 0; }
            capDumping = true;   // A/B drain in serviceCapture(), ending with done:true
            if (!mainFieldEngaged()) dumpCd();
        }
        emitCapStatus(false);

        return true;
    }
    if (strcmp(cmd, "relay") == 0) {
        if (mainFieldEngaged()) { mainEmitError("field_engaged", "relay"); return true; }
        doRelay(doc);
        return true;
    }
    return false;
}

// ─── Bus capture ───
void devtoolsCapSink(char port, bool tx, const uint8_t* b, size_t n, uint32_t tUs) {
    if (capMaskAB & (port == 'A' ? 1 : 2)) capRing.push(port, tx, b, n, tUs);
}

static const size_t CAP_LINE_MAX = 64 + CAP_MAX_PAYLOAD * 2 + 4;
static const int CAP_TX_RESERVE = 512;   // left free so ordinary events never block

static size_t capFormatLine(const CapRecordHeader& h, const uint8_t* b, char* out) {
    static const char DIGITS[] = "0123456789ABCDEF";   // HEX is an Arduino macro
    int n = snprintf(out, 64, "{\"evt\":\"bu_cap\",\"p\":\"%c\",\"d\":\"%s\",\"t\":%lu,\"h\":\"",
                     h.port, h.tx ? "tx" : "rx", (unsigned long)h.tUs);
    for (uint8_t i = 0; i < h.len; i++) {
        out[n++] = DIGITS[b[i] >> 4];
        out[n++] = DIGITS[b[i] & 0xF];
    }
    out[n++] = '"'; out[n++] = '}'; out[n++] = '\n';
    return (size_t)n;
}

// Drains the A/B ring to the host without ever blocking: live in stream
// mode, or all at once after a dump.
void devtoolsService() {
    if (!capDumping && !(capStream && capMaskAB)) return;
    static uint8_t body[CAP_MAX_PAYLOAD];
    static char line[CAP_LINE_MAX];
    CapRecordHeader h;
    for (int k = 0; k < 8 && !capRing.empty(); k++) {
        int need = 64 + capRing.peekLen() * 2 + 4 + CAP_TX_RESERVE;
        if ((int)Serial.availableForWrite() < need) return;
        capRing.pop(&h, body);
        Serial.write((const uint8_t*)line, capFormatLine(h, body, line));
    }
    if (capDumping && capRing.empty()) {
        capDumping = false;
        emitCapStatus(true);
    }
}

static uint32_t le32(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// op 0 = stop, 1 = start (clears the ring), 2 = status.
static CdCapStatus rp2350Capture(uint8_t op, uint8_t mask) {
    CdCapStatus s;
    if (!mainRp2350Run()) return s;
    uint8_t req[2] = {op, mask};
    SpiLinkFrame r;
    if (!mainSpiRequest(SPI_CMD_CAPTURE, req, sizeof(req), &r, 300) ||
        r.b0 != SPI_STATUS_OK || r.len < 18) return s;
    s.ok = true;
    s.used = le32(r.payload);
    s.size = le32(r.payload + 4);
    s.dropped = le32(r.payload + 8);
    s.records = le32(r.payload + 12);
    s.recording = r.payload[16] != 0;
    return s;
}

// Pulls the RP2350's ring over SPI and writes it out. Blocks for the whole
// transfer, so only while the field is disengaged.
static void dumpCd() {
    if (!mainRp2350Run()) return;
    static uint8_t body[CAP_MAX_PAYLOAD];
    static char line[CAP_LINE_MAX];
    CapStreamParser parser;
    CapRecordHeader h;
    for (;;) {
        SpiLinkFrame r;
        if (!mainSpiRequest(SPI_CMD_CAPTURE_READ, nullptr, 0, &r, 300) ||
            r.b0 != SPI_STATUS_OK) return;
        for (uint8_t i = 0; i < r.len; i++) {
            if (parser.feed(r.payload[i], &h, body)) {
                Serial.write((const uint8_t*)line, capFormatLine(h, body, line));
            }
        }
        if (r.len == 0 || !(r.flags & 1)) return;
    }
}

// ─── A<->B relay ───
// Sits between a real field controller and a V5 controller: bytes arriving on
// one port go straight out the other, read from and written to the UART FIFOs
// directly (the driver's ISR is parked for the duration), so the added delay
// is about a byte time. Each side's driver is enabled only while forwarding
// and released hold_us after the last byte. Every burst is recorded in the
// capture ring as rx on the port it arrived on. Blocks the loop for ms.
struct RelaySide {
    uart_dev_t* hw;
    int dePin;
    char name;
    bool driving = false;
    uint32_t lastTxUs = 0;
    uint8_t burst[CAP_MAX_PAYLOAD];
    size_t burstLen = 0;
    uint32_t burstUs = 0, lastRxUs = 0;
    uint32_t bytes = 0;
};

static void relayFlushBurst(RelaySide& s) {
    if (s.burstLen) capRing.push(s.name, false, s.burst, s.burstLen, s.burstUs);
    s.burstLen = 0;
}

static void doRelay(const JsonDocument& doc) {
    uint32_t ms = doc["ms"] | 30000;
    if (ms > 120000) ms = 120000;
    uint32_t holdUs = doc["hold_us"] | 40;
    if (holdUs > 2000) holdUs = 2000;

    JsonDocument ack; ack["evt"] = "ack"; ack["cmd"] = "relay";
    serializeJson(ack, Serial); Serial.println();
    Serial.flush();

    capRing.clear();
    capMaskAB = 0;
    uart_disable_rx_intr(UART_NUM_1);
    uart_disable_rx_intr(UART_NUM_2);
    uart_flush_input(UART_NUM_1);
    uart_flush_input(UART_NUM_2);

    static RelaySide a, b;
    a = RelaySide(); b = RelaySide();
    a.hw = UART_LL_GET_HW(1); a.dePin = PIN_RS485A_DE; a.name = 'A';
    b.hw = UART_LL_GET_HW(2); b.dePin = PIN_RS485B_DE; b.name = 'B';
    digitalWrite(a.dePin, LOW);
    digitalWrite(b.dePin, LOW);
    RelaySide* sides[2] = {&a, &b};

    uint32_t start = millis();
    uint8_t chunk[64];
    while (millis() - start < ms) {
        for (int i = 0; i < 2; i++) {
            RelaySide& src = *sides[i];
            RelaySide& dst = *sides[1 - i];
            uint32_t us = micros();
            uint32_t n = uart_ll_get_rxfifo_len(src.hw);
            if (n) {
                uint32_t room = uart_ll_get_txfifo_len(dst.hw);
                if (n > room) n = room;
                if (n > sizeof(chunk)) n = sizeof(chunk);
                if (n) {
                    uart_ll_read_rxfifo(src.hw, chunk, n);
                    if (!dst.driving) { digitalWrite(dst.dePin, HIGH); dst.driving = true; }
                    uart_ll_write_txfifo(dst.hw, chunk, n);
                    dst.lastTxUs = us;
                    src.bytes += n;
                    for (uint32_t k = 0; k < n; k++) {
                        if (src.burstLen == 0) src.burstUs = us;
                        src.burst[src.burstLen++] = chunk[k];
                        if (src.burstLen == sizeof(src.burst)) relayFlushBurst(src);
                    }
                    src.lastRxUs = us;
                }
            } else if (src.burstLen && us - src.lastRxUs > 20) {
                relayFlushBurst(src);
            }
            if (dst.driving && uart_ll_is_tx_idle(dst.hw) && us - dst.lastTxUs > holdUs) {
                digitalWrite(dst.dePin, LOW);
                dst.driving = false;
            }
        }
    }

    while (!uart_ll_is_tx_idle(a.hw) || !uart_ll_is_tx_idle(b.hw)) {}
    digitalWrite(a.dePin, LOW);
    digitalWrite(b.dePin, LOW);
    relayFlushBurst(a);
    relayFlushBurst(b);
    uart_flush_input(UART_NUM_1);
    uart_flush_input(UART_NUM_2);
    uart_enable_rx_intr(UART_NUM_1);
    uart_enable_rx_intr(UART_NUM_2);

    JsonDocument out;
    out["evt"] = "bu_relay_result";
    out["ms"] = ms;
    out["hold_us"] = holdUs;
    out["a_bytes"] = a.bytes;   // from the device on A, sent to B
    out["b_bytes"] = b.bytes;   // from the device on B, sent to A
    out["records"] = capRing.records();
    out["dropped"] = capRing.dropped();
    serializeJson(out, Serial); Serial.println();
}

static void emitCapStatus(bool done) {
    JsonDocument d;
    d["evt"] = "bu_cap_status";
    d["recording"] = (capMaskAB | capMaskCD) != 0;
    d["stream"] = capStream;
    String ports;
    if (capMaskAB & 1) ports += 'A';
    if (capMaskAB & 2) ports += 'B';
    if (capMaskCD & 1) ports += 'C';
    if (capMaskCD & 2) ports += 'D';
    d["ports"] = ports;
    JsonObject ab = d["ab"].to<JsonObject>();
    ab["used"] = (uint32_t)capRing.used();
    ab["size"] = (uint32_t)capRing.size();
    ab["dropped"] = capRing.dropped();
    ab["records"] = capRing.records();
    CdCapStatus cd = rp2350Capture(2, 0);
    if (cd.ok) {
        JsonObject o = d["cd"].to<JsonObject>();
        o["used"] = cd.used;
        o["size"] = cd.size;
        o["dropped"] = cd.dropped;
        o["records"] = cd.records;
    }
    if (done) d["done"] = true;
    serializeJson(d, Serial); Serial.println();
}

#endif  // OPENFC_DEVTOOLS
