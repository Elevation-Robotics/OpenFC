/*
 * SPDX-License-Identifier: Apache-2.0
 * Copyright (c) 2026 OpenFC (Elevation Robotics)
 */

#ifndef OPENFC_FRAMES_H
#define OPENFC_FRAMES_H

#include <stdint.h>
#include <stddef.h>
#include <string.h>

#define FRAME_SIZE 32
#define CRC_START_INDEX 30

// A7 state-poll template (Disabled, steady-state), taken verbatim from the
// cold bring-up sniff of the real field-control brain (sniff_20260629_163317).
// byte17=0xFF is the steady-state "field live" marker; the earlier mid-session
// sniff that showed 0x06 was a transitional value.
// build_a7() overwrites bytes 3/6/7 (enable/mode/timer) and recomputes CRC.
// NOTE: bytes 18-22 = "3946R" is the paired robot brain ID for this setup.
// Update those bytes if using a different robot brain.
static const uint8_t FRAME_TEMPLATE[FRAME_SIZE] = {
    0xA7, 0x00, 0x80, 0x10, 0x02, 0x00, 0xC9, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
    0x51, 0xFF, 0x33, 0x39, 0x34, 0x36, 0x52, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x5C, 0xD5
};

// Pre-link A7 sent during enumeration (between ENUM_04 and ENUM_54).
// Has enable=0x30, mode=0x40 (pre-link mode), byte17=0x06 -- verbatim from
// the cold bring-up sniff. After this burst the brain switches to the normal
// disabled A7 (FRAME_TEMPLATE) for steady-state polling.
static const uint8_t ENUM_A7_PRE[FRAME_SIZE] = {
    0xA7, 0x00, 0x80, 0x30, 0x02, 0x00, 0x40, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
    0x11, 0x06, 0x33, 0x39, 0x34, 0x36, 0x52, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xDC, 0x9D
};

// 16-byte controller link poll. In field-control mode this arrives FROM the
// controller; the brain (us) answers it. Kept here as the match signature.
#define POLL16_SIZE 16
#define LINK16_SIZE 16
#define LINK16_CRC_COV 14
#define LINKPOLL_FIRST 0x0A
static const uint8_t POLL16_FRAME[POLL16_SIZE] = {
    0x0A, 0x4B, 0x00, 0x00, 0x09, 0x00, 0x00, 0x40,
    0x30, 0xE9, 0x4B, 0x00, 0x00, 0x00, 0x1E, 0x71
};

// Brain handshake reply #1.  Byte[1] is the cold-link request value 0x0A,
// verbatim from COLD power-on captures of this controller (8E C7 81):
// reference/n1.csv and n2.csv both show 03 0A ...; n3.csv uses 03 05; the WARM
// mid-session capture sniff_20260629_163317.hex used 03 01. With 0x01 cold the
// controller acks the link layer (02 13 ..86 B9, all zero) but NEVER advances to
// the session-established ack (02 13 01.. ..01 F3 78) and refuses enumeration --
// so byte[1]=0x01 is a warm/keepalive-only value. 0x0A is a verified cold value.
// (3.csv used 0x14 for a different controller 30 E9 4B.) CRC recomputed (13 27).
// WARM session-WINNING reply1 from reference/3.csv (controller 30 E9 4B): the
// only reply1 our emulator has sent that the controller acked (86 B9 link). The
// foreign-brain COLD golden frame 03 0A .. 52 30 39 .. 3C 37 (from
// controllerBrain1_digital.csv) was flashed 2026-07-02 and produced SILENCE
// across the whole cold byte13=00 window -- worse than 86 B9 -- then the
// controller latched warm. Reverted to this proven frame. NEW FINDING: in the
// golden capture the WINNING cold announce was ISOLATED (controller idle ~0.82 s
// before it, brain answered 75 us later); our controller instead FLOODS cold
// announces at boot (dozens back-to-back in 90 ms) then ~1/s. The win condition
// is likely an isolated cold announce, not the boot flood we answer into.
static const uint8_t LINK_REPLY1[LINK16_SIZE] = {
    0x03, 0x14, 0x64, 0x00, 0x00, 0x00, 0x00, 0xBA,
    0x00, 0x4A, 0xDB, 0x22, 0x00, 0x00, 0x81, 0xA2
};

// COLD session-WINNING reply1, verbatim from the golden capture
// controllerBrain1_digital.csv (controller 30 E9 4B). In that capture the brain
// answered an ISOLATED COLD announce (byte13=00) with BOTH frames -- this cold
// reply1 (03 0A ..) then reply2 (13 20 ..) -- and the controller returned the
// SESSION ack 02 13 01 .. F3 78. Byte[1]=0x0A is the cold-link request value;
// bytes 9..11 (52 30 39) are that brain's serial. This frame was flashed alone
// on 2026-07-02 and produced SILENCE, but that predates the DE-mode fix so its
// reply2 arrived CORRUPTED; esp13_digital.csv (2026-07-03) proves the TOGGLE
// path now delivers reply2 byte-perfect to the controller's receiver, so the
// cold reply1 + clean reply2 pair has not yet been tested in a real cold window.
// Selected at runtime via g_reply1_cold ({"cmd":"reply1","cold":1}). CRC 3C 37.
static const uint8_t LINK_REPLY1_COLD[LINK16_SIZE] = {
    0x03, 0x0A, 0x64, 0x00, 0x00, 0x00, 0x00, 0xBA,
    0x00, 0x52, 0x30, 0x39, 0x00, 0x00, 0x3C, 0x37
};

// Brain handshake reply #2 template. Bytes 4..6 echo the controller's 3-byte
// ID copied from the link poll (bytes 8..10); build_link_reply2() fills them.
static const uint8_t LINK_REPLY2_TMPL[LINK16_SIZE] = {
    0x13, 0x20, 0x00, 0x00, 0x30, 0xE9, 0x4B, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC7, 0xF9
};

// 32-byte enumeration descriptors the brain streams after the handshake
// (verbatim from the wired capture; already CRC-valid).
static const uint8_t ENUM_11[FRAME_SIZE] = {
    0x11, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xB2, 0xAA
};
static const uint8_t ENUM_04[FRAME_SIZE] = {
    0x04, 0x00, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xF5, 0x6B
};
// byte3 = 0x02, verbatim from cold disabled bringup (sniff_20260629_163317).
// byte3=0x03 is for driver bringup -- using 0x03 during disabled bringup
// causes the controller to reject the sequence and not send 02 A7.
static const uint8_t ENUM_54[FRAME_SIZE] = {
    0x54, 0x09, 0x00, 0x02, 0xC9, 0x36, 0xB8, 0x50, 0x58, 0x39, 0x00, 0xEE, 0xFE, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xD5, 0xB6
};
static const uint8_t ENUM_A3[FRAME_SIZE] = {
    0xA3, 0x17, 0x00, 0x00, 0xAA, 0x5E, 0x58, 0x13, 0x39, 0x0C, 0x00, 0x04, 0x00, 0x06, 0x00, 0x02,
    0x40, 0x01, 0x40, 0x00, 0x40, 0x00, 0x40, 0x30, 0x30, 0xFC, 0x09, 0x00, 0x00, 0x00, 0xC0, 0xDE
};

// Brain steady-state ack/poll (fullCycleRD.csv, 2026-07-06 analysis): in an
// established session the BRAIN transmits this 02 A7 frame ~0.5 ms after each
// controller A7 status frame (the controller, not the brain, streams the A7
// status at 50 Hz -- our old model had the direction inverted, which made the
// controller display the "tethered to another controller" icon). Invariant
// across disabled/driver/auton; n=1051 in the capture, byte-constant.
static const uint8_t ACK_A7[FRAME_SIZE] = {
    0x02, 0xA7, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xB8, 0x0C
};

// Byte positions
#define POS_ENABLE 3
#define POS_MODE 6
#define POS_TIMER 7

// States
typedef enum {
    STATE_DISABLED,
    STATE_DRIVER,
    STATE_AUTON
} openfc_state_t;

// State values
#define ENABLE_DISABLED 0x10
#define ENABLE_ENABLED  0x30

#define MODE_DISABLED   0xC9
#define MODE_DRIVER     0xE1
#define MODE_AUTON      0xD1

#define TIMER_DRIVER_START 0x69 // 105s
#define TIMER_AUTON_START  0x0F // 15s

/**
 * CRC-16/CCITT-FALSE over bytes[0..29]
 * Polynomial: 0x1021, Init: 0xFFFF, RefIn/RefOut: false, XorOut: 0x0000
 */
inline uint16_t crc16_ccitt_false(const uint8_t *d, size_t n) {
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < n; i++) {
        crc ^= (uint16_t)d[i] << 8;
        for (int b = 0; b < 8; b++) {
            if (crc & 0x8000) {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc = (crc << 1);
            }
        }
    }
    return crc;
}

/**
 * Build brain handshake reply #2, echoing the controller's 3-byte ID from the
 * received 16-byte link poll (poll bytes 8..10 -> reply bytes 4..6), then
 * recomputing the 16-byte CRC over bytes 0..13.
 */
inline void build_link_reply2(const uint8_t *poll, uint8_t out[LINK16_SIZE]) {
    memcpy(out, LINK_REPLY2_TMPL, LINK16_SIZE);
    out[4] = poll[8];
    out[5] = poll[9];
    out[6] = poll[10];
    uint16_t crc = crc16_ccitt_false(out, LINK16_CRC_COV);
    out[14] = (crc >> 8) & 0xFF;
    out[15] = crc & 0xFF;
}

/** Build a 0x53 match-state frame (disabled/driver/auton).
 *
 * fullCycleRD.csv (2026-07-06 re-analysis): bytes 4..6 are a 24-bit
 * little-endian countdown in MILLISECONDS of the remaining period, ticking in
 * real time while enabled (driver started at 0x0128DF = 75999 ms; auton at
 * 0x00B3AF = 45999 ms; disabled holds 0). The earlier reading of byte6 as a
 * "driver flag" was just the high byte of a >65 s driver period. The real
 * brain streams this frame every ~20 ms while enabled (4 of every 5 reply
 * slots; the 5th is the 02 A7 ack) and sends it ONCE on entering disabled. */
inline void build_state53(uint8_t mode, uint32_t remaining_ms, uint8_t out[FRAME_SIZE]) {
    memset(out, 0, FRAME_SIZE);
    out[0] = 0x53;
    out[1] = mode;
    out[4] = remaining_ms & 0xFF;
    out[5] = (remaining_ms >> 8) & 0xFF;
    out[6] = (remaining_ms >> 16) & 0xFF;
    out[8] = 0x03;
    uint16_t crc = crc16_ccitt_false(out, CRC_START_INDEX);
    out[30] = (crc >> 8) & 0xFF;
    out[31] = crc & 0xFF;
}

#endif // OPENFC_FRAMES_H
