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
// RP2350 (arduino-pico) port of the V5 Smart-port field-control session
// engine — the same proven OpenFC-Smart protocol logic as the ESP32-side
// copy in ../../esp32/{include,src}/smart_link.*, with only the platform
// glue changed: SerialUART instead of ESP32 HardwareSerial, and flush()
// (which on arduino-pico blocks until the shift register drains) instead
// of uart_wait_tx_done(). Keep the protocol logic in the two copies in
// sync by hand; the ESP32 copy's comments are the authoritative ones.

#pragma once

#include <Arduino.h>
#include "openfc_frames.h"

extern openfc_state_t g_field_state;
extern uint32_t g_driver_period_ms;
extern uint32_t g_auton_period_ms;

class SmartLinkRp {
public:
    void begin(SerialUART* bus, int dePin, char portName);
    void reset(uint32_t now);
    void service(uint32_t now);

    bool matchEndPending = false;

    char name = '?';
    bool linkUp = false;
    int streamKind = 0;
    uint32_t lastCtrlRxMs = 0;
    uint32_t linkAckCount = 0;
    uint32_t sessionAckCount = 0;
    uint32_t pollAckCount = 0;
    uint32_t replyTxCount = 0;
    uint32_t enumReqCount = 0;
    uint32_t swreplugCount = 0;

private:
    void busWrite(const uint8_t* f, size_t n);
    void handleLinkPoll(const uint8_t* f);
    void handleShortAck(const uint8_t* f);
    void handleCtrlFrame(const uint8_t* f);
    void answerEnumRequest(uint32_t now);
    void streamStatePoll();
    uint32_t matchRemainingMs() const;

    SerialUART* bus_ = nullptr;
    int dePin_ = -1;
    uint8_t rxBuf_[512];
    size_t rxLen_ = 0;
    uint32_t linkAckMs_ = 0;
    bool enumDone_ = false;
    bool ctrlSeen_ = false;
    uint32_t lastLinkpollUs_ = 0;
    uint32_t lastReplyUs_ = 0;
    uint32_t lastEnumAnswerMs_ = 0;
    uint32_t lastA7TxMs_ = 0;
    int lastStreamedMode_ = -1;
    uint8_t replySlot_ = 0;
    uint8_t c53BurstLeft_ = 0;
    uint32_t stateEnteredMs_ = 0;
    uint32_t a0SinceMs_ = 0;
    uint32_t forcedQuietUntilMs_ = 0;
    bool seenA7_ = false;
};
