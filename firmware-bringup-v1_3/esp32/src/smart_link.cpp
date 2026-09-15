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
// See smart_link.h for provenance. Comment references like "(findings,
// 2026-07-06)" point into OpenFC-Smart/docs/openfc-bringup-findings.md,
// the authoritative record for why each timing/gate exists.

#include "smart_link.h"

// Timing, verbatim from the proven firmware's final state.
static const uint32_t REPLY2_GAP_US = 62;         // ~107 us on-wire with DE/TX overhead
static const uint32_t COLD_REPLY2_EXTRA_US = 100; // extra margin on cold announces only
static const uint32_t COLD_ISOLATION_US = 120000; // answer isolated colds, skip the boot flood
static const uint32_t REPLY_REFRACTORY_US = 250000; // one reply pair per announce
static const uint32_t ENUM_AFTER_ACK_MS = 99;     // controller's own request lands at +99 ms
static const uint32_t A7_PERIOD_MS = 19;          // ~50 Hz steady-state cadence
static const uint32_t SWREPLUG_AFTER_MS = 8000;   // A0-stuck threshold before auto-replug
static const uint32_t SWREPLUG_QUIET_MS = 2500;   // "unplugged" blackout length

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
    swreplugPending = false;
    if (bus_) while (bus_->available()) bus_->read();
}

void SmartLink::busWrite(const uint8_t* f, size_t n) {
    digitalWrite(dePin_, HIGH);
    bus_->write(f, n);
    bus_->flush();
    uart_wait_tx_done(uartNum_, portMAX_DELAY);
    digitalWrite(dePin_, LOW);
}

void SmartLink::busWriteHeld(const uint8_t* f, size_t n) {
    bus_->write(f, n);
    bus_->flush();
    uart_wait_tx_done(uartNum_, portMAX_DELAY);
}

uint32_t SmartLink::matchRemainingMs() const {
    uint32_t period = (g_field_state == STATE_DRIVER) ? g_driver_period_ms
                    : (g_field_state == STATE_AUTON)  ? g_auton_period_ms : 0;
    uint32_t elapsed = millis() - stateEnteredMs_;
    return (elapsed >= period) ? 0 : (period - elapsed);
}

// Announce (0A 4B) handler: the full gated reply path.
void SmartLink::handleLinkPoll(const uint8_t* f) {
    uint32_t now = millis();
    if (forcedQuietUntilMs_ && now < forcedQuietUntilMs_) return;  // sw-replug blackout
    ctrlSeen = true;
    lastCtrlRxMs = now;

    uint32_t nowUs = micros();
    uint32_t idleUs = (lastLinkpollUs_ == 0) ? 0xFFFFFFFFu : (nowUs - lastLinkpollUs_);
    lastLinkpollUs_ = nowUs;

    // Silence between the 02 13 ack and enum: the real brain says NOTHING in
    // the ~99 ms gap; re-replying to announces there resets the controller's
    // half-open handshake (findings, reference/3.csv).
    if (linkAckMs_ != 0 && !linkUp) return;

    // Cold-isolation: answer the ISOLATED cold announce, never the boot flood.
    bool cold = (f[13] == 0x00);
    if (cold && idleUs < COLD_ISOLATION_US) return;

    // Post-reply refractory: exactly one reply pair per announce.
    if (lastReplyUs_ && (nowUs - lastReplyUs_) < REPLY_REFRACTORY_US) return;

    // A linked controller stops announcing; a fresh announce while linkUp
    // means it dropped us — tear down so this reply re-arms a clean bring-up.
    if (linkUp) {
        linkUp = false;
        enumDone_ = false;
        linkAckMs_ = 0;
        lastStreamedMode_ = -1;
    }

    uint8_t r2[LINK16_SIZE];
    build_link_reply2(f, r2);
    const uint8_t* r1 = cold ? LINK_REPLY1_COLD : LINK_REPLY1;
    uint32_t gap = REPLY2_GAP_US + (cold ? COLD_REPLY2_EXTRA_US : 0);

    // HELD DE across the pair: the driver keeps asserting idle-MARK through
    // the inter-reply gap instead of letting the bus float and decay
    // (measured collapse +2.2V -> +0.3V under per-frame toggling; findings
    // espController2/3_analog, 2026-07-05).
    digitalWrite(dePin_, HIGH);
    busWriteHeld(r1, LINK16_SIZE);
    delayMicroseconds(gap);
    busWriteHeld(r2, LINK16_SIZE);
    digitalWrite(dePin_, LOW);
    replyTxCount++;
    lastReplyUs_ = micros();

    // The 02 13 ack lands ~50-370 us after reply2 — catch it inline; the
    // main loop is too slow. (No own-echo to skip on this board: RE is
    // DE-gated, so everything captured here came from the controller.)
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

void SmartLink::handleShortAck(const uint8_t* f) {
    lastCtrlRxMs = millis();
    ctrlSeen = true;
    linkAckCount++;
    if (f[2] == 0x01) sessionAckCount++;  // F3 78 session variant
    // Arm on EITHER ack variant: F3 78 was never the gate — the 86 B9 path
    // is the one that demonstrably drives the controller (findings,
    // 2026-07-06 "REGRESSION FIXED" entry).
    if (!enumDone_ && linkAckMs_ == 0) linkAckMs_ = millis();
}

// Answer the controller's `11` enumeration request: it is ASKING us to
// identify ourselves (findings, esp24). 04 -> 54 -> A3 -> 53 at the captured
// pacing. 54 byte3 = 0x00 (not the June capture's 0x02) was the final key
// that flipped sessions from pack=0 to sustained 50 Hz.
void SmartLink::answerEnumRequest(size_t reqlen, uint32_t now) {
    (void)reqlen;
    enumReqCount++;
    if (forcedQuietUntilMs_ && now < forcedQuietUntilMs_) return;
    if (now - lastEnumAnswerMs_ < 50) return;  // dodge duplicate storms
    lastEnumAnswerMs_ = now;

    busWrite(ENUM_04, FRAME_SIZE);
    delayMicroseconds(1400);
    uint8_t e54[FRAME_SIZE];
    memcpy(e54, ENUM_54, FRAME_SIZE);
    e54[3] = 0x00;
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

// Controller 32-byte frames: acks, the 50 Hz A0/A7 session stream, and the
// 32-byte form of the enum request.
void SmartLink::handleCtrlFrame(const uint8_t* f) {
    uint32_t now = millis();
    lastCtrlRxMs = now;
    ctrlSeen = true;
    if (f[0] == 0x02) pollAckCount++;

    if (linkUp && (f[0] == 0xA7 || f[0] == 0xA0)) {
        pollAckCount++;  // controller status stream = the in-session signal
        // A7-led = full field mode (robot radio linked; states display,
        // robot name at bytes 18..23). A0-led = joystick-only: session up
        // but no field UI possible (findings, esp29/30).
        streamKind = (f[0] == 0xA7) ? 2 : 1;
        if (f[0] == 0xA7) {
            memcpy(robotName, f + 18, 6);
            a0SinceMs_ = 0;
            seenA7_ = true;
        } else if (a0SinceMs_ == 0) {
            a0SinceMs_ = now;
        }
        lastA7TxMs_ = now;   // response-timed; free-run tick only fires when quiet
        streamStatePoll();
    }
    if (f[0] == 0x11) answerEnumRequest(FRAME_SIZE, now);
}

// One steady-state brain slot (brain-accurate model, fullCycleRD):
// disabled -> 02 A7 ack (+ short 53 C9 entry burst); driver/auton -> 53 with
// live ms countdown on 4 of 5 slots, 02 A7 on the 5th.
void SmartLink::streamStatePoll() {
    // Field-mode interlock: commanding driver/auton at an A0-mode controller
    // kicks its robot radio off and can't display anyway (findings, esp34).
    // The commanded state queues and applies when the A7 stream appears.
    uint8_t mode = (streamKind == 2) ? modeFor(g_field_state) : MODE_DISABLED;
    if ((int)mode != lastStreamedMode_) {
        stateEnteredMs_ = millis();
        replySlot_ = 0;
        c53BurstLeft_ = (mode == MODE_DISABLED) ? 3 : 0;
        uint8_t cmd[FRAME_SIZE];
        build_state53(mode, (mode == MODE_DISABLED) ? 0 : matchRemainingMs(), cmd);
        busWrite(cmd, FRAME_SIZE);
        lastStreamedMode_ = mode;
        return;  // transition slot spent on the 53
    }
    if (mode == MODE_DISABLED) {
        // Mostly 02 A7 acks, with a short 53 C9 redundancy burst after entry.
        // CONTINUOUS 53 re-assertion churns the controller<->robot radio
        // (findings, 2026-07-06 late) — burst only.
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

// Software replug (findings, esp35): a session formed before the radio's
// competition-channel hop is stuck in A0 forever; emulate an unplug/replug
// so the fresh handshake forms post-hop and comes up in A7 field mode.
void SmartLink::doSoftReplug(uint32_t now) {
    linkUp = false;
    enumDone_ = false;
    linkAckMs_ = 0;
    lastStreamedMode_ = -1;
    streamKind = 0;
    a0SinceMs_ = 0;
    forcedQuietUntilMs_ = now + SWREPLUG_QUIET_MS;
    swreplugCount++;
    swreplugPending = true;
    while (bus_->available()) bus_->read();
    rxLen_ = 0;
}

void SmartLink::service(uint32_t now) {
    // Bulk-read the ring buffer in one shot (byte-by-byte read() takes a
    // driver mutex per call, ~20 us each — enough to miss reply windows).
    int avail = bus_->available();
    if (avail > 0) {
        size_t space = sizeof(rxBuf_) - rxLen_;
        size_t want = ((size_t)avail < space) ? (size_t)avail : space;
        if (want) rxLen_ += bus_->read(rxBuf_ + rxLen_, want);
    }
    size_t i = 0;
    while (rxLen_ - i >= LINK16_SIZE) {
        bool matched = false;
        // 16-byte frames: announce (0A 4B), handshake ack (02 13), short
        // enum request (11 00). CRC over bytes 0..13.
        if (rxBuf_[i] == LINKPOLL_FIRST ||
            (rxBuf_[i] == 0x02 && rxBuf_[i + 1] == 0x13) ||
            (rxBuf_[i] == 0x11 && rxBuf_[i + 1] == 0x00)) {
            uint16_t c = crc16_ccitt_false(rxBuf_ + i, LINK16_CRC_COV);
            if (rxBuf_[i + 14] == ((c >> 8) & 0xFF) && rxBuf_[i + 15] == (c & 0xFF)) {
                if (rxBuf_[i] == LINKPOLL_FIRST) handleLinkPoll(rxBuf_ + i);
                else if (rxBuf_[i] == 0x11) answerEnumRequest(LINK16_SIZE, now);
                else handleShortAck(rxBuf_ + i);
                i += LINK16_SIZE;
                matched = true;
            }
        }
        if (!matched && rxLen_ - i >= FRAME_SIZE) {
            uint16_t c = crc16_ccitt_false(rxBuf_ + i, CRC_START_INDEX);
            if (rxBuf_[i + 30] == ((c >> 8) & 0xFF) && rxBuf_[i + 31] == (c & 0xFF)) {
                // 32-byte 0A 4B = extended announce; otherwise steady-state.
                if (rxBuf_[i] == LINKPOLL_FIRST) handleLinkPoll(rxBuf_ + i);
                else handleCtrlFrame(rxBuf_ + i);
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

    // Software replug when stuck in A0 joystick-only mode. CAPPED when this
    // engage has never once reached A7 field mode: the replug exists to fix
    // sessions that formed BEFORE the radio's competition-channel hop, but a
    // controller with no radio-tethered robot has no hop coming — endlessly
    // tearing down a healthy A0 session just churns the link (observed
    // live 2026-09-01: 10+ replug cycles, UI flapping no-stream<->A0). Two
    // attempts cover the real pre-hop case; after that, hold the A0 session.
    // A port that HAS reached A7 before keeps unlimited replugs (a real
    // radio exists there, so a later A0 lock-in is worth healing).
    if (linkUp && streamKind == 1 && a0SinceMs_ &&
        (now - a0SinceMs_ >= SWREPLUG_AFTER_MS) &&
        (seenA7_ || swreplugCount < 2)) {
        doSoftReplug(now);
    }

    // Match end: countdown expired while the mode was actually streaming.
    if (g_field_state != STATE_DISABLED &&
        lastStreamedMode_ == (int)modeFor(g_field_state) &&
        matchRemainingMs() == 0) {
        matchEndPending = true;
    }

    // Enum fallback: the controller normally ASKS (11 request at +99 ms after
    // its ack) and we answer response-driven; if no request ever arrives,
    // send the answer burst anyway after 3x the gap so it can't collide with
    // a request in flight. (Replaces the original's legacy timer bring-up.)
    if (linkAckMs_ && !enumDone_ && (now - linkAckMs_ >= 3 * ENUM_AFTER_ACK_MS)) {
        answerEnumRequest(0, now);
        enumDone_ = true;
        linkUp = true;
        lastA7TxMs_ = now;
    }

    // Free-running steady-state tick: only fires when the controller has been
    // quiet for a full period (each received A0/A7 re-anchors lastA7TxMs_).
    if (linkUp && (now - lastA7TxMs_ >= A7_PERIOD_MS)) {
        lastA7TxMs_ = now;
        streamStatePoll();
    }
}
