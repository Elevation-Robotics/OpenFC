// OpenFC wire protocol — command builders and event parsers.
// USB CDC (CH340C), JSON-lines (\n-terminated), 115200 baud. See spec §5.

export type BoardMode = 'driver' | 'auto';

export type BoardState =
  | 'BOOT'
  | 'DISABLED'
  | 'ENABLED_DRIVER'
  | 'ENABLED_AUTO'
  | 'ESTOP_WATCHDOG';

// Source of an estop event (spec §5.2).
export type EstopSource = 'software' | 'watchdog' | 'timer';

// Raw output-pin state, reported by the firmware `pins` event (diagnostics).
// value=true means the GPIO is driven HIGH (opto ON = V5 pin grounded).
export interface PinState {
  pin: number;
  label: string;
  value: boolean;
}

// Wire-protocol revision reported by the board. Firmware older than 1.3.0 omits
// `proto` from hello and is treated as revision 1 (no get_info, no `diag` flag).
export const PROTO_LEGACY = 1;

// Incoming events (device → host). See spec §6.3.
export type OpenFCEvent =
  | {
      evt: 'hello';
      proto?: number;
      fw_version: string;
      hw_version: string;
      device_id: string;
      fw_hash?: string;
    }
  | {
      evt: 'state';
      enable: boolean;
      mode: BoardMode;
      state: BoardState;
      /** Raw set_pin diagnostics own the outputs; `enable`/`mode` are stale. */
      diag?: boolean;
      timed?: boolean;
      duration_ms?: number;
      remaining_ms?: number;
      uptime_ms: number;
    }
  | { evt: 'heartbeat'; uptime_ms: number }
  | { evt: 'estop'; source: EstopSource }
  | {
      evt: 'timer_expired';
      mode: BoardMode;
      duration_ms: number;
      elapsed_ms: number;
    }
  | {
      evt: 'timer_state';
      active: boolean;
      mode?: string;
      duration_ms?: number;
      remaining_ms?: number;
      elapsed_ms?: number;
    }
  | { evt: 'pins'; pins: PinState[] }
  | { evt: 'ack'; cmd: string }
  | { evt: 'error'; reason: string; cmd?: string };

export type OpenFCEventType = OpenFCEvent['evt'];

// Outgoing command builders (spec §6.4).
// Each returns a JSON string; the serial layer appends '\n' and UTF-8 encodes.
export const cmd = {
  ping: (): string => JSON.stringify({ cmd: 'ping' }),
  getState: (): string => JSON.stringify({ cmd: 'get_state' }),
  getTimer: (): string => JSON.stringify({ cmd: 'get_timer' }),
  // Re-request the hello event. The board only emits hello at boot, so a host
  // attaching to an already-running board needs this to learn its identity.
  getInfo: (): string => JSON.stringify({ cmd: 'get_info' }),
  identify: (): string => JSON.stringify({ cmd: 'identify' }),
  set: (enable: boolean, mode: BoardMode): string =>
    JSON.stringify({ cmd: 'set', enable, mode }),
  estop: (): string => JSON.stringify({ cmd: 'estop' }),
  startPeriod: (mode: BoardMode, durationMs: number): string =>
    JSON.stringify({ cmd: 'start_period', mode, duration_ms: durationMs }),
  // Diagnostics: raw single-GPIO control and pin-state readback.
  setPin: (pin: number, value: boolean): string =>
    JSON.stringify({ cmd: 'set_pin', pin, value }),
  getPins: (): string => JSON.stringify({ cmd: 'get_pins' }),
};

/**
 * Parse a single newline-delimited line from the device into a typed event.
 * Returns null for blank lines or anything that is not a valid OpenFC event.
 */
export function parseEvent(line: string): OpenFCEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && typeof obj.evt === 'string') {
      return obj as OpenFCEvent;
    }
  } catch {
    // Non-JSON noise (e.g. bootloader chatter) — ignore.
  }
  return null;
}
