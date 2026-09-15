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
// V5 Smart-port field-control session engine — a per-port port of the
// PROVEN OpenFC-Smart brain emulator (OpenFC-Smart/firmware/src/main.cpp as
// of its 2026-07-06 fully-working state), reshaped as a class so one
// instance runs per RS-485 port (A and B here; C/D later via the RP2350).
//
// What is kept, verbatim in behavior (each was individually hard-won —
// see OpenFC-Smart/docs/openfc-bringup-findings.md before changing ANY):
//   - Announce reply pair with AUTO cold/warm reply1 (byte13), HELD DE,
//     62 us reply gap (+100 us cold extra), 120 ms cold-isolation gate,
//     250 ms post-reply refractory, silence between 02 13 ack and enum.
//   - Inline 700 us post-reply ack capture (the ack lands ~50-370 us after
//     reply2 — too fast for the main loop to catch).
//   - Response-driven enumeration: answer the controller's `11` request
//     (both 16- and 32-byte forms) with 04 -> 54(byte3=0x00, re-CRC'd) ->
//     A3 -> 53, at the captured ~1 ms pacing. NEVER send an 11-led or
//     A7-led frame. The 54 byte3 patch was the final key to sessions.
//   - Brain-accurate steady state: the CONTROLLER streams A0/A7 at 50 Hz;
//     we answer each with 02 A7 (disabled; plus a 3-frame 53 C9 entry
//     burst) or 53-with-live-ms-countdown on 4 of 5 slots (driver/auton).
//   - Field-mode interlock: driver/auton only stream once the A7 stream
//     (robot radio in field mode) is present; commanded states queue in
//     A0 joystick-only mode. Software replug self-heals A0 lock-in.
//   - Match-end auto-disable when the countdown reaches 0.
//   - Relink on announce-while-linked; arm bring-up on EITHER 02 13 ack
//     variant (86 B9 or F3 78 — F3 78 was never the gate).
//
// Deliberately dropped from the original: the experiment scaffolding
// (sniffer, injtest, hstest, reply/DE mode selectors, cold-probe, engage-
// settle) and the legacy non-brain-accurate model. One behavioral delta:
// the original flushed the RX FIFO after every TX to drop its own echo
// (its transceiver's RE was hard-enabled); this board's THVD2450 RE is
// gated by DE, so there IS no echo — the flushes are omitted rather than
// risk eating a controller byte that lands right after our TX.

#pragma once

#include <Arduino.h>
#include <driver/uart.h>
#include "openfc_frames.h"

// Global field state shared by all port engines (a field controller drives
// every port in unison). Defined in main.cpp.
extern openfc_state_t g_field_state;
extern uint32_t g_driver_period_ms;
extern uint32_t g_auton_period_ms;

class SmartLink {
public:
    void begin(HardwareSerial* bus, uart_port_t uartNum, int dePin, char portName);
    // Reset all session state (called on engage and disengage).
    void reset(uint32_t now);
    // Run RX + timers. Call every loop iteration while the field is engaged.
    void service(uint32_t now);

    // Set when this port's countdown expires; main.cpp consumes it and drops
    // g_field_state to disabled (first port to finish ends the match).
    bool matchEndPending = false;
    // Set when the software-replug fires, for a host event.
    bool swreplugPending = false;

    // ─── Status (read by main.cpp's heartbeat) ───
    char name = '?';
    bool linkUp = false;
    int streamKind = 0;            // 0=none, 1=A0 joystick-only, 2=A7 field mode
    char robotName[7] = {0};
    uint32_t lastCtrlRxMs = 0;
    uint32_t linkAckCount = 0;     // 02 13 acks (either variant)
    uint32_t sessionAckCount = 0;  // 02 13 with session flag (F3 78)
    uint32_t pollAckCount = 0;     // in-session signal count ("pack")
    uint32_t replyTxCount = 0;
    uint32_t enumReqCount = 0;
    uint32_t swreplugCount = 0;

    bool ctrlPresent(uint32_t now) const {
        return ctrlSeen && (now - lastCtrlRxMs) < 400;
    }

private:
    void busWrite(const uint8_t* f, size_t n);       // DE-gated single frame
    void busWriteHeld(const uint8_t* f, size_t n);   // caller holds DE
    void handleLinkPoll(const uint8_t* f);
    void handleShortAck(const uint8_t* f);
    void handleCtrlFrame(const uint8_t* f);
    void answerEnumRequest(size_t reqlen, uint32_t now);
    void streamStatePoll();
    uint32_t matchRemainingMs() const;
    void doSoftReplug(uint32_t now);

    HardwareSerial* bus_ = nullptr;
    uart_port_t uartNum_ = UART_NUM_1;
    int dePin_ = -1;

    uint8_t rxBuf_[512];
    size_t rxLen_ = 0;

    // Link state machine
    uint32_t linkAckMs_ = 0;       // when the 02 13 ack armed the bring-up
    bool enumDone_ = false;
    bool ctrlSeen = false;
    uint32_t lastLinkpollUs_ = 0;  // cold-isolation reference
    uint32_t lastReplyUs_ = 0;     // refractory reference
    uint32_t lastEnumAnswerMs_ = 0;
    uint32_t lastA7TxMs_ = 0;      // free-run steady-state tick anchor

    // Steady-state / interlock
    int lastStreamedMode_ = -1;
    uint8_t replySlot_ = 0;
    uint8_t c53BurstLeft_ = 0;
    uint32_t stateEnteredMs_ = 0;  // per-port 53 countdown base
    uint32_t a0SinceMs_ = 0;
    uint32_t forcedQuietUntilMs_ = 0;
    bool seenA7_ = false;          // this engage has reached field mode at least once
};
