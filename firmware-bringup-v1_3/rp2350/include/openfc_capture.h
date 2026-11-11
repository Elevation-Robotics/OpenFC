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
// OpenFC V1_3 BRING-UP — Smart-port bus capture ring.
//
// IDENTICAL COPY lives in the other PlatformIO project's include/ (same
// rule as openfc_spi_link.h). Every byte a port engine reads or writes is
// stored as a record: [port, dir, len, t_us LE32] + payload. The ring is a
// FIFO that keeps its earliest records: when full, new records are counted
// as dropped rather than overwriting what a dump has not read yet.

#pragma once

#include <stdint.h>
#include <stddef.h>

#define CAP_HDR_LEN 7
#define CAP_MAX_PAYLOAD 255

typedef void (*CapSink)(char port, bool tx, const uint8_t* b, size_t n, uint32_t tUs);

struct CapRecordHeader {
    char port;
    bool tx;
    uint8_t len;
    uint32_t tUs;
};

class CaptureRing {
public:
    void init(uint8_t* mem, size_t size) { buf_ = mem; size_ = size; clear(); }
    void clear() { head_ = tail_ = used_ = 0; dropped_ = 0; records_ = 0; }
    size_t size() const { return size_; }
    size_t used() const { return used_; }
    bool empty() const { return used_ == 0; }
    uint32_t dropped() const { return dropped_; }
    uint32_t records() const { return records_; }

    void push(char port, bool tx, const uint8_t* b, size_t n, uint32_t tUs) {
        while (n > 0) {
            size_t take = n > CAP_MAX_PAYLOAD ? CAP_MAX_PAYLOAD : n;
            if (!buf_ || used_ + CAP_HDR_LEN + take > size_) { dropped_++; return; }
            uint8_t h[CAP_HDR_LEN] = {
                (uint8_t)port, (uint8_t)(tx ? 1 : 0), (uint8_t)take,
                (uint8_t)tUs, (uint8_t)(tUs >> 8), (uint8_t)(tUs >> 16), (uint8_t)(tUs >> 24),
            };
            put(h, CAP_HDR_LEN);
            put(b, take);
            records_++;
            b += take;
            n -= take;
        }
    }

    // Payload length of the next record, or -1 when empty.
    int peekLen() const { return used_ < CAP_HDR_LEN ? -1 : buf_[(tail_ + 2) % size_]; }

    // out needs room for CAP_MAX_PAYLOAD bytes.
    bool pop(CapRecordHeader* h, uint8_t* out) {
        if (used_ < CAP_HDR_LEN) return false;
        uint8_t hdr[CAP_HDR_LEN];
        get(hdr, CAP_HDR_LEN);
        h->port = (char)hdr[0];
        h->tx = hdr[1] != 0;
        h->len = hdr[2];
        h->tUs = (uint32_t)hdr[3] | ((uint32_t)hdr[4] << 8) | ((uint32_t)hdr[5] << 16) |
                 ((uint32_t)hdr[6] << 24);
        get(out, h->len);
        return true;
    }

    // Raw record-stream bytes, for shipping the ring across the SPI link.
    size_t read(uint8_t* out, size_t n) {
        if (n > used_) n = used_;
        get(out, n);
        return n;
    }

private:
    void put(const uint8_t* b, size_t n) {
        for (size_t i = 0; i < n; i++) { buf_[head_] = b[i]; head_ = (head_ + 1) % size_; }
        used_ += n;
    }
    void get(uint8_t* b, size_t n) {
        for (size_t i = 0; i < n; i++) { b[i] = buf_[tail_]; tail_ = (tail_ + 1) % size_; }
        used_ -= n;
    }
    uint8_t* buf_ = nullptr;
    size_t size_ = 0, head_ = 0, tail_ = 0, used_ = 0;
    uint32_t dropped_ = 0, records_ = 0;
};

// Rebuilds records from the raw stream one byte at a time (the SPI link
// delivers it in 32-byte pieces that do not align with records). Returns
// true when a whole record has landed in h/out.
class CapStreamParser {
public:
    bool feed(uint8_t byte, CapRecordHeader* h, uint8_t* out) {
        buf_[len_++] = byte;
        if (len_ < CAP_HDR_LEN || len_ < (size_t)CAP_HDR_LEN + buf_[2]) return false;
        h->port = (char)buf_[0];
        h->tx = buf_[1] != 0;
        h->len = buf_[2];
        h->tUs = (uint32_t)buf_[3] | ((uint32_t)buf_[4] << 8) | ((uint32_t)buf_[5] << 16) |
                 ((uint32_t)buf_[6] << 24);
        for (uint8_t i = 0; i < h->len; i++) out[i] = buf_[CAP_HDR_LEN + i];
        len_ = 0;
        return true;
    }

private:
    uint8_t buf_[CAP_HDR_LEN + CAP_MAX_PAYLOAD];
    size_t len_ = 0;
};
