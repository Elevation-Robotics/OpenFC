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

// Revision 3 (firmware 1.4.0) adds period tokens, resync, end_period and
// device_id binding. A host that needs to survive its own reload must check for
// this before relying on any of it; older boards ignore the extra fields and
// would restart the period instead of recognising a replayed token.
export const PROTO_TOKENS = 3;

/**
 * Identifies one period of one match. Replaying it lets a reconnecting host say
 * "this is the period you are already running" rather than asking for a new
 * one. `matchId` is opaque to the board, max 32 characters.
 */
export interface PeriodToken {
  matchId: string;
  periodSeq: number;
}

/** Why a timed period ended: normal expiry, or an operator abort. */
export type PeriodEndReason = 'timer' | 'ended';

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
      /** Token of the running period; absent if none, or if it is untokenised. */
      match_id?: string;
      period_seq?: number;
      /** The period is bound to a device_id, so commands must carry one. */
      bound?: boolean;
      uptime_ms: number;
    }
  | { evt: 'heartbeat'; uptime_ms: number }
  | { evt: 'estop'; source: EstopSource }
  | {
      evt: 'timer_expired';
      mode: BoardMode;
      duration_ms: number;
      elapsed_ms: number;
      /** Absent on proto < 3, where every timer_expired is a normal expiry. */
      reason?: PeriodEndReason;
      match_id?: string;
      period_seq?: number;
    }
  | {
      evt: 'timer_state';
      active: boolean;
      mode?: string;
      duration_ms?: number;
      remaining_ms?: number;
      elapsed_ms?: number;
      match_id?: string;
      period_seq?: number;
      bound?: boolean;
      /**
       * Token of the last period to finish, reported when none is running. Tells
       * a reconnecting host whether the period it was tracking already ended or
       * never started — the board refuses to run this token again.
       */
      last_match_id?: string;
      last_period_seq?: number;
    }
  | { evt: 'pins'; pins: PinState[] }
  | { evt: 'ack'; cmd: string; delta_ms?: number }
  | { evt: 'error'; reason: string; cmd?: string };

export type OpenFCEventType = OpenFCEvent['evt'];

/**
 * Optional proto-3 addressing carried by the period commands.
 *
 * `deviceId` is the board's own id from hello. Send it whenever you know which
 * board you meant: every OpenFC enumerates under the same USB name, so on a
 * multi-field event picking the wrong port is the one mistake a token cannot
 * catch — it is a perfectly valid token, just addressed to another field. The
 * board rejects a mismatch with `wrong_device` before anything moves.
 *
 * Binding is sticky. A period started with a deviceId can only be resynced or
 * ended by commands that also carry one, so a second host on the wrong port
 * cannot interfere with a match it did not start.
 */
export interface PeriodAddress extends PeriodToken {
  deviceId?: string;
}

function addressFields(addr?: PeriodAddress) {
  if (!addr) return {};
  return {
    match_id: addr.matchId,
    period_seq: addr.periodSeq,
    ...(addr.deviceId ? { device_id: addr.deviceId } : {}),
  };
}

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
  /**
   * Start a timed period, or — with the same `addr` as one already running —
   * re-establish context after a reconnect without restarting it. Omit `addr`
   * for the proto-2 behaviour, where any start_period starts a new period.
   */
  startPeriod: (
    mode: BoardMode,
    durationMs: number,
    addr?: PeriodAddress,
  ): string =>
    JSON.stringify({
      cmd: 'start_period',
      mode,
      duration_ms: durationMs,
      ...addressFields(addr),
    }),
  /**
   * Correct a running period's deadline against the host's clock. Never touches
   * the outputs. Shortening is unrestricted; the board rejects an extension of
   * more than 2 s with `resync_out_of_range`, on the basis that a host asking
   * for more has a wrong clock rather than a longer match.
   */
  resync: (addr: PeriodAddress, remainingMs: number): string =>
    JSON.stringify({
      cmd: 'resync',
      ...addressFields(addr),
      remaining_ms: remainingMs,
    }),
  /**
   * End a running period early — a referee abort. Reported as
   * `timer_expired` with `reason:'ended'` so the host can tell it apart from a
   * fault. Use `estop` for anything that is actually an emergency.
   */
  endPeriod: (addr: PeriodAddress): string =>
    JSON.stringify({ cmd: 'end_period', ...addressFields(addr) }),
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
