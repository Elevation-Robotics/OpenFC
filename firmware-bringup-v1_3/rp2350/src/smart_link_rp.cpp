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
// See smart_link_rp.h — platform port of the ESP32 smart_link.cpp; that
// file's comments are canonical.

#include "smart_link_rp.h"

static uint8_t modeFor(openfc_state_t s) {
    return (s == STATE_DRIVER) ? MODE_DRIVER : (s == STATE_AUTON) ? MODE_AUTON : MODE_DISABLED;
}

void SmartLinkRp::begin(SerialUART* bus, int dePin, char portName) {
    bus_ = bus;
    dePin_ = dePin;
    name = portName;
    reset(millis());
}

void SmartLinkRp::reset(uint32_t now) {
    rxLen_ = 0;
    stage_ = ST_IDLE;
    linkUp = false;
    lastStreamedMode_ = -1;
    replySlot_ = 0;
    stateEnteredMs_ = now;
    streamKind = 0;
    matchEndPending = false;
    if (bus_) while (bus_->available()) bus_->read();
}

// arduino-pico's SerialUART::flush() blocks until the UART is idle
// (TX FIFO + shift register drained), so DE release is safe right after.
void SmartLinkRp::busWrite(const uint8_t* f, size_t n) {
    if (capSink) capSink(name, true, f, n, micros());
    digitalWrite(dePin_, HIGH);
    bus_->write(f, n);
    bus_->flush();
    digitalWrite(dePin_, LOW);
}

uint32_t SmartLinkRp::matchRemainingMs() const {
    uint32_t period = (g_field_state == STATE_DRIVER) ? g_driver_period_ms
                    : (g_field_state == STATE_AUTON)  ? g_auton_period_ms : 0;
    uint32_t elapsed = millis() - stateEnteredMs_;
    return (elapsed >= period) ? 0 : (period - elapsed);
}

void SmartLinkRp::onFrame(const uint8_t* f, size_t n, uint32_t now) {
    lastCtrlRxMs = now;
    ctrlSeen_ = true;
    uint8_t ack[FRAME_SIZE];

    switch (f[0]) {
        case LINKPOLL_FIRST:
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

void SmartLinkRp::streamStatePoll() {
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

void SmartLinkRp::service(uint32_t now) {
    size_t start = rxLen_;
    while (bus_->available() && rxLen_ < sizeof(rxBuf_)) {
        rxBuf_[rxLen_++] = (uint8_t)bus_->read();
    }
    if (capSink) {
        // The loop outpaces the bytes at 1.6 Mbaud, so a frame arrives over
        // several passes; record it once the line has been idle for 40 us
        // (bytes within a frame are 6 us apart).
        uint32_t us = micros();
        for (size_t i = start; i < rxLen_; i++) {
            if (capBurstLen_ == 0) capBurstUs_ = us;
            capBurst_[capBurstLen_++] = rxBuf_[i];
            capLastByteUs_ = us;
            if (capBurstLen_ == sizeof(capBurst_)) {
                capSink(name, false, capBurst_, capBurstLen_, capBurstUs_);
                capBurstLen_ = 0;
            }
        }
        if (capBurstLen_ && rxLen_ == start && (us - capLastByteUs_) > 40) {
            capSink(name, false, capBurst_, capBurstLen_, capBurstUs_);
            capBurstLen_ = 0;
        }
    }
    size_t i = 0;
    while (rxLen_ - i >= LINK16_SIZE) {
        bool matched = false;
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
            if (rxLen_ - i < FRAME_SIZE) break;
            i++;
        }
    }
    if (i > 0) {
        memmove(rxBuf_, rxBuf_ + i, rxLen_ - i);
        rxLen_ -= i;
    }
    if (rxLen_ >= sizeof(rxBuf_)) rxLen_ = 0;

    if (g_field_state != STATE_DISABLED &&
        lastStreamedMode_ == (int)modeFor(g_field_state) &&
        matchRemainingMs() == 0) {
        matchEndPending = true;
    }
}
