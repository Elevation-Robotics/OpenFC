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
// See smart_link.h. The RP2350 copy (smart_link_rp.cpp) must keep the same
// protocol logic.

#include "smart_link.h"

static uint8_t modeFor(openfc_state_t s) {
    return (s == STATE_DRIVER) ? MODE_DRIVER : (s == STATE_AUTON) ? MODE_AUTON : MODE_DISABLED;
}

void SmartLink::begin(HardwareSerial* bus, uart_port_t uartNum, int dePin, char portName) {
    bus_ = bus;
    uartNum_ = uartNum;
    dePin_ = dePin;
    name = portName;
    reset(millis());
}

void SmartLink::reset(uint32_t now) {
    rxLen_ = 0;
    stage_ = ST_IDLE;
    linkUp = false;
    lastStreamedMode_ = -1;
    replySlot_ = 0;
    stateEnteredMs_ = now;
    streamKind = 0;
    matchEndPending = false;
    swreplugPending = false;
    if (bus_) while (bus_->available()) bus_->read();
}

void SmartLink::busWrite(const uint8_t* f, size_t n) {
    if (capSink) capSink(name, true, f, n, micros());
    digitalWrite(dePin_, HIGH);
    bus_->write(f, n);
    bus_->flush();
    uart_wait_tx_done(uartNum_, portMAX_DELAY);
    digitalWrite(dePin_, LOW);
}

uint32_t SmartLink::matchRemainingMs() const {
    uint32_t period = (g_field_state == STATE_DRIVER) ? g_driver_period_ms
                    : (g_field_state == STATE_AUTON)  ? g_auton_period_ms : 0;
    uint32_t elapsed = millis() - stateEnteredMs_;
    return (elapsed >= period) ? 0 : (period - elapsed);
}

// One reply per controller frame, per the table in openfc_frames.h.
void SmartLink::onFrame(const uint8_t* f, size_t n, uint32_t now) {
    lastCtrlRxMs = now;
    ctrlSeen_ = true;
    uint8_t ack[FRAME_SIZE];

    switch (f[0]) {
        case LINKPOLL_FIRST:
            // A linked controller does not announce; one that does has
            // dropped the session and is starting over.
            if (linkUp) {
                linkUp = false;
                streamKind = 0;
                lastStreamedMode_ = -1;
            }
            busWrite(FC_REPLY1, LINK16_SIZE);
            replyTxCount++;
            stage_ = ST_HELLO;
            return;

        case 0x13:
            busWrite(FC_SESSION_ACK, LINK16_SIZE);
            linkAckCount++;
            sessionAckCount++;
            stage_ = ST_ACKED;
            return;

        case 0x11:
            enumReqCount++;
            busWrite(ENUM_04, FRAME_SIZE);
            stage_ = ST_SENT04;
            return;

        case 0x02:
            if (n == FRAME_SIZE && (f[1] == 0x04 || f[1] == 0x54)) {
                build_fc_ack(0x02, ack);
                busWrite(ack, FRAME_SIZE);
                stage_ = (f[1] == 0x04) ? ST_WANT54 : ST_SENT54;
            }
            return;

        case 0xA3:
            build_fc_ack(0xA3, ack);
            busWrite(ack, FRAME_SIZE);
            stage_ = ST_ENUMERATED;
            return;

        case 0xA7:
        case 0xA0: {
            pollAckCount++;
            streamKind = (f[0] == 0xA7) ? 2 : 1;
            if (f[0] == 0xA7 && n == FRAME_SIZE) {
                memcpy(robotName, f + 18, 6);
                echoMode_ = f[6];
            }
            if (stage_ == ST_WANT54) {
                uint8_t e54[FRAME_SIZE];
                memcpy(e54, ENUM_54, FRAME_SIZE);
                e54[3] = 0x00;
                uint16_t c54 = crc16_ccitt_false(e54, CRC_START_INDEX);
                e54[30] = (c54 >> 8) & 0xFF;
                e54[31] = c54 & 0xFF;
                busWrite(e54, FRAME_SIZE);
                stage_ = ST_SENT54;
                return;
            }
            // After enumeration, or a controller already in session when we
            // engaged: answer with the state.
            if (!linkUp) {
                linkUp = true;
                lastStreamedMode_ = -1;
            }
            streamStatePoll();
            return;
        }

        default:
            return;
    }
}

// Steady state, as in the recording: a 53 on every mode change; while
// enabled, 53 with the live ms countdown on 4 frames of 5 and 02 A7 on the
// fifth; while disabled, 02 A7.
void SmartLink::streamStatePoll() {
    uint8_t mode = (streamKind == 2 || !g_field_interlock) ? modeFor(g_field_state) : MODE_DISABLED;
    uint8_t cmd[FRAME_SIZE];
    if ((int)mode != lastStreamedMode_) {
        stateEnteredMs_ = millis();
        replySlot_ = 0;
        build_state53(mode, (mode == MODE_DISABLED) ? 0 : matchRemainingMs(), cmd);
        busWrite(cmd, FRAME_SIZE);
        lastStreamedMode_ = mode;
        since53_ = 0;
        return;
    }
    if (since53_ < 255) since53_++;
    // A controller in field mode echoes its mode back; until it matches,
    // re-send the 53 every other frame so a missed one cannot strand it.
    if (streamKind == 2 && echoMode_ != mode && since53_ >= 2) {
        build_state53(mode, (mode == MODE_DISABLED) ? 0 : matchRemainingMs(), cmd);
        busWrite(cmd, FRAME_SIZE);
        since53_ = 0;
        return;
    }
    if (mode == MODE_DISABLED || replySlot_ >= 4) {
        busWrite(ACK_A7, FRAME_SIZE);
        replySlot_ = 0;
    } else {
        build_state53(mode, matchRemainingMs(), cmd);
        busWrite(cmd, FRAME_SIZE);
        replySlot_++;
        since53_ = 0;
    }
}

void SmartLink::service(uint32_t now) {
    // Bulk-read the ring buffer in one shot (byte-by-byte read() takes a
    // driver mutex per call, ~20 us each).
    int avail = bus_->available();
    if (avail > 0) {
        size_t space = sizeof(rxBuf_) - rxLen_;
        size_t want = ((size_t)avail < space) ? (size_t)avail : space;
        if (want) {
            size_t got = bus_->read(rxBuf_ + rxLen_, want);
            if (capSink && got) capSink(name, false, rxBuf_ + rxLen_, got, micros());
            rxLen_ += got;
        }
    }
    size_t i = 0;
    while (rxLen_ - i >= LINK16_SIZE) {
        bool matched = false;
        // 16-byte controller frames: announce (0A 4B), ID (13 20), short
        // enum request (11 00). CRC over bytes 0..13.
        const uint8_t* p = rxBuf_ + i;
        if (p[0] == LINKPOLL_FIRST || (p[0] == 0x13 && p[1] == 0x20) ||
            (p[0] == 0x11 && p[1] == 0x00)) {
            uint16_t c = crc16_ccitt_false(p, LINK16_CRC_COV);
            if (p[14] == ((c >> 8) & 0xFF) && p[15] == (c & 0xFF)) {
                onFrame(p, LINK16_SIZE, now);
                i += LINK16_SIZE;
                matched = true;
            }
        }
        if (!matched && rxLen_ - i >= FRAME_SIZE) {
            uint16_t c = crc16_ccitt_false(p, CRC_START_INDEX);
            if (p[30] == ((c >> 8) & 0xFF) && p[31] == (c & 0xFF)) {
                onFrame(p, FRAME_SIZE, now);
                i += FRAME_SIZE;
                matched = true;
            }
        }
        if (!matched) {
            if (rxLen_ - i < FRAME_SIZE) break;  // await more bytes before resync
            i++;                                 // resync one byte at a time
        }
    }
    if (i > 0) {
        memmove(rxBuf_, rxBuf_ + i, rxLen_ - i);
        rxLen_ -= i;
    }
    if (rxLen_ >= sizeof(rxBuf_)) rxLen_ = 0;  // runaway guard

    // Match end: countdown expired while the mode was actually streaming.
    if (g_field_state != STATE_DISABLED &&
        lastStreamedMode_ == (int)modeFor(g_field_state) &&
        matchRemainingMs() == 0) {
        matchEndPending = true;
    }
}
