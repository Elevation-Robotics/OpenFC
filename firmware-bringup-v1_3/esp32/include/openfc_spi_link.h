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
// OpenFC V1_3 BRING-UP — ESP32<->RP2350 SPI link framing.
//
// IDENTICAL COPY lives in firmware-bringup-v1_3/rp2350/include/. Keep the
// two in sync by hand (no shared build system between the two PlatformIO
// projects); this file has no logic beyond constants/struct layout/checksum,
// so drift is low-risk but should still be checked if either side changes.
//
// The ESP32 is always the SPI master (it owns the clock); the RP2350 is a
// slave, so it cannot push a response the instant one is ready — the master
// has to come back and ask for it. Two transaction shapes, both fixed-size
// so a naive fixed-length SPI.transfer() works on both ends:
//
//   REQUEST (master->slave, SPI_LINK_FRAME_LEN bytes):
//     [0] cmd        (SpiLinkCmd)
//     [1] port       ('C' or 'D'; 0 if the command doesn't need one)
//     [2] flags      (bit0 = DE state to drive for RS485_RAW's send)
//     [3] len        (payload bytes that follow, 0..SPI_LINK_MAX_PAYLOAD)
//     [4..4+len-1]   payload
//     [last]         checksum: 8-bit sum of every byte before it, mod 256
//   MISO during a REQUEST is ignored filler (slave clocks out 0xFF).
//
//   RESULT POLL (master->slave, cmd=SPI_CMD_GET_RESULT, same frame length,
//   len=0): master clocks the same fixed length; slave uses this same
//   transaction to clock its buffered result out on MISO, framed the same
//   way but read from the slave's last-computed response:
//     [0] status     (SpiLinkStatus)
//     [1] port       (echoed)
//     [2] flags      (unused, 0)
//     [3] len
//     [4..4+len-1]   payload
//     [last]         checksum
//   status=SPI_STATUS_PENDING means "still working, ask again" — the master
//   should wait for PIN_RP2350_IRQ to go high (or a bounded retry loop)
//   before re-polling. A command that finishes instantly (PING) can be
//   answered on the very next GET_RESULT poll with no real delay.

#pragma once

#include <stdint.h>
#include <stddef.h>

#define SPI_LINK_MAX_PAYLOAD 32
// cmd + port + flags + len + payload + checksum
#define SPI_LINK_FRAME_LEN (4 + SPI_LINK_MAX_PAYLOAD + 1)

// Bring-up SPI link runs slow and conservative — this is a diagnostic
// link, not a latency-sensitive one. 1 MHz is comfortably inside what an
// RP2350 bit-banged-or-hardware SPI slave can keep up with regardless of
// which implementation the Phase-3 spike lands on.
#define SPI_LINK_HZ 1000000

enum SpiLinkCmd : uint8_t {
    SPI_CMD_PING        = 0x01,
    // RS485_RAW: port, payload = bytes to send (DE is driven for the send
    // automatically); len=0 is a passive listen. Result payload = most
    // recent bytes heard on that port (<=32), result flags = total bytes
    // seen on that port since boot (mod 256). ERROR while field-engaged.
    SPI_CMD_RS485_RAW   = 0x02,
    SPI_CMD_LINKTEST    = 0x03,  // port; runs the Smart-port handshake on C/D
    SPI_CMD_GET_RESULT  = 0x05,  // no payload; see RESULT POLL above
    // Field control (the SmartLink engines run ON the RP2350 for C/D; the
    // ESP32 just proxies commands/status over this link):
    // FIELD_SET payload: [0]=engaged, [1]=state (0 disabled/1 driver/2
    // auton), [2..5]=driver_ms LE32, [6..9]=auton_ms LE32, [10]=interlock
    // (1 = hold driver/auton until A7 field mode, 0 = stream the commanded
    // state to any linked controller; absent = 0), [11]=seq (1..255; absent
    // = 0). Answered immediately.
    SPI_CMD_FIELD_SET    = 0x06,
    // FIELD_STATUS response payload: [engaged, state], then per port C and
    // D, 12 bytes each: [link, fm, pack&0xFF, (pack>>8)&0xFF, lack&0xFF,
    // swreplug&0xFF, robot name (6 bytes, NUL padded)], then [26]=seq of the
    // last FIELD_SET applied (0 after boot or after the link watchdog
    // disabled the field). A seq that differs from the last one sent means
    // the RP2350 missed a FIELD_SET: a request it drops is invisible to the
    // master, whose next poll reads the previous OK result.
    SPI_CMD_FIELD_STATUS = 0x07,
    // CAPTURE request payload: [0]=op (0 stop, 1 start and clear, 2 status),
    // [1]=port mask (bit0 C, bit1 D). Result payload: used, size, dropped,
    // records (LE32 each), [16]=recording, [17]=mask.
    SPI_CMD_CAPTURE      = 0x08,
    // CAPTURE_READ: result payload = next <=32 bytes of the ring's record
    // stream (openfc_capture.h), consumed; result flags bit0 = more remain.
    SPI_CMD_CAPTURE_READ = 0x09,
};

enum SpiLinkStatus : uint8_t {
    SPI_STATUS_PENDING = 0x00,  // command still running; poll again
    SPI_STATUS_OK      = 0x01,
    SPI_STATUS_ERROR    = 0x02,
    SPI_STATUS_IDLE     = 0xFF, // nothing has been requested since boot/last poll
};

struct SpiLinkFrame {
    uint8_t b0;      // cmd (request) or status (result)
    uint8_t port;
    uint8_t flags;
    uint8_t len;
    uint8_t payload[SPI_LINK_MAX_PAYLOAD];
    uint8_t checksum;
};

inline uint8_t spi_link_checksum(const uint8_t* frame, size_t n) {
    uint8_t sum = 0;
    for (size_t i = 0; i < n; i++) sum = (uint8_t)(sum + frame[i]);
    return sum;
}

// Serialize into the fixed SPI_LINK_FRAME_LEN wire buffer.
inline void spi_link_pack(const SpiLinkFrame& f, uint8_t out[SPI_LINK_FRAME_LEN]) {
    out[0] = f.b0;
    out[1] = f.port;
    out[2] = f.flags;
    out[3] = f.len;
    uint8_t len = f.len > SPI_LINK_MAX_PAYLOAD ? SPI_LINK_MAX_PAYLOAD : f.len;
    for (uint8_t i = 0; i < SPI_LINK_MAX_PAYLOAD; i++) {
        out[4 + i] = (i < len) ? f.payload[i] : 0;
    }
    out[SPI_LINK_FRAME_LEN - 1] = spi_link_checksum(out, SPI_LINK_FRAME_LEN - 1);
}

// Parse a received fixed wire buffer. Returns false on checksum mismatch
// (the caller should treat that as "no valid frame", not crash).
inline bool spi_link_unpack(const uint8_t in[SPI_LINK_FRAME_LEN], SpiLinkFrame* f) {
    uint8_t expect = spi_link_checksum(in, SPI_LINK_FRAME_LEN - 1);
    if (expect != in[SPI_LINK_FRAME_LEN - 1]) return false;
    f->b0 = in[0];
    f->port = in[1];
    f->flags = in[2];
    f->len = in[3] > SPI_LINK_MAX_PAYLOAD ? SPI_LINK_MAX_PAYLOAD : in[3];
    for (uint8_t i = 0; i < SPI_LINK_MAX_PAYLOAD; i++) f->payload[i] = in[4 + i];
    f->checksum = in[SPI_LINK_FRAME_LEN - 1];
    return true;
}
