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
// OpenFC V1_3 BRING-UP firmware — pin map (ESP32-S3 side).
//
// NOT the production board. This targets the new prototype
// "Open_FC_V1_3 REV A" schematic (Open_FC_V1 SCH REV 003, 2026-08-10), which
// is a materially different, dual-MCU design: this ESP32-S3-WROOM handles
// the 4 legacy V5 Competition-Switch ports and RS-485 Smart ports A/B
// directly, while a second MCU (RP2350, "Serial Expander") handles Smart
// ports C/D over SPI. See firmware-bringup-v1_3/rp2350/ for that side.
//
// Pins below are read directly off the schematic's own netlist (the
// PIU19xxx pin<->net tokens embedded in the PDF), NOT off the PCB
// silkscreen or the visual pinout — the silkscreen labels "IO12"/"IO13"
// near the two spare buttons (SW3/SW4) appear stale; the netlist ties those
// buttons to IO36/IO37 and IO12 is actually the SPI SCLK line to the
// RP2350. Reconcile against a real board before trusting silkscreen text
// here for anything.
//
// Legacy port polarity (a new AO3400A/PC817C stage vs. the v1.1 board's
// direct GPIO->opto drive) was CONFIRMED against a live V5 on the bench
// 2026-09-01 — the v1.1 board's sense carries over unchanged. RS-485 Smart
// ports A-D are NOT yet confirmed to speak the same wire protocol the
// legacy ports do (see the note on rs485_linktest in ../src/main.cpp).

#pragma once

#include <Arduino.h>

namespace openfc_bringup {

String getDeviceId();

}  // namespace openfc_bringup

// ─── Legacy V5 Competition-Switch ports (4, driven in unison) ────────────
// Both nets are single/shared across all 4 legacy RJ11 ports (RJ1..RJ4) —
// there is no per-port control on this board, same as the v1.1 design.
// Polarity CONFIRMED against a live V5 on the bench (2026-09-01): the
// v1.1 board's sense (ENABLE/DISABLE HIGH=Disabled, DRIVER/AUT HIGH=Auto)
// carries over unchanged to this AO3400A-driven stage.
static const int PIN_LEGACY_ED = 47;   // ENABLE/DISABLE, shared, all 4 ports
static const int PIN_LEGACY_AD = 48;   // DRIVER/AUT,     shared, all 4 ports

#define LEGACY_OPTO_ON   HIGH
#define LEGACY_OPTO_OFF  LOW

// ─── RS-485 Smart ports A/B (direct on this MCU; C/D are on the RP2350) ──
// Jack order on the REV A board, bottom to top: B, A, D, C (bench, 2026-09-26).
static const int PIN_RS485A_TX = 17;
static const int PIN_RS485A_RX = 18;
static const int PIN_RS485A_DE = 4;
static const int PIN_RS485B_TX = 15;
static const int PIN_RS485B_RX = 16;
static const int PIN_RS485B_DE = 5;

// ─── RP2350 link (SPI master out to the "Serial Expander") ───────────────
// Pins re-read from the schematic's per-sheet netlist (Processor.schdoc,
// U19 pins 18-23) on 2026-09-08 after the first bring-up pass had them
// shifted by one (CS on 11, MOSI 13, MISO 14, IRQ 35): the RP2350 saw its
// CS pad permanently low because nothing drove IO10.
//   U19-18 IO10 RP2350_CS   -> U6-28 GPIO17 (SPI0 CSn)
//   U19-19 IO11 MOSI        -> U6-27 GPIO16 (SPI0 RX)
//   U19-20 IO12 SCLK  (R38) -> U6-29 GPIO18 (SPI0 SCK)
//   U19-21 IO13 MISO        <- U6-31 GPIO19 (SPI0 TX)
//   U19-23 IO21 RP2350_IRQ  <- U6-12 GPIO8
static const int PIN_RP2350_CS        = 10;  // SPI CS, active low
static const int PIN_SPI_MOSI         = 11;
static const int PIN_SPI_SCLK         = 12;
static const int PIN_SPI_MISO         = 13;
static const int PIN_RP2350_IRQ       = 21;  // in: RP2350 has unsolicited data
static const int PIN_RP2350_RUN       = 6;   // out: RP2350 RUN (active-low reset, R39 10K pull-up)
// Netlist: IO7 goes straight to RP2350 GPIO20 — a plain firmware-readable
// GPIO. QSPI_SS/BOOTSEL (U6-60) and USB D+/D- are unconnected, so there is
// no hardware path into the RP2350's USB bootloader; SWD (IO41/IO42) is the
// only programming path.
static const int PIN_RP2350_BOOT_CTRL = 7;   // out: RP2350 GPIO20 (spare signal)
static const int PIN_ESP_READY        = 40;  // out: tells the RP2350 we've booted (RP2350 GPIO10)

// ─── NeoPixel status (3x SK6812RGBW, level-shifted 3V3->5V via Q5) ───────
// Named PIN_WS2812_DATA rather than PIN_NEOPIXEL: the esp32-s3-devkitc-1
// board variant's pins_arduino.h already #defines PIN_NEOPIXEL (its own
// onboard RGB LED, GPIO48 on the devkit, irrelevant on this custom board),
// and the preprocessor rewrites our identifier before the compiler ever
// sees it — same class of collision the certified openfc_pins.h documents
// for the `DISABLED` enumerator.
static const int PIN_WS2812_DATA = 8;
static const int NEOPIXEL_COUNT  = 3;

// ─── Buttons ───────────────────────────────────────────────────────────
// SW2 = BOOT (also the standard Arduino-ESP32 boot strap pin). SW1 is the
// hardware RESET (EN), not MCU-readable, same as the v1.1 board.
static const int PIN_BOOT_BTN = 0;
static const int PIN_BTN1     = 36;  // SW3
static const int PIN_BTN2     = 37;  // SW4

// ─── Timing ────────────────────────────────────────────────────────────
static const uint32_t HEARTBEAT_INTERVAL_MS = 1000;
static const uint32_t IDENTIFY_DURATION_MS  = 3000;
static const uint32_t RS485_RX_WINDOW_MS    = 50;   // raw-echo capture window
