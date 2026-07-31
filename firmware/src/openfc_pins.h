// OpenFC v1 — pin map, board constants and the shared State enum.
//
// Pins are from SCH_Schematic1_2026-05-30 (board JLCPCB-002,
// ESP32-S3-WROOM-1-N16R8, U61). The board drives 4 VEX V5 Competition Switch
// ports in unison through PC817C optocouplers. Each port exposes two signals:
//   ED = ENABLE/DISABLE (V5 Competition Switch pin)
//   AD = DRIVER/AUT     (V5 Competition Switch pin)
//
// Drive sense was verified empirically per-port against a live V5 (2026-06):
//   ENABLE/DISABLE: HIGH = Disabled (safe), LOW = Enabled
//   DRIVER/AUT:     HIGH = Autonomous,      LOW = Driver
// (The two signals have opposite "safe" levels, so they are driven explicitly
// rather than through a single shared OPTO_ON/OPTO_OFF sense.)

#pragma once

#include <Arduino.h>

namespace openfc {

// Board state machine. Shared by main.cpp.
// Enumerators are prefixed S_ to avoid colliding with Arduino GPIO macros such
// as `#define DISABLED 0x00` in esp32-hal-gpio.h (the preprocessor rewrites the
// bare token before the scoped enum is seen). The wire-protocol strings in
// stateName() are unchanged ("DISABLED", "ENABLED_DRIVER", ...).
enum class State {
    S_BOOT,
    S_DISABLED,
    S_ENABLED_DRIVER,
    S_ENABLED_AUTO,
    S_ESTOP_WATCHDOG,
};

const char* stateName(State s);
String getDeviceId();
String getAppHash();

}  // namespace openfc

// ─── Drive levels ─────────────────────────────────────────────────────────
// Generic HIGH/LOW aliases. Note the two V5 signals use these with opposite
// "safe" polarity (see the per-signal table above): ENABLE/DISABLE is safe
// (Disabled) at HIGH, DRIVER/AUT is safe (Driver) at LOW.
#define OPTO_ON   HIGH
#define OPTO_OFF  LOW

// ─── Port GPIOs (4 ports, controlled in unison) ───────────────────────────
// Functional map verified empirically per port against a live V5 (2026-06):
//   Port 1: IO7  ENABLE/DISABLE   IO15 DRIVER/AUT
//   Port 2: IO16 ENABLE/DISABLE   IO17 DRIVER/AUT
//   Port 3: IO18 ENABLE/DISABLE   IO8  DRIVER/AUT
//   Port 4: IO19 ENABLE/DISABLE   IO20 DRIVER/AUT
// NOTE: IO19/IO20 are the ESP32-S3 native USB D-/D+ pins, used here as ordinary
// GPIO outputs (Port-4 E/D and D/A), which is why native USB-Serial-JTAG is
// unusable and all serial runs over the CH340C on UART0 (IO43/IO44).
static const int PINS_AD[4] = { 15, 17, 8, 20 };   // DRIVER/AUT     ports 1..4
static const int PINS_ED[4] = { 7, 16, 18, 19 };   // ENABLE/DISABLE ports 1..4

// ─── Inputs ───────────────────────────────────────────────────────────────
// SW2 = BOOT (IO0). SW1 is the hardware RESET (EN), not MCU-readable.
static const int PIN_BOOT_BTN = 0;

// NOTE: This board has no MCU-controlled RGB status LED and no battery-sense
// ADC. LED1/LED2 are driven by the CH340C auto-reset transistors, LED3 is the
// 3V3 power indicator, and the TP4056 charge status is not wired to a GPIO
// (spec §5.2, §14). State/battery LED + ADC code is therefore omitted.

// ─── Timing constants (ms) ────────────────────────────────────────────────
static const uint32_t WATCHDOG_TIMEOUT_MS   = 600;    // comms watchdog (manual mode)
static const uint32_t HEARTBEAT_INTERVAL_MS = 1000;
static const uint32_t IDENTIFY_DURATION_MS  = 3000;

// ─── Timed-period limits (spec §5.1) ──────────────────────────────────────
static const uint32_t PERIOD_MIN_MS    = 1;
static const uint32_t PERIOD_MAX_MS    = 600000;   // 10 minutes
static const uint32_t TWDT_BACKSTOP_MS = 10000;    // duration_ms + this = TWDT
