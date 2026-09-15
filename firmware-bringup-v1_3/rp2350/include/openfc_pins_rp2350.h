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
// OpenFC V1_3 BRING-UP firmware — pin map (RP2350 "Serial Expander" side).
//
// From RP2350 Serial Expander.schdoc's own pin labels (U6, RP2354A). This
// chip owns Smart ports C/D and is reached by the ESP32-S3 over SPI — see
// ../../esp32/include/openfc_pins_v13.h for that side and
// openfc_spi_link.h for the wire framing between the two.
//
// GPIO16/17/18/19 were very likely chosen deliberately: they are RP2350's
// native SPI0 function-select pins (RX/CSn/SCK/TX in the RP2040/RP2350 GPIO
// mux, where "RX"/"TX" are from the peripheral's own perspective — as a
// SLAVE, RX=data in=MOSI, TX=data out=MISO), which lines up exactly with
// this board's MOSI/CS/SCLK/MISO nets on those same pins. That is why this
// firmware drives spi0 directly via the Pico SDK's hardware/spi.h in slave
// mode, rather than bit-banging or using PIO — UNVERIFIED ON REAL HARDWARE
// YET, this is the Phase-3 "spike" the plan calls for. If spi_set_slave()
// does not behave as expected on this board, the fallback is a UART link
// between the two MCUs instead (would need a schematic/rewire change, not
// just firmware).

#pragma once

#include <Arduino.h>

// ─── RS-485 Smart ports C/D ───────────────────────────────────────────────
static const int PIN_RS485C_TX = 0;
static const int PIN_RS485C_RX = 1;
static const int PIN_RS485C_DE = 2;
static const int PIN_RS485D_TX = 4;
static const int PIN_RS485D_RX = 5;
static const int PIN_RS485D_DE = 6;

// ─── ESP32 link ────────────────────────────────────────────────────────
// Netlist (RP2350 Serial Expander.schdoc, U6): GPIO8 pin12 RP2350_IRQ ->
// ESP32 IO21; GPIO10 pin14 ESP_READY <- ESP32 IO40; GPIO20 pin32
// RP2350_BOOT_CTRL <- ESP32 IO7 (plain GPIO — not wired to QSPI_SS/BOOTSEL).
static const int PIN_IRQ_OUT     = 8;   // to ESP32's RP2350_IRQ input
static const int PIN_ESP_READY   = 10;  // in, from the ESP32
static const int PIN_BOOT_CTRL   = 20;  // in, from the ESP32 (spare signal)

// SPI0 slave pins (see the note above on why these specific GPIOs).
static const int PIN_SPI_MOSI = 16;  // SPI0 RX (data in, from ESP32's perspective: its MOSI)
static const int PIN_SPI_CS   = 17;  // SPI0 CSn
static const int PIN_SPI_SCLK = 18;  // SPI0 SCK
static const int PIN_SPI_MISO = 19;  // SPI0 TX (data out)

static const uint32_t RS485_RX_WINDOW_MS = 50;
