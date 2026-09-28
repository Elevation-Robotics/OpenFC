// Board adapters for the practice match engine (lib/match-engine.ts).
//
// The engine owns phases and the on-screen countdown; an adapter turns "start
// this period", "end it now" and "keep the link alive" into the commands a
// particular firmware understands, and tells the engine which of its events
// mean the period ended or the board gave up on the host.
//
//   proto3 — production firmware on revision-1.1 boards (lib/openfc-protocol.ts).
//            The board times each period itself and reports timer_expired.
//   v13    — V1.3 bring-up firmware (lib/openfc-bringup-protocol.ts). Drives the
//            Smart ports with field_period + field_state and the legacy ports
//            with legacy_set. The legacy ports have no board-side timer on this
//            firmware, so the host disables everything itself when a period ends.

import { BoardMode, OpenFCEvent, PeriodToken, cmd } from './openfc-protocol';
import { bringupCmd } from './openfc-bringup-protocol';

export type BoardKind = 'proto3' | 'v13';

/** What an incoming event means to a running match. */
export type BoardSignal = 'expired' | 'watchdog' | null;

export interface MatchBoard {
  readonly kind: BoardKind;
  /** Enable the robots for a new period of `durationMs`. */
  startPeriod(mode: BoardMode, durationMs: number, token: PeriodToken): void;
  /**
   * Re-arm a period the board lost while the link was down (reconnect). Only
   * meaningful where the board can recognise a replayed token.
   */
  rearm(mode: BoardMode, remainingMs: number, token: PeriodToken): void;
  /** Disable now: operator stop, or ending a period early. */
  disable(): void;
  /** The period has ended (board expiry or the host's countdown). */
  periodEnded(): void;
  ping(): void;
  /**
   * True when the host, not the board, decides a period is over: the engine
   * ends it as soon as its own countdown reaches zero instead of waiting for
   * the board to report expiry.
   */
  readonly hostEndsPeriods: boolean;
  signal(evt: OpenFCEvent): BoardSignal;
}

export type SendFn = (line: string) => void;

export function proto3Board(send: SendFn): MatchBoard {
  return {
    kind: 'proto3',
    hostEndsPeriods: false,
    startPeriod: (mode, durationMs, token) => send(cmd.startPeriod(mode, durationMs, token)),
    rearm: (mode, remainingMs, token) => send(cmd.startPeriod(mode, remainingMs, token)),
    // estop also cancels the board's countdown, so the next start_period is
    // not refused with timer_active.
    disable: () => send(cmd.estop()),
    // The board already disabled on expiry; nothing to send.
    periodEnded: () => {},
    ping: () => send(cmd.ping()),
    signal: (evt) => {
      if (evt.evt === 'timer_expired') return 'expired';
      if (evt.evt === 'estop' && evt.source === 'watchdog') return 'watchdog';
      return null;
    },
  };
}

export function v13Board(send: SendFn): MatchBoard {
  // Last field state asked for, to re-send it if the board turns out to have
  // been disengaged (someone used the bring-up console's diagnostics).
  let wanted: 'disabled' | 'driver' | 'auton' = 'disabled';
  const setState = (state: typeof wanted) => {
    wanted = state;
    send(bringupCmd.fieldState(state));
  };
  const disableAll = () => {
    setState('disabled');
    send(bringupCmd.legacySet(false, 'driver'));
  };
  return {
    kind: 'v13',
    hostEndsPeriods: true,
    startPeriod: (mode, durationMs) => {
      // Each Smart port counts its own copy down from this and shows it on the
      // controller; setting both keeps it right whichever mode runs.
      send(bringupCmd.fieldPeriod(durationMs, durationMs));
      setState(mode === 'auto' ? 'auton' : 'driver');
      send(bringupCmd.legacySet(true, mode));
    },
    // No period tokens on this firmware: a reconnect within the 2.5 s field
    // watchdog finds the period still running; after it, the board has
    // already disabled and a blind re-arm could re-enable after the match.
    rearm: () => {},
    disable: disableAll,
    periodEnded: disableAll,
    ping: () => send(bringupCmd.ping()),
    signal: (evt) => {
      const raw = evt as unknown as { evt: string; reason?: string; cmd?: string };
      if (raw.evt === 'bu_match_end') return 'expired';
      if (raw.evt === 'bu_field_watchdog') {
        // The board only drops the Smart ports; the legacy ports have no
        // watchdog, so take them down too.
        send(bringupCmd.legacySet(false, 'driver'));
        return 'watchdog';
      }
      if (raw.evt === 'bu_error' && raw.reason === 'not_engaged' && raw.cmd === 'field_state') {
        send(bringupCmd.fieldEngage(true));
        send(bringupCmd.fieldState(wanted));
      }
      return null;
    },
  };
}

export function boardFor(kind: BoardKind, send: SendFn): MatchBoard {
  return kind === 'v13' ? v13Board(send) : proto3Board(send);
}
