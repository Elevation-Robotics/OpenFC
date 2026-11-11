// OpenFC V1_3 BRING-UP wire protocol — command builders + a loose event type.
//
// Talks to firmware-bringup-v1_3/esp32 over the same USB CDC (CH340C)
// JSON-lines transport as the production board (see lib/serial.ts,
// lib/openfc-protocol.ts), but this is a diagnostic protocol for the new
// prototype hardware, not the certified match protocol. Deliberately kept
// separate from lib/openfc-protocol.ts: `SerialConnection.onEvent` only
// requires a JSON object with a string `evt` field
// (lib/serial.ts's parseEvent), so these `bu_*` events flow through the
// existing transport untouched without needing to extend the production
// `OpenFCEvent` union.

export type SmartPort = 'A' | 'B' | 'C' | 'D';

/**
 * Raw bytes per `rp2350_flash_data` command. Matches the ESP32's fixed
 * decode buffer (`uint8_t bin[384]` in firmware-bringup-v1_3/esp32/src/main.cpp);
 * a larger chunk is silently truncated there and the verify at `end` fails.
 */
export const RP2350_FLASH_CHUNK = 384;

export interface BringupHello {
  evt: 'bu_hello';
  fw_version: string;
  hw_version: string;
  device_id: string;
  /** Present when the firmware paints its own status LEDs from the field state. */
  leds?: 'field';
  /** From 0.1.4: true on bench builds with bus capture and the relay; false on release builds. */
  devtools?: boolean;
}

export interface BringupState {
  evt: 'bu_state';
  uptime_ms: number;
  boot_btn: boolean;
  btn1: boolean;
  btn2: boolean;
  rp2350_irq: boolean;
  /** From 0.1.2: whether the last SPI exchange with the RP2350 succeeded. */
  rp2350?: boolean;
  /** From 0.1.2: how many times the ESP32 has pulsed RUN after the RP2350 stopped answering. */
  rp2350_resets?: number;
}

/** The ESP32 reset the RP2350 after three consecutive failed SPI requests. */
export interface BringupRp2350Reset {
  evt: 'bu_rp2350_reset';
  count: number;
}

export interface BringupLegacyState {
  evt: 'bu_legacy_state';
  enable: boolean;
  mode: 'driver' | 'auto';
  diag: boolean;
  ed_pin_level: boolean;
  ad_pin_level: boolean;
}

export interface BringupRp2350State {
  evt: 'bu_rp2350_state';
  run: boolean;
  boot_ctrl: boolean;
  irq: boolean;
}

export interface BringupRs485Rx {
  evt: 'bu_rs485_rx';
  port: SmartPort;
  bytes: number[];
}

export interface BringupLinktestResult {
  evt: 'bu_linktest_result';
  port: SmartPort;
  ok: boolean;
  stage?: 'no_poll' | 'no_ack' | 'ack' | 'no_eligible';
  session?: boolean;
  ack_bytes?: number[];
  cold?: boolean;
  announces?: number;
  cold_announces?: number;
  warm_announces?: number;
  replies_sent?: number;
  skipped_flood?: number;
  acks_link?: number;
  acks_session?: number;
}

export interface BringupSelftestResult {
  evt: 'bu_selftest_result';
  port: SmartPort;
  ok: boolean;
  sent: number[];
  echo_internal_loopback: number[];
  echo_while_de_high: number[];
  echo_after_de_low: number[];
  echo_while_de_low: number[];
  echo_after_de_high: number[];
}

export interface BringupSpiResult {
  evt: 'bu_spi_result';
  op: 'ping';
  ok: boolean;
}

/** Reply to `rp2350_swd_probe`: is the RP2350 reachable over the on-board SWD pins? */
export interface BringupSwdProbe {
  evt: 'bu_swd_probe';
  ok: boolean;
  /** SW-DP IDCODE as 8 hex chars (RP2350: `4C013477`). */
  dpidr: string;
  /** Bootrom magic read back over AP (`0402754D` when the core is alive). */
  bootrom_magic: string;
  pins_swapped: boolean;
  fail?: string;
}

/**
 * Reply to each `rp2350_flash_*` command. `received` is the running byte
 * count the ESP32 has written so far (present on `data` and `end`).
 */
export interface BringupFlashStatus {
  evt: 'bu_flash_status';
  stage: 'begin' | 'data' | 'end';
  ok: boolean;
  received?: number;
  fail?: string;
}

export type FieldState = 'disabled' | 'driver' | 'auton';

export interface BringupFieldPort {
  port: SmartPort;
  link: boolean;
  ctrl: boolean;
  /** 2 = A7 field mode (states display), 1 = A0 joystick-only, 0 = none. */
  fm: number;
  robot?: string;
  lack: number;
  sack: number;
  pack: number;
  enumreq: number;
  swreplug: number;
}

export interface BringupFieldState {
  evt: 'bu_field';
  engaged: boolean;
  state: FieldState;
  driver_ms: number;
  auton_ms: number;
  /** From 0.1.2: true when driver/auton are held until the controller is in A7 field mode. */
  interlock?: boolean;
  /** From 0.1.6: a timed period is running on the board. */
  timed?: boolean;
  /** From 0.1.6: ms left in the running period, 0 when none. */
  remaining_ms?: number;
  /**
   * From 0.1.6: this reply is to a disable the board held because it came
   * just after a reconnect's get_info while a period runs; `state` is the
   * command, not the outputs. The next bu_field reports the real state.
   */
  held?: boolean;
  ports: BringupFieldPort[];
}

/** One bus record from a capture: bytes the port engine read (`rx`) or wrote (`tx`). */
export interface BringupCap {
  evt: 'bu_cap';
  p: SmartPort;
  d: 'rx' | 'tx';
  /** Microseconds on the MCU that owns the port (A/B the ESP32, C/D the RP2350); wraps at 2^32. */
  t: number;
  /** The bytes as uppercase hex, no separators. */
  h: string;
}

export interface BringupCapRing {
  used: number;
  size: number;
  dropped: number;
  records: number;
}

export interface BringupCapStatus {
  evt: 'bu_cap_status';
  recording: boolean;
  stream: boolean;
  /** Ports being recorded, e.g. "ABCD". */
  ports: string;
  ab: BringupCapRing;
  /** Absent when the RP2350 is not answering. */
  cd?: BringupCapRing;
  /** Set on the status that ends a dump. */
  done?: boolean;
}

export interface BringupAck {
  evt: 'ack';
  cmd: string;
}

export interface BringupError {
  evt: 'bu_error';
  reason: string;
  cmd?: string;
}

export type BringupEvent =
  | BringupHello
  | BringupState
  | BringupLegacyState
  | BringupRp2350State
  | BringupRs485Rx
  | BringupSelftestResult
  | BringupFieldState
  | BringupLinktestResult
  | BringupSpiResult
  | BringupSwdProbe
  | BringupFlashStatus
  | BringupCap
  | BringupCapStatus
  | BringupRp2350Reset
  | BringupAck
  | BringupError;

/**
 * True for any event this protocol module knows how to interpret. Not a type
 * predicate on purpose: `evt` arrives typed as the production `OpenFCEvent`
 * union (lib/serial.ts's transport is shared), which only structurally
 * overlaps `BringupEvent` at the `'ack'` member — narrowing through that
 * intersection would collapse every other `bu_*` literal comparison to a
 * type error. Cast explicitly (`as unknown as BringupEvent`) after calling
 * this, the same way every bringup component does.
 */
export function isBringupEvent(evt: { evt: string }): boolean {
  return (
    evt.evt === 'bu_hello' ||
    evt.evt === 'bu_state' ||
    evt.evt === 'bu_legacy_state' ||
    evt.evt === 'bu_rp2350_state' ||
    evt.evt === 'bu_rs485_rx' ||
    evt.evt === 'bu_selftest_result' ||
    evt.evt === 'bu_field' ||
    evt.evt === 'bu_linktest_result' ||
    evt.evt === 'bu_spi_result' ||
    evt.evt === 'bu_swd_probe' ||
    evt.evt === 'bu_flash_status' ||
    evt.evt === 'bu_cap' ||
    evt.evt === 'bu_cap_status' ||
    evt.evt === 'bu_rp2350_reset' ||
    evt.evt === 'bu_error' ||
    evt.evt === 'ack'
  );
}

// Outgoing command builders. Each returns a JSON string; SerialConnection
// appends '\n' and UTF-8 encodes (lib/serial.ts).
export const bringupCmd = {
  getInfo: (): string => JSON.stringify({ cmd: 'get_info' }),
  ping: (): string => JSON.stringify({ cmd: 'ping' }),
  legacySet: (enable: boolean, mode: 'driver' | 'auto'): string =>
    JSON.stringify({ cmd: 'legacy_set', enable, mode }),
  legacyRaw: (ed: boolean, ad: boolean): string =>
    JSON.stringify({ cmd: 'legacy_raw', ed, ad }),
  rs485Raw: (port: 'A' | 'B', de: boolean, bytes: number[]): string =>
    JSON.stringify({ cmd: 'rs485_raw', port, de, bytes }),
  /**
   * Passive capture, no transmit — for checking whether anything reaches
   * this port at all before trusting a link-test failure means broken
   * hardware. `ms` is clamped to 10000 by the firmware.
   */
  rs485Listen: (port: 'A' | 'B', ms = 2000): string =>
    JSON.stringify({ cmd: 'rs485_listen', port, ms }),
  /**
   * Self-echo test — no controller or other peer needed. Transmits a known
   * byte pattern and reports whether it comes back on this port's own
   * receiver, which proves the UART/transceiver/wiring chain works
   * independent of any protocol or of anything else being plugged in.
   */
  rs485SelfTest: (port: 'A' | 'B'): string =>
    JSON.stringify({ cmd: 'rs485_selftest', port }),
  /**
   * Persistent handshake engine: answers every eligible announce for `ms`
   * (firmware clamps to 30 s) and reports ack statistics. To test the cold
   * handshake, start this FIRST and power-cycle the controller while it
   * runs — the cold window only exists for the first 1-2 announces after
   * controller power-on.
   */
  rs485LinkTest: (port: 'A' | 'B', ms = 15000): string =>
    JSON.stringify({ cmd: 'rs485_linktest', port, ms }),
  rp2350Ctrl: (opts: { run?: boolean; boot_ctrl?: boolean }): string =>
    JSON.stringify({ cmd: 'rp2350_ctrl', ...opts }),
  /**
   * Ports C/D live on the RP2350, reached over the ESP32's SPI link.
   * `op:'rs485_raw'`/`'linktest'` return the same `bu_rs485_rx` /
   * `bu_linktest_result` shapes as the direct A/B commands, tagged with
   * port C/D, so the UI panels don't need to special-case which MCU
   * actually owns the port.
   */
  rp2350SpiPing: (): string => JSON.stringify({ cmd: 'rp2350_spi', op: 'ping' }),
  rp2350SpiRs485Raw: (port: 'C' | 'D', de: boolean, bytes: number[]): string =>
    JSON.stringify({ cmd: 'rp2350_spi', op: 'rs485_raw', port, de, bytes }),
  rp2350SpiLinkTest: (port: 'C' | 'D'): string =>
    JSON.stringify({ cmd: 'rp2350_spi', op: 'linktest', port }),
  /**
   * RP2350 firmware delivery over the ESP32's bit-banged SWD (see
   * firmware-bringup-v1_3/esp32/src/swd_rp2350.cpp and lib/rp2350-flash.ts
   * for the host-side sequence). The RP2350 must be out of reset
   * (`rp2350Ctrl({run:true})`) before the probe will see a DPIDR. `begin`
   * reset-halts the core and erases `size` bytes (rounded up to 4 KB); each
   * `data` chunk is base64 of at most RP2350_FLASH_CHUNK raw bytes; `end`
   * flushes the last page, re-enters XIP and pulses RUN so the new image
   * boots.
   */
  rp2350SwdProbe: (): string => JSON.stringify({ cmd: 'rp2350_swd_probe' }),
  rp2350FlashBegin: (size: number): string =>
    JSON.stringify({ cmd: 'rp2350_flash_begin', size }),
  rp2350FlashData: (b64: string): string =>
    JSON.stringify({ cmd: 'rp2350_flash_data', b64 }),
  rp2350FlashEnd: (): string => JSON.stringify({ cmd: 'rp2350_flash_end' }),
  ledSet: (index: number, r: number, g: number, b: number): string =>
    JSON.stringify({ cmd: 'led_set', index, r, g, b }),
  identify: (): string => JSON.stringify({ cmd: 'identify' }),
  /**
   * Field control (the real ported OpenFC-Smart engine, ports A+B in
   * unison). While engaged the engines own the buses — raw port
   * diagnostics are refused with `field_engaged`. Outside a timed period
   * the firmware drops driver/auton back to disabled if pings stop for
   * 2.5 s, so the panel must ping every ~1 s while engaged. From 0.1.6
   * driver/auton start a timed period that keeps running without pings
   * and ends on the board.
   */
  /**
   * From 0.1.4 the engine streams the commanded state to any linked
   * controller. `interlock:true` instead holds driver/auton (streaming
   * Disabled) until the controller is in A7 field mode.
   */
  fieldEngage: (on: boolean, interlock = false): string =>
    JSON.stringify({ cmd: 'field_engage', on, interlock }),
  fieldState: (state: FieldState): string =>
    JSON.stringify({ cmd: 'field_state', state }),
  fieldPeriod: (driverMs: number, autonMs: number): string =>
    JSON.stringify({ cmd: 'field_period', driver: driverMs, auton: autonMs }),
  /**
   * Bus capture. `on:true` clears the rings and records every byte both
   * ways on the listed ports (all four by default): A/B on the ESP32
   * (128 KB, about 25 s of one port in session), C/D on the RP2350
   * (256 KB). Records are held until a dump;
   * `stream` also sends A/B live as far as the serial link keeps up, and
   * what it cannot carry stays in the ring. There is only something to
   * record while the field is engaged.
   */
  capture: (ports: SmartPort[], on: boolean, stream = false): string =>
    JSON.stringify({ cmd: 'capture', ports, on, stream }),
  /**
   * Stop recording and send everything held: one `bu_cap` per record, then
   * `bu_cap_status` with `done:true`. C/D come out only while the field is
   * disengaged (the SPI transfer stalls the engines); otherwise they stay
   * held on the RP2350 for a later dump.
   */
  captureDump: (): string => JSON.stringify({ cmd: 'capture', dump: true }),
  captureStatus: (): string => JSON.stringify({ cmd: 'capture' }),
  /**
   * Pass bytes between ports A and B for `ms` (max 120000) and record them,
   * for sitting between a real field controller and a V5 controller. The
   * board sends nothing else until `bu_relay_result`; then `captureDump`.
   */
  relay: (ms: number, holdUs = 40): string =>
    JSON.stringify({ cmd: 'relay', ms, hold_us: holdUs }),
};

/** Bytes-as-hex-string helper for the raw send/receive log UI. */
export function hexToBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  return out;
}

export function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
