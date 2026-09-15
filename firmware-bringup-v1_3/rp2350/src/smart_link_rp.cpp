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
// file's comments (which cite OpenFC-Smart's findings doc) are canonical.

#include "smart_link_rp.h"

static const uint32_t REPLY2_GAP_US = 62;
static const uint32_t COLD_REPLY2_EXTRA_US = 100;
static const uint32_t COLD_ISOLATION_US = 120000;
static const uint32_t REPLY_REFRACTORY_US = 250000;
static const uint32_t ENUM_AFTER_ACK_MS = 99;
static const uint32_t A7_PERIOD_MS = 19;
static const uint32_t SWREPLUG_AFTER_MS = 8000;
static const uint32_t SWREPLUG_QUIET_MS = 2500;

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
    linkAckMs_ = 0;
    enumDone_ = false;
    linkUp = false;
    lastLinkpollUs_ = 0;
    lastReplyUs_ = 0;
    lastEnumAnswerMs_ = 0;
    lastStreamedMode_ = -1;
    replySlot_ = 0;
    c53BurstLeft_ = 0;
    stateEnteredMs_ = now;
    streamKind = 0;
    a0SinceMs_ = 0;
    forcedQuietUntilMs_ = 0;
    seenA7_ = false;
    matchEndPending = false;
    if (bus_) while (bus_->available()) bus_->read();
}

// arduino-pico's SerialUART::flush() blocks until the UART is idle
// (TX FIFO + shift register drained), so DE release is safe right after.
void SmartLinkRp::busWrite(const uint8_t* f, size_t n) {
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

void SmartLinkRp::handleLinkPoll(const uint8_t* f) {
    uint32_t now = millis();
    if (forcedQuietUntilMs_ && now < forcedQuietUntilMs_) return;
    ctrlSeen_ = true;
    lastCtrlRxMs = now;

    uint32_t nowUs = micros();
    uint32_t idleUs = (lastLinkpollUs_ == 0) ? 0xFFFFFFFFu : (nowUs - lastLinkpollUs_);
    lastLinkpollUs_ = nowUs;

    if (linkAckMs_ != 0 && !linkUp) return;          // silent ack->enum gap
    bool cold = (f[13] == 0x00);
    if (cold && idleUs < COLD_ISOLATION_US) return;  // skip the boot flood
    if (lastReplyUs_ && (nowUs - lastReplyUs_) < REPLY_REFRACTORY_US) return;

    if (linkUp) {                                    // relink on announce
        linkUp = false;
        enumDone_ = false;
        linkAckMs_ = 0;
        lastStreamedMode_ = -1;
    }

    uint8_t r2[LINK16_SIZE];
    build_link_reply2(f, r2);
    const uint8_t* r1 = cold ? LINK_REPLY1_COLD : LINK_REPLY1;
    uint32_t gap = REPLY2_GAP_US + (cold ? COLD_REPLY2_EXTRA_US : 0);

    // HELD DE across the reply pair (idle-MARK in the gap).
    digitalWrite(dePin_, HIGH);
    bus_->write(r1, LINK16_SIZE);
    bus_->flush();
    delayMicroseconds(gap);
    bus_->write(r2, LINK16_SIZE);
    bus_->flush();
    digitalWrite(dePin_, LOW);
    replyTxCount++;
    lastReplyUs_ = micros();

    // Inline 700 us ack-capture window (RE gated by DE: no own echo here).
    uint8_t ab[48];
    size_t an = 0;
    uint32_t t0 = micros();
    while ((micros() - t0) < 700 && an < sizeof(ab)) {
        if (bus_->available()) ab[an++] = (uint8_t)bus_->read();
    }
    for (size_t k = 0; k + LINK16_SIZE <= an; k++) {
        if (ab[k] != 0x02 || ab[k + 1] != 0x13) continue;
        uint16_t c = crc16_ccitt_false(ab + k, LINK16_CRC_COV);
        if (ab[k + 14] == ((c >> 8) & 0xFF) && ab[k + 15] == (c & 0xFF)) {
            handleShortAck(ab + k);
            break;
        }
    }
}

void SmartLinkRp::handleShortAck(const uint8_t* f) {
    lastCtrlRxMs = millis();
    ctrlSeen_ = true;
    linkAckCount++;
    if (f[2] == 0x01) sessionAckCount++;
    if (!enumDone_ && linkAckMs_ == 0) linkAckMs_ = millis();
}

void SmartLinkRp::answerEnumRequest(uint32_t now) {
    enumReqCount++;
    if (forcedQuietUntilMs_ && now < forcedQuietUntilMs_) return;
    if (now - lastEnumAnswerMs_ < 50) return;
    lastEnumAnswerMs_ = now;

    busWrite(ENUM_04, FRAME_SIZE);
    delayMicroseconds(1400);
    uint8_t e54[FRAME_SIZE];
    memcpy(e54, ENUM_54, FRAME_SIZE);
    e54[3] = 0x00;                                    // the session-winning patch
    uint16_t c54 = crc16_ccitt_false(e54, CRC_START_INDEX);
    e54[30] = (c54 >> 8) & 0xFF;
    e54[31] = c54 & 0xFF;
    busWrite(e54, FRAME_SIZE);
    delayMicroseconds(700);
    busWrite(ENUM_A3, FRAME_SIZE);
    delayMicroseconds(800);
    uint8_t c53[FRAME_SIZE];
    uint8_t mode = modeFor(g_field_state);
    build_state53(mode, 0, c53);
    busWrite(c53, FRAME_SIZE);
    lastStreamedMode_ = mode;
    if (!linkUp) {
        enumDone_ = true;
        linkUp = true;
        lastA7TxMs_ = now;
    }
}

void SmartLinkRp::handleCtrlFrame(const uint8_t* f) {
    uint32_t now = millis();
    lastCtrlRxMs = now;
    ctrlSeen_ = true;
    if (f[0] == 0x02) pollAckCount++;

    if (linkUp && (f[0] == 0xA7 || f[0] == 0xA0)) {
        pollAckCount++;
        streamKind = (f[0] == 0xA7) ? 2 : 1;
        if (f[0] == 0xA7) {
            a0SinceMs_ = 0;
            seenA7_ = true;
        } else if (a0SinceMs_ == 0) {
            a0SinceMs_ = now;
        }
        lastA7TxMs_ = now;
        streamStatePoll();
    }
    if (f[0] == 0x11) answerEnumRequest(now);
}

void SmartLinkRp::streamStatePoll() {
    uint8_t mode = (streamKind == 2) ? modeFor(g_field_state) : MODE_DISABLED;
    if ((int)mode != lastStreamedMode_) {
        stateEnteredMs_ = millis();
        replySlot_ = 0;
        c53BurstLeft_ = (mode == MODE_DISABLED) ? 3 : 0;
        uint8_t cmd[FRAME_SIZE];
        build_state53(mode, (mode == MODE_DISABLED) ? 0 : matchRemainingMs(), cmd);
        busWrite(cmd, FRAME_SIZE);
        lastStreamedMode_ = mode;
        return;
    }
    if (mode == MODE_DISABLED) {
        if (c53BurstLeft_ > 0 && replySlot_ >= 4) {
            uint8_t cmd[FRAME_SIZE];
            build_state53(MODE_DISABLED, 0, cmd);
            busWrite(cmd, FRAME_SIZE);
            c53BurstLeft_--;
            replySlot_ = 0;
        } else {
            busWrite(ACK_A7, FRAME_SIZE);
            replySlot_ = (replySlot_ >= 4) ? 0 : replySlot_ + 1;
        }
    } else if (replySlot_ >= 4) {
        busWrite(ACK_A7, FRAME_SIZE);
        replySlot_ = 0;
    } else {
        uint8_t cmd[FRAME_SIZE];
        build_state53(mode, matchRemainingMs(), cmd);
        busWrite(cmd, FRAME_SIZE);
        replySlot_++;
    }
}

void SmartLinkRp::service(uint32_t now) {
    while (bus_->available() && rxLen_ < sizeof(rxBuf_)) {
        rxBuf_[rxLen_++] = (uint8_t)bus_->read();
    }
    size_t i = 0;
    while (rxLen_ - i >= LINK16_SIZE) {
        bool matched = false;
        if (rxBuf_[i] == LINKPOLL_FIRST ||
            (rxBuf_[i] == 0x02 && rxBuf_[i + 1] == 0x13) ||
            (rxBuf_[i] == 0x11 && rxBuf_[i + 1] == 0x00)) {
            uint16_t c = crc16_ccitt_false(rxBuf_ + i, LINK16_CRC_COV);
            if (rxBuf_[i + 14] == ((c >> 8) & 0xFF) && rxBuf_[i + 15] == (c & 0xFF)) {
                if (rxBuf_[i] == LINKPOLL_FIRST) handleLinkPoll(rxBuf_ + i);
                else if (rxBuf_[i] == 0x11) answerEnumRequest(now);
                else handleShortAck(rxBuf_ + i);
                i += LINK16_SIZE;
                matched = true;
            }
        }
        if (!matched && rxLen_ - i >= FRAME_SIZE) {
            uint16_t c = crc16_ccitt_false(rxBuf_ + i, CRC_START_INDEX);
            if (rxBuf_[i + 30] == ((c >> 8) & 0xFF) && rxBuf_[i + 31] == (c & 0xFF)) {
                if (rxBuf_[i] == LINKPOLL_FIRST) handleLinkPoll(rxBuf_ + i);
                else handleCtrlFrame(rxBuf_ + i);
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

    // Software replug, capped when this engage never reached A7 (no robot
    // radio = no channel hop coming; don't churn a healthy A0 session).
    if (linkUp && streamKind == 1 && a0SinceMs_ &&
        (now - a0SinceMs_ >= SWREPLUG_AFTER_MS) &&
        (seenA7_ || swreplugCount < 2)) {
        linkUp = false;
        enumDone_ = false;
        linkAckMs_ = 0;
        lastStreamedMode_ = -1;
        streamKind = 0;
        a0SinceMs_ = 0;
        forcedQuietUntilMs_ = now + SWREPLUG_QUIET_MS;
        swreplugCount++;
        while (bus_->available()) bus_->read();
        rxLen_ = 0;
    }

    if (g_field_state != STATE_DISABLED &&
        lastStreamedMode_ == (int)modeFor(g_field_state) &&
        matchRemainingMs() == 0) {
        matchEndPending = true;
    }

    if (linkAckMs_ && !enumDone_ && (now - linkAckMs_ >= 3 * ENUM_AFTER_ACK_MS)) {
        answerEnumRequest(now);
        enumDone_ = true;
        linkUp = true;
        lastA7TxMs_ = now;
    }

    if (linkUp && (now - lastA7TxMs_ >= A7_PERIOD_MS)) {
        lastA7TxMs_ = now;
        streamStatePoll();
    }
}
