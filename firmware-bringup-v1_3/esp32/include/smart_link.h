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
// V5 Smart-port field-control session engine, one instance per RS-485 port
// (A and B here; C/D run the same logic on the RP2350, smart_link_rp.*).
//
// Modelled on a relay recording of a real VEX field controller talking to a
// V5 controller (2026-09-27; see openfc_frames.h for the exchange table).
// The controller leads: it announces, identifies itself, requests
// enumeration and then streams A0/A7 status at 50 Hz. The engine answers
// every controller frame exactly once with the frame the field controller
// sent in that position, and sends nothing unprompted.
//
// Replaces the earlier brain-emulator model (OpenFC-Smart), which sent the
// controller's own 13 20 and A3 frames itself, answered announces with a
// reply pair, and assumed field mode (A7) needed a radio-linked robot. The
// recording showed A7 with no robot linked.

#pragma once

#include <Arduino.h>
#include <driver/uart.h>
#include "openfc_frames.h"
#include "openfc_capture.h"

// Global field state shared by all port engines (a field controller drives
// every port in unison). Defined in main.cpp.
extern openfc_state_t g_field_state;
extern uint32_t g_driver_period_ms;
extern uint32_t g_auton_period_ms;
// true: stream Disabled to a controller that is not in A7 field mode, and
// hold driver/auton until it is. false (default): stream the commanded state
// to any linked controller.
extern bool g_field_interlock;

class SmartLink {
public:
    void begin(HardwareSerial* bus, uart_port_t uartNum, int dePin, char portName);
    // Reset all session state (called on engage and disengage).
    void reset(uint32_t now);
    // Run RX. Call every loop iteration while the field is engaged.
    void service(uint32_t now);

    // Set when this port's countdown expires; main.cpp consumes it and drops
    // g_field_state to disabled (first port to finish ends the match).
    bool matchEndPending = false;
    // Kept for the host event; the engine no longer replugs.
    bool swreplugPending = false;

    // Every byte read from or written to the bus goes here when set.
    CapSink capSink = nullptr;

    // ─── Status (read by main.cpp's heartbeat) ───
    char name = '?';
    bool linkUp = false;
    int streamKind = 0;            // 0=none, 1=A0 joystick-only, 2=A7 field mode
    char robotName[7] = {0};
    uint32_t lastCtrlRxMs = 0;
    uint32_t linkAckCount = 0;     // session acks sent (answers to 13 20)
    uint32_t sessionAckCount = 0;  // same count; kept for the status fields
    uint32_t pollAckCount = 0;     // A0/A7 status frames received ("pack")
    uint32_t replyTxCount = 0;     // announces answered
    uint32_t enumReqCount = 0;     // 11 enumeration requests received
    uint32_t swreplugCount = 0;

    bool ctrlPresent(uint32_t now) const {
        return ctrlSeen_ && (now - lastCtrlRxMs) < 400;
    }

private:
    enum Stage : uint8_t {
        ST_IDLE,        // nothing yet, or mid-session after a reset
        ST_HELLO,       // answered an announce, waiting for 13 20
        ST_ACKED,       // sent the session ack, waiting for 11
        ST_SENT04,      // answered 11 with 04, waiting for 02 04
        ST_WANT54,      // next A7/A0 gets the 54 descriptor
        ST_SENT54,      // waiting for 02 54, then A3
        ST_ENUMERATED,  // A3 acknowledged; next status frame gets the state
    };

    void busWrite(const uint8_t* f, size_t n);
    void onFrame(const uint8_t* f, size_t n, uint32_t now);
    void streamStatePoll();
    uint32_t matchRemainingMs() const;

    HardwareSerial* bus_ = nullptr;
    uart_port_t uartNum_ = UART_NUM_1;
    int dePin_ = -1;

    uint8_t rxBuf_[512];
    size_t rxLen_ = 0;

    Stage stage_ = ST_IDLE;
    bool ctrlSeen_ = false;

    int lastStreamedMode_ = -1;
    uint8_t replySlot_ = 0;
    uint8_t echoMode_ = 0;         // mode the controller reports in A7 byte 6
    uint8_t since53_ = 0;          // frames since our last 53
    uint32_t stateEnteredMs_ = 0;  // per-port 53 countdown base
};
