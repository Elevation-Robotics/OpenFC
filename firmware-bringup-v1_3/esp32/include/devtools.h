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
// Development tools (bus capture, A<->B relay), compiled in only when
// OPENFC_DEVTOOLS is 1. main.cpp calls in through these hooks and provides
// the main* services below; with the flag at 0 none of this exists and the
// capture and relay commands answer unknown_command.

#pragma once

#include <ArduinoJson.h>
#include "openfc_spi_link.h"

#ifndef OPENFC_DEVTOOLS
#define OPENFC_DEVTOOLS 0
#endif

#if OPENFC_DEVTOOLS

void devtoolsBegin();                                    // setup(): allocate the capture ring
void devtoolsCapSink(char port, bool tx, const uint8_t* b, size_t n, uint32_t tUs);
void devtoolsService();                                  // loop(): drain the ring to the host
bool devtoolsCommand(const char* cmd, const JsonDocument& doc);  // true if handled
void devtoolsOnRp2350Reset();

// Provided by main.cpp.
bool mainFieldEngaged();
bool mainRp2350Run();
void mainEmitError(const char* reason, const char* cmd);
bool mainSpiRequest(uint8_t cmd, const uint8_t* payload, uint8_t len, SpiLinkFrame* result,
                    uint32_t timeoutMs);

#endif
