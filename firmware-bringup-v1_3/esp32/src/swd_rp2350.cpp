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
// See swd_rp2350.h for provenance. Register/constant sources are cited
// inline; the flash flow mirrors raspberrypi/openocd rp2040.c (sdk-2.0.0).

#include "swd_rp2350.h"
#include "openfc_pins_v13.h"

// Netlist assignment (see header). swdConnect() auto-swaps on failure and
// remembers, so a schematic/netlist reading error self-corrects.
static int pinSwclk = 42;
static int pinSwdio = 41;

// ─── ADIv6 / RP2350 constants ────────────────────────────────────────────
static const uint32_t AP_CORE0_BASE = 0x2000;    // rp2350.cfg: -ap-num 0x2000
// ADIv6 MEM-AP register frame: CSW/TAR/DRW live in the 16-byte bank at
// base+0xD00 (A[3:2] = 0/1/3 within it).
static const uint32_t SELECT_MEMAP_BANK = AP_CORE0_BASE + 0xD00;
// CSW: PROT=0x23 (RP2350-required), AddrInc=single, Size=word.
static const uint32_t CSW_VALUE = 0x23000012;

static const uint32_t DHCSR = 0xE000EDF0, DCRSR = 0xE000EDF4, DCRDR = 0xE000EDF8;
static const uint32_t DSCSR = 0xE000EE08;      // DSCSR_CDSKEY bit17, CDS bit16
static const uint32_t ACCESSCTRL_LOCK = 0x40060000, ACCESSCTRL_CFGRESET = 0x40060008;

static const uint32_t BOOTROM_MAGIC_ADDR = 0x00000010;
static const uint32_t BOOTROM_RP2350_MAGIC = 0x02754d;   // "Mu", version 2
#define MAKE_TAG(a, b) ((uint16_t)(((b) << 8) | (a)))
static const uint16_t RT_FLAG_FUNC_ARM_SEC = 0x04;

// RP2350 SRAM scratch layout for programming (SRAM is 0x20000000+, 520 KB;
// nothing else is running, we own all of it while halted).
static const uint32_t ALGO_ADDR = 0x20000000;   // 32-byte call-batch stub
static const uint32_t RECORDS_ADDR = ALGO_ADDR + 32;  // stub does `adr r7, .+32`
static const uint32_t STACK_TOP = 0x20004000;
static const uint32_t BOUNCE_ADDR = 0x20008000; // 4 KB program chunks

// OpenOCD rp2040.c verbatim: armv8m batch-call stub (clears MSPLIM/PSPLIM,
// then for each null-terminated {pc, sp, r0-r3} record: set sp, load args,
// blx pc; ends at a bkpt at offset 30).
static const uint8_t BATCH_ALGO[32] = {
    0x07, 0xa7, 0x00, 0x20, 0x80, 0xf3, 0x0a, 0x88,
    0x80, 0xf3, 0x0b, 0x88, 0x10, 0xcf, 0x00, 0x2c,
    0x05, 0xd0, 0x20, 0xcf, 0xad, 0x46, 0x0f, 0xcf,
    0xa0, 0x47, 0xf7, 0xe7, 0xc0, 0x46, 0x00, 0xbe,
};

// OpenOCD rp2040.c verbatim: RCP-init stub (enables coprocessor 7 and seeds
// the canaries iff unseeded; bkpt at offset 24).
static const uint8_t RCP_INIT[32] = {
    0x06, 0x48, 0x5f, 0xf4, 0x40, 0x41, 0x01, 0x60,
    0x30, 0xee, 0x10, 0xf7, 0x04, 0xd4, 0x40, 0xec,
    0x80, 0x07, 0x40, 0xec, 0x81, 0x07, 0x40, 0xbf,
    0x00, 0xbe, 0x00, 0x00, 0x88, 0xed, 0x00, 0xe0,
};

// ─── Bit-level SWD ───────────────────────────────────────────────────────
// Host drives/changes SWDIO while SWCLK is low; target samples on the
// rising edge. Host samples target-driven data just before its own rising
// edge. digitalWrite overhead paces SWCLK to a few hundred kHz, safely
// under the blank-chip BOOTSEL-loop ceiling.

static inline void clkCycle() {
    digitalWrite(pinSwclk, HIGH);
    digitalWrite(pinSwclk, LOW);
}

static void swdDrive() { pinMode(pinSwdio, OUTPUT); }
static void swdRelease() { pinMode(pinSwdio, INPUT_PULLUP); }

static void writeBits(uint32_t val, int n) {
    for (int i = 0; i < n; i++) {
        digitalWrite(pinSwdio, (val >> i) & 1);
        clkCycle();
    }
}

static uint32_t readBits(int n) {
    uint32_t v = 0;
    for (int i = 0; i < n; i++) {
        if (digitalRead(pinSwdio)) v |= (1u << i);
        clkCycle();
    }
    return v;
}

static void turnaround() { clkCycle(); }

static void lineReset() {
    swdDrive();
    for (int i = 0; i < 56; i++) { digitalWrite(pinSwdio, HIGH); clkCycle(); }
    for (int i = 0; i < 4; i++) { digitalWrite(pinSwdio, LOW); clkCycle(); }
}

// ARM ADI "Selection Alert" sequence + SW-DP activation, for parts whose
// SWJ mux powers up dormant. Byte values verbatim from OpenOCD swd.c,
// transmitted LSB-first per byte.
static void dormantToSwd() {
    swdDrive();
    for (int i = 0; i < 8; i++) { digitalWrite(pinSwdio, HIGH); clkCycle(); }
    static const uint8_t alert[16] = {
        0x92, 0xf3, 0x09, 0x62, 0x95, 0x2d, 0x85, 0x86,
        0xe9, 0xaf, 0xdd, 0xe3, 0xa2, 0x0e, 0xbc, 0x19,
    };
    for (int i = 0; i < 16; i++) writeBits(alert[i], 8);
    writeBits(0x00, 4);
    writeBits(0x1a, 8);   // activation: ARM CoreSight SW-DP
}

// One SWD transaction. reg = A[3:2] as byte offset (0/4/8/0xC).
// Returns ack (1=OK, 2=WAIT, 4=FAULT, 7=no response).
static int swdRaw(bool ap, bool rd, uint8_t reg, uint32_t* data) {
    uint8_t req = 1 |                                  // start
                  ((ap ? 1 : 0) << 1) |
                  ((rd ? 1 : 0) << 2) |
                  (((reg >> 2) & 3) << 3) |
                  ((((ap ? 1 : 0) + (rd ? 1 : 0) + ((reg >> 2) & 1) + ((reg >> 3) & 1)) & 1) << 5) |
                  (0 << 6) |                           // stop
                  (1 << 7);                            // park
    swdDrive();
    writeBits(req, 8);
    swdRelease();
    turnaround();
    int ack = (int)readBits(3);
    if (ack != 1) {
        // WAIT/FAULT: complete the turnaround back to host drive and idle.
        turnaround();
        swdDrive();
        writeBits(0, 8);
        return ack;
    }
    if (rd) {
        uint32_t v = readBits(32);
        uint32_t par = readBits(1);
        turnaround();
        swdDrive();
        writeBits(0, 2);   // idle
        uint32_t check = v;
        check ^= check >> 16; check ^= check >> 8; check ^= check >> 4;
        check ^= check >> 2; check ^= check >> 1;
        if ((check & 1) != (par & 1)) return 7;  // parity error
        *data = v;
    } else {
        turnaround();
        swdDrive();
        uint32_t v = *data;
        writeBits(v, 32);
        uint32_t check = v;
        check ^= check >> 16; check ^= check >> 8; check ^= check >> 4;
        check ^= check >> 2; check ^= check >> 1;
        writeBits(check & 1, 1);
        writeBits(0, 2);   // idle
    }
    return 1;
}

// Retry WAITs; clear sticky errors on FAULT via ABORT then fail the call.
static bool swdXfer(bool ap, bool rd, uint8_t reg, uint32_t* data) {
    for (int attempt = 0; attempt < 64; attempt++) {
        int ack = swdRaw(ap, rd, reg, data);
        if (ack == 1) return true;
        if (ack == 2) continue;                       // WAIT
        uint32_t abort = 0x1E;                        // clear all sticky errors
        (void)swdRaw(false, false, 0x0, &abort);
        return false;
    }
    return false;
}

static bool dpRead(uint8_t reg, uint32_t* v) { return swdXfer(false, true, reg, v); }
static bool dpWrite(uint8_t reg, uint32_t v) { return swdXfer(false, false, reg, &v); }
static bool apReadRaw(uint8_t reg, uint32_t* v) { return swdXfer(true, true, reg, v); }
static bool apWrite(uint8_t reg, uint32_t v) { return swdXfer(true, false, reg, &v); }

static uint32_t cachedSelect = 0xFFFFFFFF;
static bool selectBank(uint32_t sel) {
    if (sel == cachedSelect) return true;
    if (!dpWrite(0x8, sel)) return false;
    cachedSelect = sel;
    return true;
}

// AP reads are posted: issue, then collect from RDBUFF.
static bool apRead(uint8_t reg, uint32_t* v) {
    uint32_t dummy;
    if (!apReadRaw(reg, &dummy)) return false;
    return dpRead(0xC, v);   // RDBUFF
}

// ─── MEM-AP memory access ────────────────────────────────────────────────
static bool memInit() {
    if (!selectBank(SELECT_MEMAP_BANK)) return false;
    return apWrite(0x0, CSW_VALUE);   // CSW
}

static bool memWrite32(uint32_t addr, uint32_t val) {
    if (!selectBank(SELECT_MEMAP_BANK)) return false;
    if (!apWrite(0x4, addr)) return false;   // TAR
    return apWrite(0xC, val);                // DRW
}

static bool memRead32(uint32_t addr, uint32_t* val) {
    if (!selectBank(SELECT_MEMAP_BANK)) return false;
    if (!apWrite(0x4, addr)) return false;
    return apRead(0xC, val);
}

static bool memRead16(uint32_t addr, uint16_t* val) {
    uint32_t word;
    if (!memRead32(addr & ~3u, &word)) return false;
    *val = (addr & 2) ? (uint16_t)(word >> 16) : (uint16_t)word;
    return true;
}

// Word-aligned block write using CSW auto-increment. The increment wraps at
// 1 KB boundaries, so re-seat TAR every 256 words.
static bool memWriteBuf(uint32_t addr, const uint8_t* buf, size_t n) {
    if (!selectBank(SELECT_MEMAP_BANK)) return false;
    size_t words = (n + 3) / 4;
    for (size_t w = 0; w < words; w++) {
        if ((w % 256) == 0) {
            if (!apWrite(0x4, addr + w * 4)) return false;
        }
        uint32_t v = 0;
        for (int b = 0; b < 4; b++) {
            size_t idx = w * 4 + b;
            v |= (uint32_t)(idx < n ? buf[idx] : 0xFF) << (8 * b);
        }
        if (!apWrite(0xC, v)) return false;
    }
    return true;
}

// ─── Core control (ARMv8-M debug registers) ──────────────────────────────
static bool coreHalt() {
    if (!memWrite32(DHCSR, 0xA05F0003)) return false;
    for (int i = 0; i < 100; i++) {
        uint32_t v;
        if (!memRead32(DHCSR, &v)) return false;
        if (v & (1u << 17)) return true;   // S_HALT
        delay(1);
    }
    return false;
}

static bool coreWriteReg(int regno, uint32_t val) {
    if (!memWrite32(DCRDR, val)) return false;
    if (!memWrite32(DCRSR, 0x00010000 | (uint32_t)regno)) return false;
    for (int i = 0; i < 100; i++) {
        uint32_t v;
        if (!memRead32(DHCSR, &v)) return false;
        if (v & (1u << 16)) return true;   // S_REGRDY
    }
    return false;
}

// Run code at pc until it hits its terminating bkpt (core re-halts).
static bool coreRunTo(uint32_t pc, uint32_t sp, uint32_t timeoutMs) {
    if (!coreWriteReg(13, sp)) return false;
    if (!coreWriteReg(15, pc | 1)) return false;         // thumb
    if (!coreWriteReg(16, 0x01000000)) return false;     // xPSR: T bit
    // PRIMASK=1 (CFBP special reg, low byte) so no bootrom-armed interrupt
    // can preempt the stub, and clear MSPLIM/PSPLIM: measured on the bench
    // (CFSR=STKOF): resuming with the bootrom's interrupts + stack limits
    // live meant the first IRQ's exception push landed below the bootrom's
    // MSPLIM and escalated to HardFault before the stub ran a single
    // useful instruction.
    if (!coreWriteReg(20, 0x00000001)) return false;     // CONTROL/…/PRIMASK
    if (!coreWriteReg(0x1C, 0)) return false;            // MSPLIM
    if (!coreWriteReg(0x1D, 0)) return false;            // PSPLIM
    if (!memWrite32(DHCSR, 0xA05F0001)) return false;    // resume
    uint32_t deadline = millis() + timeoutMs;
    while (millis() < deadline) {
        uint32_t v;
        if (!memRead32(DHCSR, &v)) return false;
        if (v & (1u << 17)) return true;                 // halted at bkpt
        delay(2);
    }
    return false;
}

// ─── Connect ─────────────────────────────────────────────────────────────
static bool tryConnect(uint32_t* dpidr) {
    cachedSelect = 0xFFFFFFFF;
    // Plain JTAG-to-SWD first, dormant-wake second.
    for (int variant = 0; variant < 2; variant++) {
        if (variant == 1) dormantToSwd();
        lineReset();
        swdDrive();
        writeBits(0xE79E, 16);   // JTAG-to-SWD select
        lineReset();
        if (dpRead(0x0, dpidr) && *dpidr != 0 && *dpidr != 0xFFFFFFFF) return true;
    }
    return false;
}

static bool swdConnect(SwdProbeInfo* info) {
    pinMode(pinSwclk, OUTPUT);
    digitalWrite(pinSwclk, LOW);
    for (int attempt = 0; attempt < 2; attempt++) {
        uint32_t dpidr = 0;
        if (tryConnect(&dpidr)) {
            info->dpidr = dpidr;
            info->pinsSwapped = (attempt == 1);
            // Debug power-up request + ack.
            if (!dpWrite(0x8, 0x0)) { info->fail = "select0"; return false; }
            cachedSelect = 0;
            if (!dpWrite(0x4, 0x50000000)) { info->fail = "pwrup_req"; return false; }
            for (int i = 0; i < 100; i++) {
                uint32_t cs;
                if (!dpRead(0x4, &cs)) { info->fail = "pwrup_read"; return false; }
                info->ctrlstat = cs;
                if ((cs & 0xF0000000) == 0xF0000000) return memInit() ? true
                    : (info->fail = "csw", false);
                delay(1);
            }
            info->fail = "pwrup_ack";
            return false;
        }
        // Netlist said SWCLK=42/SWDIO=41; if that read wrong, swap and retry.
        int t = pinSwclk; pinSwclk = pinSwdio; pinSwdio = t;
        pinMode(pinSwclk, OUTPUT);
        digitalWrite(pinSwclk, LOW);
    }
    info->fail = "no_dpidr";
    return false;
}

bool swdProbe(SwdProbeInfo* info) {
    if (!swdConnect(info)) { info->ok = false; return false; }
    if (!memRead32(BOOTROM_MAGIC_ADDR, &info->bootromMagic)) {
        info->fail = "magic_read";
        info->ok = false;
        return false;
    }
    info->ok = true;
    return true;
}

// ─── Bootrom ROM-table lookup (RP2350 A1 format; rp2040.c port) ─────────
static bool lookupRomFunc(uint16_t tag, uint16_t* out, const char** fail) {
    uint32_t magic;
    if (!memRead32(BOOTROM_MAGIC_ADDR, &magic)) { *fail = "magic"; return false; }
    if ((magic & 0xffffff) != BOOTROM_RP2350_MAGIC) { *fail = "not_rp2350_rom"; return false; }
    uint16_t p;
    if (!memRead16(BOOTROM_MAGIC_ADDR + 4, &p)) { *fail = "tableptr"; return false; }
    if (p < 0x7c00) { *fail = "a0_rom_unsupported"; return false; }
    uint32_t ptr = p;
    while (true) {
        uint16_t entryTag, entryFlags;
        if (!memRead16(ptr, &entryTag)) { *fail = "tbl_read"; return false; }
        if (entryTag == 0) { *fail = "func_not_found"; return false; }
        ptr += 2;
        if (!memRead16(ptr, &entryFlags)) { *fail = "tbl_read"; return false; }
        ptr += 2;
        uint16_t matching = RT_FLAG_FUNC_ARM_SEC & entryFlags;
        if (tag == entryTag && matching != 0) {
            uint16_t mf = matching, ef = entryFlags;
            while (!(mf & 1)) {
                if (ef & 1) ptr += 2;
                mf >>= 1;
                ef >>= 1;
            }
            if (!memRead16(ptr, out)) { *fail = "tbl_read"; return false; }
            return true;
        }
        while (entryFlags) {
            if (entryFlags & 1) ptr += 2;
            entryFlags >>= 1;
        }
    }
}

// ─── ROM function calls via the batch stub ───────────────────────────────
struct RomCall { uint32_t pc, sp, args[4]; };

static bool callRomBatch(const RomCall* calls, int n, uint32_t timeoutMs, const char** fail) {
    if (!memWriteBuf(ALGO_ADDR, BATCH_ALGO, sizeof(BATCH_ALGO))) { *fail = "algo_wr"; return false; }
    if (!memWriteBuf(RECORDS_ADDR, (const uint8_t*)calls, n * sizeof(RomCall))) {
        *fail = "rec_wr"; return false;
    }
    if (!memWrite32(RECORDS_ADDR + n * sizeof(RomCall), 0)) { *fail = "null_wr"; return false; }
    if (!coreRunTo(ALGO_ADDR, STACK_TOP, timeoutMs)) { *fail = "algo_run"; return false; }
    return true;
}

static bool callRomFunc(uint16_t func, uint32_t a0, uint32_t a1, uint32_t a2, uint32_t a3,
                        uint32_t timeoutMs, const char** fail) {
    RomCall c = {func, STACK_TOP, {a0, a1, a2, a3}};
    return callRomBatch(&c, 1, timeoutMs, fail);
}

// ─── Flash session ───────────────────────────────────────────────────────
static struct {
    bool active = false;
    uint32_t offset = 0;       // next flash offset to program
    uint32_t received = 0;
    uint16_t fnProgram = 0, fnFlush = 0, fnXip = 0;
    uint8_t buf[4096];
    size_t bufLen = 0;
} g_fs;

static bool programChunk(const char** fail) {
    if (g_fs.bufLen == 0) return true;
    // Pad to a whole 256-byte flash page (erased flash is 0xFF).
    while (g_fs.bufLen % 256) g_fs.buf[g_fs.bufLen++] = 0xFF;
    if (!memWriteBuf(BOUNCE_ADDR, g_fs.buf, g_fs.bufLen)) { *fail = "bounce_wr"; return false; }
    if (!callRomFunc(g_fs.fnProgram, g_fs.offset, BOUNCE_ADDR, g_fs.bufLen, 0, 3000, fail))
        return false;
    g_fs.offset += g_fs.bufLen;
    g_fs.bufLen = 0;
    return true;
}

bool swdFlashBegin(uint32_t totalSize, const char** fail) {
    g_fs.active = false;
    g_fs.offset = 0;
    g_fs.received = 0;
    g_fs.bufLen = 0;

    // Fresh boot, then connect while the bootrom idles.
    digitalWrite(PIN_RP2350_RUN, LOW);
    delay(20);
    digitalWrite(PIN_RP2350_RUN, HIGH);
    delay(300);

    SwdProbeInfo info;
    if (!swdConnect(&info)) { *fail = info.fail; return false; }
    if (!coreHalt()) { *fail = "halt"; return false; }

    // RESET-HALT (measured on the bench, stk_pc=0x20000000 + clean CFSR):
    // by idle time the bootrom has dropped into its Non-secure "nsboot" USB
    // regime with the SAU locked down, and any code we inject faults on its
    // first fetch. Catch core0 at its reset vector instead — pristine
    // Secure state, SAU/MPU at reset defaults, RCP unseeded (our stub
    // seeds it). This is the "reset-halting the cores before flash
    // programming" scenario rp2040.c's RCP comment describes.
    uint32_t demcr;
    if (!memRead32(0xE000EDFC, &demcr)) { *fail = "demcr_rd"; return false; }
    if (!memWrite32(0xE000EDFC, demcr | 1)) { *fail = "vc_corereset"; return false; }
    if (!memWrite32(0xE000ED0C, 0x05FA0004)) { *fail = "sysresetreq"; return false; }
    delay(50);
    bool halted = false;
    for (int i = 0; i < 100; i++) {
        uint32_t v;
        if (!memRead32(DHCSR, &v)) {
            // Debug state may need re-establishing after the reset.
            if (!swdConnect(&info)) { *fail = "reconnect"; return false; }
            continue;
        }
        if (v & (1u << 17)) { halted = true; break; }
        // Keep requesting halt in case the reset catch was missed.
        memWrite32(DHCSR, 0xA05F0003);
        delay(2);
    }
    if (!halted) { *fail = "reset_halt"; return false; }
    if (!memWrite32(0xE000EDFC, demcr & ~1u)) { *fail = "vc_clear"; return false; }

    // ACCESSCTRL: reset permissions unless debug-locked (rp2040.c).
    uint32_t lock;
    if (!memRead32(ACCESSCTRL_LOCK, &lock)) { *fail = "accessctrl_rd"; return false; }
    if (!(lock & 0x8)) {
        if (!memWrite32(ACCESSCTRL_CFGRESET, 0xacce0000u | 1u)) { *fail = "cfgreset"; return false; }
    }

    // Flip core0 to the Secure domain (bootrom flash funcs are Secure-only).
    uint32_t dscsr;
    if (!memRead32(DSCSR, &dscsr)) { *fail = "dscsr_rd"; return false; }
    if (!(dscsr & (1u << 16))) {
        if (!memWrite32(DSCSR, (dscsr & ~(1u << 17)) | (1u << 16))) { *fail = "dscsr_wr"; return false; }
    }

    // RCP init stub, then bootrom function lookups.
    if (!memWriteBuf(ALGO_ADDR, RCP_INIT, sizeof(RCP_INIT))) { *fail = "rcp_wr"; return false; }
    if (!coreRunTo(ALGO_ADDR, STACK_TOP, 1000)) { *fail = "rcp_run"; return false; }

    uint16_t fnStateReset = 0, fnConnect = 0, fnExitXip = 0, fnErase = 0;
    if (!lookupRomFunc(MAKE_TAG('I', 'F'), &fnConnect, fail)) return false;
    if (!lookupRomFunc(MAKE_TAG('E', 'X'), &fnExitXip, fail)) return false;
    if (!lookupRomFunc(MAKE_TAG('R', 'E'), &fnErase, fail)) return false;
    if (!lookupRomFunc(MAKE_TAG('R', 'P'), &g_fs.fnProgram, fail)) return false;
    if (!lookupRomFunc(MAKE_TAG('F', 'C'), &g_fs.fnFlush, fail)) return false;
    if (!lookupRomFunc(MAKE_TAG('C', 'X'), &g_fs.fnXip, fail)) return false;
    if (!lookupRomFunc(MAKE_TAG('S', 'R'), &fnStateReset, fail)) fnStateReset = 0;  // optional

    if (fnStateReset) {
        if (!callRomFunc(fnStateReset, 0x01 /* RESET_CURRENT_CORE */, 0, 0, 0, 1000, fail))
            return false;
    }
    {
        RomCall calls[2] = {
            {fnConnect, STACK_TOP, {0, 0, 0, 0}},
            {fnExitXip, STACK_TOP, {0, 0, 0, 0}},
        };
        if (!callRomBatch(calls, 2, 2000, fail)) return false;
    }

    // Erase in 128 KB chunks (rp2040.c cadence; ROM picks 4K/64K mix).
    uint32_t eraseLen = (totalSize + 4095) & ~4095u;
    uint32_t off = 0;
    while (off < eraseLen) {
        uint32_t n = eraseLen - off;
        if (n > 128 * 1024) n = 128 * 1024;
        if (!callRomFunc(fnErase, off, n, 65536, 0xd8, 10000, fail)) return false;
        off += n;
    }

    g_fs.active = true;
    return true;
}

bool swdFlashData(const uint8_t* data, size_t n, const char** fail) {
    if (!g_fs.active) { *fail = "no_session"; return false; }
    while (n > 0) {
        size_t space = sizeof(g_fs.buf) - g_fs.bufLen;
        size_t take = n < space ? n : space;
        memcpy(g_fs.buf + g_fs.bufLen, data, take);
        g_fs.bufLen += take;
        data += take;
        n -= take;
        g_fs.received += take;
        if (g_fs.bufLen == sizeof(g_fs.buf)) {
            if (!programChunk(fail)) { g_fs.active = false; return false; }
        }
    }
    return true;
}

bool swdFlashEnd(const char** fail) {
    if (!g_fs.active) { *fail = "no_session"; return false; }
    g_fs.active = false;
    if (!programChunk(fail)) return false;
    RomCall calls[2] = {
        {g_fs.fnFlush, STACK_TOP, {0, 0, 0, 0}},
        {g_fs.fnXip, STACK_TOP, {0, 0, 0, 0}},
    };
    if (!callRomBatch(calls, 2, 2000, fail)) return false;
    // Reboot the RP2350 into the freshly-written flash image.
    digitalWrite(PIN_RP2350_RUN, LOW);
    delay(20);
    digitalWrite(PIN_RP2350_RUN, HIGH);
    return true;
}

uint32_t swdFlashCount() { return g_fs.received; }

// 32-bit read of the RP2350's bus for bring-up inspection. Halt-read-resume,
// NOT a live peek: measured on the bench (2026-09-01) that reading APB
// peripheral registers (SPI0, GPIO ctrl) through the AHB-AP WHILE core0 is
// running produced self-consistent-looking but wrong data — e.g. SSPCR0
// read back 0 immediately after spi_init() should have set its DSS field,
// and two different registers (SSPCR1, SSPSR) read back the identical
// value, which is not physically possible for that pair. Halting first (as
// swdDiag already did successfully) avoids whatever AHB-AP/live-bus hazard
// caused that; the brief pause is invisible to anything but hard real-time
// code, and resume puts the core back exactly where it was.
bool swdMemPeek(uint32_t addr, uint32_t* val) {
    SwdProbeInfo info;
    if (!swdConnect(&info)) return false;
    if (!coreHalt()) return false;
    bool ok = memRead32(addr, val);
    memWrite32(DHCSR, 0xA05F0001);   // resume (C_DEBUGEN | C_HALT=0)
    return ok;
}

// Step-by-step diagnostic for the code-execution path; reports into `out`
// (a JSON-ready buffer of key=value hex pairs). Isolates: block-write
// integrity (CSW auto-increment), DSCSR state, and what the core is doing
// after a stub run attempt.
void swdDiag(char* out, size_t outCap) {
    size_t n = 0;
    auto put = [&](const char* k, uint32_t v) {
        n += snprintf(out + n, outCap - n, "%s=%08X ", k, (unsigned)v);
    };
    // Fresh boot so leftover state from a failed attempt can't muddy the data.
    digitalWrite(PIN_RP2350_RUN, LOW);
    delay(20);
    digitalWrite(PIN_RP2350_RUN, HIGH);
    delay(300);

    SwdProbeInfo info;
    if (!swdConnect(&info)) {
        snprintf(out, outCap, "connect_fail=%s", info.fail);
        return;
    }
    put("dpidr", info.dpidr);
    if (!coreHalt()) { put("halt", 0xBAD); return; }
    uint32_t v = 0;
    memRead32(DHCSR, &v); put("dhcsr", v);
    memRead32(DSCSR, &v); put("dscsr", v);
    // Where was the bootrom when we halted, and what is its HardFault vector?
    memWrite32(DCRSR, 15); delay(1); memRead32(DCRDR, &v); put("pc0", v);
    memWrite32(DCRSR, 16); delay(1); memRead32(DCRDR, &v); put("xpsr0", v);
    memRead32(0x0000000C, &v); put("hf_vec", v);

    // Vector catch on every fault class: a faulting stub now halts AT the
    // faulting instruction instead of running the ROM's HardFault handler.
    memRead32(0xE000EDFC, &v);
    memWrite32(0xE000EDFC, v | 0x7F0);

    memRead32(DSCSR, &v);
    if (!(v & (1u << 16))) memWrite32(DSCSR, (v & ~(1u << 17)) | (1u << 16));
    memRead32(DSCSR, &v); put("dscsr2", v);

    memWriteBuf(ALGO_ADDR, RCP_INIT, sizeof(RCP_INIT));
    bool ran = coreRunTo(ALGO_ADDR, STACK_TOP, 1000);
    put("ran", ran ? 1 : 0);
    memRead32(DHCSR, &v); put("dhcsr2", v);
    memWrite32(DCRSR, 15); delay(1); memRead32(DCRDR, &v); put("pc", v);
    memWrite32(DCRSR, 16); delay(1); memRead32(DCRDR, &v); put("xpsr", v);
    // Configurable Fault Status + HardFault Status for the post-mortem.
    memRead32(0xE000ED28, &v); put("cfsr", v);
    memRead32(0xE000ED2C, &v); put("hfsr", v);
    // If we're sitting in a fault handler, the exception entry stacked the
    // faulting context: stacked PC at [SP+24], stacked xPSR at [SP+28].
    uint32_t sp = 0;
    memWrite32(DCRSR, 13); delay(1); memRead32(DCRDR, &sp); put("sp", sp);
    if (sp >= 0x20000000 && sp < 0x20082000 - 32) {
        memRead32(sp + 24, &v); put("stk_pc", v);
        memRead32(sp + 28, &v); put("stk_xpsr", v);
    }
}
