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
// OpenFC V1_3 BRING-UP firmware (RP2350 "Serial Expander") — v2.
//
// Runs the proven Smart-port field-control session engines for ports C/D
// (smart_link_rp.*) and answers the ESP32 over a CS-framed slave SPI link.
// Flashed in-circuit BY THE ESP32 over bit-banged SWD (see the ESP32
// project's swd_rp2350.*) — there is no other programming path populated
// on this board.
//
// SPI slave framing (v2, replaces v1's spi_write_read_blocking loop, which
// had no transaction alignment and desynced immediately): the CS pad state
// is readable via gpio_get() even while the pin is muxed to the SPI
// peripheral, so transactions are delimited by CS edges. While CS is high
// the first 8 bytes of the current result frame are preloaded into the
// PL022's 8-deep TX FIFO (the master's first clocks arrive long before the
// loop could react); the rest is fed as the master clocks. A malformed or
// truncated transaction resets the SPI peripheral (the PL022 FIFOs have no
// flush, so re-init is the only reliable resync).
//
// Commands FIELD_SET / FIELD_STATUS / PING answer immediately. RS485_RAW is
// a non-blocking diagnostic available only while NOT engaged: while idle
// the loop drains each port's UART into a small ring so a zero-length
// RS485_RAW returns the most recent bytes heard (a passive listen, same
// idea as the ESP32's rs485_listen for A/B); a non-empty payload is sent
// with DE held, then the reply window is captured and returned via the
// PENDING -> OK poll path. LINKTEST returns ERROR — the engines own C/D.

#include <Arduino.h>
#include <hardware/spi.h>
#include <hardware/gpio.h>

#include "openfc_pins_rp2350.h"
#include "openfc_frames.h"
#include "openfc_spi_link.h"
#include "smart_link_rp.h"

openfc_state_t g_field_state = STATE_DISABLED;
uint32_t g_driver_period_ms = 105000;
uint32_t g_auton_period_ms = 15000;
static bool fieldEngaged = false;
static uint32_t lastSpiCmdMs = 0;

static SmartLinkRp linkC, linkD;

// ─── SPI slave state ───
static uint8_t resultTxBuf[SPI_LINK_FRAME_LEN];
static size_t txIdx = 0;         // bytes of resultTxBuf pushed this cycle
static bool inTransaction = false;
static uint8_t rxFrame[SPI_LINK_FRAME_LEN];
static size_t rxIdx = 0;

static void setResult(SpiLinkStatus status, uint8_t port, const uint8_t* payload, uint8_t len,
                      uint8_t flags = 0) {
    SpiLinkFrame f = {};
    f.b0 = status;
    f.port = port;
    f.flags = flags;
    f.len = len > SPI_LINK_MAX_PAYLOAD ? SPI_LINK_MAX_PAYLOAD : len;
    if (payload && len) memcpy(f.payload, payload, f.len);
    spi_link_pack(f, resultTxBuf);
    txIdx = 0;                    // force a fresh preload of the new result
}

// ─── Raw RS-485 diagnostics (idle only) ───
struct RawPortCapture {
    SerialUART* bus = nullptr;
    int dePin = -1;
    uint8_t ring[64];
    size_t head = 0;            // next write index
    size_t count = 0;           // valid bytes (<= sizeof ring)
    uint32_t totalSeen = 0;
};
static RawPortCapture rawC, rawD;
static RawPortCapture* rawPending = nullptr;   // send-and-capture in flight
static uint8_t rawPendingPort = 0;
static uint32_t rawDeadlineMs = 0;

static RawPortCapture* rawForPort(uint8_t port) {
    if (port == 'C') return &rawC;
    if (port == 'D') return &rawD;
    return nullptr;
}

static void rawClear(RawPortCapture& r) {
    r.head = 0;
    r.count = 0;
}

static void rawDrain(RawPortCapture& r) {
    while (r.bus->available()) {
        r.ring[r.head] = (uint8_t)r.bus->read();
        r.head = (r.head + 1) % sizeof(r.ring);
        if (r.count < sizeof(r.ring)) r.count++;
        r.totalSeen++;
    }
}

// Oldest-first copy of the last `n` captured bytes.
static uint8_t rawSnapshot(const RawPortCapture& r, uint8_t* out, uint8_t n) {
    if (n > r.count) n = (uint8_t)r.count;
    size_t start = (r.head + sizeof(r.ring) - n) % sizeof(r.ring);
    for (uint8_t i = 0; i < n; i++) out[i] = r.ring[(start + i) % sizeof(r.ring)];
    return n;
}

static void rawFinish(RawPortCapture& r, uint8_t port) {
    rawDrain(r);
    uint8_t buf[SPI_LINK_MAX_PAYLOAD];
    uint8_t n = rawSnapshot(r, buf, SPI_LINK_MAX_PAYLOAD);
    setResult(SPI_STATUS_OK, port, buf, n, (uint8_t)(r.totalSeen & 0xFF));
}

static void spiPeriphInit() {
    gpio_set_function(PIN_SPI_MISO, GPIO_FUNC_SPI);
    gpio_set_function(PIN_SPI_MOSI, GPIO_FUNC_SPI);
    gpio_set_function(PIN_SPI_SCLK, GPIO_FUNC_SPI);
    gpio_set_function(PIN_SPI_CS, GPIO_FUNC_SPI);
    spi_init(spi0, SPI_LINK_HZ);
    spi_set_slave(spi0, true);
    // CPHA=1 (SPI mode 1): the PL022 in Motorola CPHA=0 mode needs CS to
    // deassert between every byte; the ESP32 holds CS low for the whole
    // 37-byte frame, which with CPHA=0 yields exactly 1 RX byte per
    // transaction and MISO parked high (seen on the bench as all-0xFF).
    spi_set_format(spi0, 8, SPI_CPOL_0, SPI_CPHA_1, SPI_MSB_FIRST);
    txIdx = 0;
    rxIdx = 0;
    inTransaction = false;
}

static void handleRequest(const SpiLinkFrame& req) {
    lastSpiCmdMs = millis();
    switch (req.b0) {
        case SPI_CMD_PING:
            setResult(SPI_STATUS_OK, 0, nullptr, 0);
            break;
        case SPI_CMD_FIELD_SET: {
            bool engage = req.payload[0] != 0;
            if (engage != fieldEngaged) {
                fieldEngaged = engage;
                uint32_t now = millis();
                linkC.reset(now);
                linkD.reset(now);
            }
            uint8_t st = req.payload[1];
            g_field_state = (st == 1) ? STATE_DRIVER : (st == 2) ? STATE_AUTON : STATE_DISABLED;
            memcpy(&g_driver_period_ms, req.payload + 2, 4);
            memcpy(&g_auton_period_ms, req.payload + 6, 4);
            setResult(SPI_STATUS_OK, 0, nullptr, 0);
            break;
        }
        case SPI_CMD_FIELD_STATUS: {
            uint8_t p[14];
            p[0] = fieldEngaged ? 1 : 0;
            p[1] = (g_field_state == STATE_DRIVER) ? 1 : (g_field_state == STATE_AUTON) ? 2 : 0;
            SmartLinkRp* ls[2] = {&linkC, &linkD};
            for (int i = 0; i < 2; i++) {
                uint32_t now = millis();
                bool fresh = (now - ls[i]->lastCtrlRxMs) < 500;
                p[2 + i * 6 + 0] = ls[i]->linkUp ? 1 : 0;
                p[2 + i * 6 + 1] = (uint8_t)(fresh ? ls[i]->streamKind : 0);
                p[2 + i * 6 + 2] = (uint8_t)(ls[i]->pollAckCount & 0xFF);
                p[2 + i * 6 + 3] = (uint8_t)((ls[i]->pollAckCount >> 8) & 0xFF);
                p[2 + i * 6 + 4] = (uint8_t)(ls[i]->linkAckCount & 0xFF);
                p[2 + i * 6 + 5] = (uint8_t)(ls[i]->swreplugCount & 0xFF);
            }
            setResult(SPI_STATUS_OK, 0, p, sizeof(p));
            break;
        }
        case SPI_CMD_RS485_RAW: {
            RawPortCapture* r = rawForPort(req.port);
            if (!r || fieldEngaged || rawPending) {
                setResult(SPI_STATUS_ERROR, req.port, nullptr, 0);
                break;
            }
            rawDrain(*r);
            if (req.len == 0) {
                // Passive listen: answer with whatever the idle drain has heard.
                rawFinish(*r, req.port);
                break;
            }
            rawClear(*r);
            digitalWrite(r->dePin, HIGH);
            r->bus->write(req.payload, req.len);
            r->bus->flush();
            digitalWrite(r->dePin, LOW);
            rawPending = r;
            rawPendingPort = req.port;
            rawDeadlineMs = millis() + RS485_RX_WINDOW_MS;
            setResult(SPI_STATUS_PENDING, req.port, nullptr, 0);
            break;
        }
        case SPI_CMD_GET_RESULT:
            // The transaction itself clocked the result out; keep it for
            // re-polls (setResult not called → same frame preloads again).
            break;
        default:
            setResult(SPI_STATUS_ERROR, req.port, nullptr, 0);
            break;
    }
}

static void serviceSpi() {
    bool csLow = !gpio_get(PIN_SPI_CS);

    if (!inTransaction) {
        if (!csLow) {
            // Idle: keep the first FIFO-depth of the result preloaded and
            // the RX FIFO clean.
            while (txIdx < 8 && spi_is_writable(spi0)) {
                spi_get_hw(spi0)->dr = resultTxBuf[txIdx++];
            }
            while (spi_is_readable(spi0)) (void)spi_get_hw(spi0)->dr;
            return;
        }
        inTransaction = true;
        rxIdx = 0;
    }

    // Active transaction: feed remaining TX, collect RX.
    while (txIdx < SPI_LINK_FRAME_LEN && spi_is_writable(spi0)) {
        spi_get_hw(spi0)->dr = resultTxBuf[txIdx++];
    }
    while (spi_is_readable(spi0) && rxIdx < sizeof(rxFrame)) {
        rxFrame[rxIdx++] = (uint8_t)spi_get_hw(spi0)->dr;
    }

    if (csLow) return;   // still clocking

    // CS rose: transaction over. Late-drain whatever's left.
    delayMicroseconds(5);
    while (spi_is_readable(spi0) && rxIdx < sizeof(rxFrame)) {
        rxFrame[rxIdx++] = (uint8_t)spi_get_hw(spi0)->dr;
    }
    inTransaction = false;
    bool clean = (rxIdx == SPI_LINK_FRAME_LEN) && (txIdx == SPI_LINK_FRAME_LEN);
    SpiLinkFrame req;
    if (clean && spi_link_unpack(rxFrame, &req)) {
        handleRequest(req);
        txIdx = 0;       // preload the (possibly new) result for the next poll
    } else {
        // Desync (short transaction, overrun mid-engine-work, bad checksum):
        // the PL022 FIFOs can't be flushed, so re-init the peripheral.
        spiPeriphInit();
    }
    rxIdx = 0;
}

void setup() {
    pinMode(PIN_RS485C_DE, OUTPUT);
    pinMode(PIN_RS485D_DE, OUTPUT);
    digitalWrite(PIN_RS485C_DE, LOW);
    digitalWrite(PIN_RS485D_DE, LOW);

    pinMode(PIN_IRQ_OUT, OUTPUT);
    digitalWrite(PIN_IRQ_OUT, LOW);
    pinMode(PIN_ESP_READY, INPUT);
    pinMode(PIN_BOOT_CTRL, INPUT);

    Serial1.setTX(PIN_RS485C_TX);
    Serial1.setRX(PIN_RS485C_RX);
    Serial1.setFIFOSize(512);
    Serial1.begin(1600000);

    Serial2.setTX(PIN_RS485D_TX);
    Serial2.setRX(PIN_RS485D_RX);
    Serial2.setFIFOSize(512);
    Serial2.begin(1600000);

    spiPeriphInit();

    linkC.begin(&Serial1, PIN_RS485C_DE, 'C');
    linkD.begin(&Serial2, PIN_RS485D_DE, 'D');

    rawC.bus = &Serial1; rawC.dePin = PIN_RS485C_DE;
    rawD.bus = &Serial2; rawD.dePin = PIN_RS485D_DE;

    setResult(SPI_STATUS_IDLE, 0, nullptr, 0);
}

void loop() {
    uint32_t now = millis();
    serviceSpi();

    if (!fieldEngaged) {
        rawDrain(rawC);
        rawDrain(rawD);
        if (rawPending && (int32_t)(now - rawDeadlineMs) >= 0) {
            rawFinish(*rawPending, rawPendingPort);
            rawPending = nullptr;
        }
    } else if (rawPending) {
        rawPending = nullptr;   // engage cancels any in-flight raw capture
    }

    if (fieldEngaged) {
        linkC.service(now);
        linkD.service(now);
        if (linkC.matchEndPending || linkD.matchEndPending) {
            linkC.matchEndPending = linkD.matchEndPending = false;
            g_field_state = STATE_DISABLED;   // ESP32 sees it via FIELD_STATUS
        }
        // Link watchdog: if the ESP32 stops talking (host gone, cable out),
        // an enabled state must not persist unsupervised.
        if (g_field_state != STATE_DISABLED && (now - lastSpiCmdMs) > 2500) {
            g_field_state = STATE_DISABLED;
        }
    }
}
