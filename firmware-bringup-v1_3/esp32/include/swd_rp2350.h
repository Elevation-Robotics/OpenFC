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
// ESP32-bitbanged SWD programmer for the on-board RP2350 "Serial Expander".
//
// The V1_3 board wires the RP2350's SWD pins to this ESP32 (netlist: SWCLK =
// U19 pin35 = IO42, SWDIO = pin34 = IO41, both through 33R series R58/R59),
// plus RUN and a GPIO handshake line — the designed path for the ESP32 to
// program and supervise the RP2350 with no external probe. This module
// implements the minimum of ARM ADIv6 SWD + the RP2350 bootrom's resident
// flash functions to program the chip's internal QSPI flash.
//
// The flash-programming recipe is a direct port of the authoritative
// implementation in raspberrypi/openocd's src/flash/nor/rp2040.c
// (sdk-2.0.0 branch), including its three RP2350-specific requirements:
//   1. ACCESSCTRL permissions reset (password write to CFGRESET),
//   2. flipping core0 into the Secure domain via DSCSR.CDS before running
//      any code,
//   3. running an RCP-init stub before any bootrom call (the redundancy
//      coprocessor faults all bootrom code until seeded).
// Plus one community-sourced quirk: MEM-AP CSW.PROT must be 0x23 on RP2350
// or SRAM/flash accesses fail (raspberrypi forum t=380245). Bit-banged
// SWCLK lands well under the ~250 kHz ceiling that applies while the blank
// chip sits in its BOOTSEL wait loop.
//
// Usage (from main.cpp command handlers):
//   swdProbe(&info)            — connect + identify; safe any time
//   swdFlashBegin(totalSize)   — full init + erase; halts the RP2350
//   swdFlashData(buf, n)       — stream firmware bytes (any chunking)
//   swdFlashEnd()              — program tail, flush, reboot RP2350 into it

#pragma once

#include <Arduino.h>

struct SwdProbeInfo {
    bool ok = false;
    uint32_t dpidr = 0;
    uint32_t ctrlstat = 0;
    uint32_t bootromMagic = 0;   // expect 0x02754d in the low 3 bytes
    bool pinsSwapped = false;    // true if SWCLK/SWDIO only worked swapped
    const char* fail = "";       // failing stage name when !ok
};

bool swdProbe(SwdProbeInfo* info);

// Begin a flash session: connect, halt core0, ACCESSCTRL/Secure/RCP init,
// bootrom state reset, connect_internal_flash + flash_exit_xip, then erase
// ceil(totalSize / 4K) * 4K from flash offset 0. Returns false with *fail
// set on error. The RP2350 stays halted until swdFlashEnd().
bool swdFlashBegin(uint32_t totalSize, const char** fail);
// Stream firmware image bytes in order. Internally buffered and programmed
// in 4 KB chunks via the bootrom's flash_range_program.
bool swdFlashEnd(const char** fail);
bool swdFlashData(const uint8_t* data, size_t n, const char** fail);
// Bytes accepted so far (for host-side progress display).
uint32_t swdFlashCount();
// Step-by-step diagnostic; writes key=hex pairs into out.
void swdDiag(char* out, size_t outCap);
// Non-intrusive bus read while the RP2350 runs.
bool swdMemPeek(uint32_t addr, uint32_t* val);
