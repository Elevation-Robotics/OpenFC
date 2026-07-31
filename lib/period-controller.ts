// Tokenised period control (proto 3) — the host half of the match-persistence
// design. Framework-agnostic so a competition portal can drive it from whatever
// its field display is built on.
//
// What this exists to prevent, in order of how much damage each does:
//
//  1. A reconnecting host restarting a period that is already running. The
//     naive reconnect ("no period? send start_period for whatever I have left")
//     is correct only while the board's silence means the command was lost. It
//     is catastrophic when the period simply finished while the host was away:
//     the robots come back on after the match is over. Reconciliation here is
//     therefore driven by what the board reports, never by host memory alone,
//     and a retired token is a terminal state.
//  2. A host on field 2 driving the board on field 3. Every OpenFC enumerates
//     under the same USB name, so a wrong pick in the port chooser is one click
//     away and a token cannot catch it. Once `deviceId` is known every command
//     carries it and the board refuses anything addressed elsewhere.
//  3. Two hosts fighting over one board. Whoever started the period owns it;
//     the other is told `timer_active` and must not retry.

import {
  BoardMode,
  OpenFCEvent,
  PeriodToken,
  cmd,
} from './openfc-protocol';

/** Board's cap on extending a running period (firmware RESYNC_EXTEND_MAX_MS). */
export const RESYNC_EXTEND_MAX_MS = 2000;

/** Drift below this is not worth a round trip; the board's clock is fine. */
export const RESYNC_THRESHOLD_MS = 150;

/** How often to ask the board where it thinks the period is. */
export const RECONCILE_INTERVAL_MS = 1000;

/** Firmware's match_id length limit. */
export const MATCH_ID_MAX_LEN = 32;

/**
 * A persisted period older than this is assumed dead rather than resumed. Ten
 * minutes is the firmware's own PERIOD_MAX_MS, so nothing legitimate outlives
 * it, and a stale record left by yesterday's event must never be replayed.
 */
export const PERSIST_TTL_MS = 600_000;

export type PeriodPhase =
  /** No period of ours in flight. */
  | 'idle'
  /** start_period sent; the board has not yet confirmed it is running. */
  | 'arming'
  /** The board confirms it is running our token. */
  | 'running'
  /** Ran to its full duration. */
  | 'ended'
  /** Ended early by end_period. */
  | 'aborted'
  /** The board refused; see `error`. Terminal — retrying needs a new period. */
  | 'rejected';

export interface PeriodStatus {
  phase: PeriodPhase;
  token: PeriodToken | null;
  mode: BoardMode | null;
  durationMs: number;
  /** Best estimate now: board-reported, advanced by the host clock. */
  remainingMs: number;
  /** Board-reported remaining at the last reconcile, before extrapolation. */
  boardRemainingMs: number | null;
  /** hostRemaining − boardRemaining at the last reconcile. */
  driftMs: number | null;
  /** The board this period is addressed to, if binding is in use. */
  deviceId: string | null;
  /** The board confirmed the period is bound to a device_id. */
  bound: boolean;
  /** Last rejection reason from the board. */
  error: string | null;
  /** Set when reconciliation found the period already over on the board. */
  recovered: boolean;
}

const IDLE: PeriodStatus = {
  phase: 'idle',
  token: null,
  mode: null,
  durationMs: 0,
  remainingMs: 0,
  boardRemainingMs: null,
  driftMs: null,
  deviceId: null,
  bound: false,
  error: null,
  recovered: false,
};

/** Minimal storage shape, so tests and SSR can supply their own. */
export interface PeriodStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistedPeriod {
  matchId: string;
  periodSeq: number;
  mode: BoardMode;
  durationMs: number;
  deviceId: string | null;
  /** Wall clock, for the TTL only — never used to compute remaining time. */
  savedAt: number;
}

export interface PeriodControllerOptions {
  send: (line: string) => void;
  /** Monotonic clock. Defaults to performance.now. */
  now?: () => number;
  /** Where to persist the in-flight token across a reload. */
  store?: PeriodStore | null;
  storageKey?: string;
  /** Called on every status change. */
  onChange?: (status: PeriodStatus) => void;
}

/** A match_id short enough for the firmware and unique enough for an event. */
export function mintMatchId(prefix = 'm'): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '')
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${prefix}-${rand}`.slice(0, MATCH_ID_MAX_LEN);
}

function defaultStore(): PeriodStore | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    // Storage can throw outright under strict privacy settings.
    return null;
  }
}

/**
 * Owns one board's period lifecycle. Feed it every event with handleEvent and
 * call tick() on a display frame; it emits commands through `send`.
 */
export class PeriodController {
  private status: PeriodStatus = IDLE;
  private readonly send: (line: string) => void;
  private readonly now: () => number;
  private readonly store: PeriodStore | null;
  private readonly storageKey: string;
  private readonly onChange?: (s: PeriodStatus) => void;

  /** Host clock reading when boardRemainingMs was captured. */
  private anchorAt = 0;
  private lastReconcileAt = 0;
  /**
   * This period came from storage, not from a start() in this page load. It is
   * therefore never re-asserted: we cannot know whether the board's silence
   * means the start was lost or the match ended while the tab was closed, and
   * of the two possible wrong guesses only one turns robots back on.
   */
  private restoring = false;
  /** Budget for re-sending a start_period the board never acknowledged. */
  private reassertsLeft = 0;

  constructor(opts: PeriodControllerOptions) {
    this.send = opts.send;
    this.now = opts.now ?? (() => performance.now());
    this.store = opts.store === undefined ? defaultStore() : opts.store;
    this.storageKey = opts.storageKey ?? 'openfc.period';
    this.onChange = opts.onChange;
  }

  getStatus(): PeriodStatus {
    return this.status;
  }

  private set(patch: Partial<PeriodStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onChange?.(this.status);
  }

  /**
   * Begin a period. A fresh `periodSeq` per period is mandatory: the board
   * refuses to run a token twice, which is what closes the re-enable hole.
   */
  start(
    mode: BoardMode,
    durationMs: number,
    token: PeriodToken,
    deviceId?: string | null,
  ): PeriodToken {
    const t = this.now();
    this.anchorAt = t;
    this.lastReconcileAt = t;
    this.restoring = false;
    this.reassertsLeft = 3;
    this.set({
      phase: 'arming',
      token,
      mode,
      durationMs,
      remainingMs: durationMs,
      boardRemainingMs: null,
      driftMs: null,
      deviceId: deviceId ?? null,
      bound: false,
      error: null,
      recovered: false,
    });
    this.persist();
    this.send(
      cmd.startPeriod(mode, durationMs, {
        ...token,
        deviceId: deviceId ?? undefined,
      }),
    );
    return token;
  }

  /**
   * Re-send our start_period. On a proto-3 board with the same token this is a
   * no-op that re-establishes context; it is how a host recovers when the board
   * reports no period but we believe one should be running. On a board that has
   * already retired the token it is refused with period_complete — the correct
   * answer, and the reason this is safe to send blind.
   */
  reassert(): void {
    const { token, mode, durationMs, deviceId } = this.status;
    if (!token || !mode) return;
    this.send(
      cmd.startPeriod(mode, durationMs, {
        ...token,
        deviceId: deviceId ?? undefined,
      }),
    );
  }

  /** End the running period early. Not an estop — the board reports it as such. */
  end(): void {
    const { token, deviceId, phase } = this.status;
    if (!token || (phase !== 'running' && phase !== 'arming')) return;
    this.send(cmd.endPeriod({ ...token, deviceId: deviceId ?? undefined }));
  }

  /** Abandon local state without touching the board (e.g. operator reset). */
  clear(): void {
    this.status = IDLE;
    this.clearPersisted();
    this.onChange?.(this.status);
  }

  /**
   * Ask the board where the period stands. Called on connect, on reconnect and
   * periodically — the board is the only authority on whether robots are live.
   */
  reconcile(): void {
    this.send(cmd.getTimer());
  }

  /**
   * Advance the displayed countdown and, when due, reconcile against the board.
   * Safe to call every animation frame.
   */
  tick(): PeriodStatus {
    const { phase, boardRemainingMs } = this.status;
    if (phase !== 'running' && phase !== 'arming') return this.status;
    const t = this.now();
    if (boardRemainingMs !== null) {
      const remaining = Math.max(0, boardRemainingMs - (t - this.anchorAt));
      if (Math.abs(remaining - this.status.remainingMs) >= 1) {
        this.set({ remainingMs: remaining });
      }
    }
    if (t - this.lastReconcileAt >= RECONCILE_INTERVAL_MS) {
      this.lastReconcileAt = t;
      this.reconcile();
    }
    return this.status;
  }

  /**
   * Correct the board's deadline from an authoritative host clock — a portal
   * whose timer comes from a server rather than this browser. Only worth
   * sending when the two disagree by more than the round trip costs. The board
   * caps extensions at 2 s, so a larger correction is reported, not sent: a
   * host asking for one has a wrong clock, and forwarding it would only earn a
   * resync_out_of_range.
   */
  resyncTo(remainingMs: number): 'sent' | 'skipped' | 'out_of_range' {
    const { phase, token, deviceId, boardRemainingMs } = this.status;
    if (phase !== 'running' || !token) return 'skipped';
    const board =
      boardRemainingMs === null
        ? this.status.remainingMs
        : Math.max(0, boardRemainingMs - (this.now() - this.anchorAt));
    const delta = remainingMs - board;
    if (Math.abs(delta) < RESYNC_THRESHOLD_MS) return 'skipped';
    if (delta > RESYNC_EXTEND_MAX_MS) return 'out_of_range';
    this.send(
      cmd.resync({ ...token, deviceId: deviceId ?? undefined }, remainingMs),
    );
    return 'sent';
  }

  /** Feed every board event through here. */
  handleEvent(evt: OpenFCEvent): void {
    switch (evt.evt) {
      case 'timer_state':
        this.applyBoardPeriod(
          evt.active,
          evt.match_id,
          evt.period_seq,
          evt.remaining_ms,
          evt.duration_ms,
          evt.bound,
          evt.last_match_id,
          evt.last_period_seq,
        );
        break;
      case 'state':
        // state carries the same token fields when a period is running, so it
        // is a free reconcile — but it says nothing about a retired token, so
        // its idle case cannot be trusted the way timer_state's can.
        if (evt.timed) {
          this.applyBoardPeriod(
            true,
            evt.match_id,
            evt.period_seq,
            evt.remaining_ms,
            evt.duration_ms,
            evt.bound,
          );
        }
        break;
      case 'timer_expired':
        if (!this.ownsToken(evt.match_id, evt.period_seq)) return;
        this.finish(evt.reason === 'ended' ? 'aborted' : 'ended');
        break;
      case 'estop':
        // An estop kills whatever was running. The token is retired on the
        // board, so this period can never be resumed.
        if (this.status.phase === 'running' || this.status.phase === 'arming') {
          this.finish('aborted');
        }
        break;
      case 'error':
        this.applyError(evt.reason, evt.cmd);
        break;
      default:
        break;
    }
  }

  /**
   * Whether an event that carries a token refers to ours. Events with no token
   * come from an untokenised period or older firmware; those are accepted,
   * since there is nothing to disambiguate against.
   */
  private ownsToken(matchId?: string, seq?: number): boolean {
    const t = this.status.token;
    if (!t) return false;
    if (matchId === undefined || seq === undefined) return true;
    return matchId === t.matchId && seq === t.periodSeq;
  }

  private applyBoardPeriod(
    active: boolean,
    matchId: string | undefined,
    seq: number | undefined,
    remainingMs: number | undefined,
    durationMs: number | undefined,
    bound: boolean | undefined,
    lastMatchId?: string,
    lastSeq?: number,
  ): void {
    const t = this.status.token;
    if (!t) return;

    if (active) {
      if (!this.ownsToken(matchId, seq)) {
        // A period is running that is not ours. Another host owns this board;
        // ours either never started or was superseded. Never send anything
        // that could disturb it.
        if (this.status.phase === 'arming' || this.status.phase === 'running') {
          this.reject('timer_active');
        }
        return;
      }
      const now = this.now();
      const board = remainingMs ?? 0;
      const hostRemaining =
        this.status.boardRemainingMs === null
          ? this.status.remainingMs
          : Math.max(0, this.status.boardRemainingMs - (now - this.anchorAt));
      this.anchorAt = now;
      // Confirmed by the board, so this is no longer a guess from storage.
      this.restoring = false;
      this.set({
        phase: 'running',
        boardRemainingMs: board,
        remainingMs: board,
        durationMs: durationMs ?? this.status.durationMs,
        driftMs: Math.round(hostRemaining - board),
        bound: bound === true,
        error: null,
      });
      this.persist();
      return;
    }

    // Nothing running. Whether that means "our start never landed" or "our
    // period already finished" is the whole question, and guessing wrong
    // re-enables robots after a match. The board answers it directly: a
    // retired token matching ours is proof the period ran to its end.
    if (lastMatchId === t.matchId && lastSeq === t.periodSeq) {
      this.finish('ended', true);
      return;
    }
    if (this.status.phase === 'running') {
      // We watched it run and now the board has no period and no retired token
      // to account for it: the board rebooted, which wipes both. Do not
      // re-assert. The same start_period would look new to a board with no
      // memory of the match and would run the full duration again, turning a
      // power glitch into a second match. Report it and let the operator
      // decide.
      this.set({ error: 'board_reset' });
      this.finish('aborted');
      return;
    }
    if (this.status.phase !== 'arming') return;

    if (this.restoring) {
      // A token recovered from storage that the board knows nothing about. It
      // could be a start_period lost to the reload, or a match that finished
      // on a board that has since rebooted — and nothing distinguishes them.
      // Treat it as over: the cost of being wrong is a period the operator
      // must restart, against robots re-enabled unprompted.
      this.set({ error: 'not_running' });
      this.finish('ended', true);
      return;
    }
    // Started in this page load and the board never picked it up — a
    // start_period lost on the wire, or one that crossed this get_timer.
    // Re-asserting is safe (the same token is a no-op on a board that did get
    // it) but is done once, not in a loop.
    if (this.reassertsLeft > 0) {
      this.reassertsLeft -= 1;
      this.reassert();
    }
  }

  private applyError(reason: string, forCmd?: string): void {
    switch (reason) {
      case 'period_complete':
        // The board already ran this token to completion. Terminal.
        this.finish('ended', true);
        break;
      case 'wrong_device':
      case 'invalid_token':
      case 'timer_active':
        this.reject(reason);
        break;
      case 'token_mismatch':
        // Our resync/end_period named a period the board is not running. It
        // ended while we were away; ask the board rather than assuming.
        this.set({ error: reason });
        this.reconcile();
        break;
      case 'resync_out_of_range':
        // Non-fatal: the period keeps running on the board's clock, which is
        // the more trustworthy one anyway.
        this.set({ error: reason });
        break;
      default:
        if (forCmd && /period|resync/.test(forCmd)) this.set({ error: reason });
        break;
    }
  }

  private reject(reason: string): void {
    this.set({ phase: 'rejected', error: reason, remainingMs: 0 });
    this.clearPersisted();
  }

  private finish(phase: 'ended' | 'aborted', recovered = false): void {
    this.set({
      phase,
      remainingMs: 0,
      boardRemainingMs: 0,
      recovered: recovered || this.status.recovered,
    });
    this.clearPersisted();
  }

  // ─── Persistence ───
  // Only the token and its shape are stored. Elapsed time deliberately is not:
  // a reload cannot know how long the page was gone, and the board can tell us
  // exactly. Restoring is therefore always followed by a reconcile.

  private persist(): void {
    const { token, mode, durationMs, deviceId } = this.status;
    if (!this.store || !token || !mode) return;
    const record: PersistedPeriod = {
      matchId: token.matchId,
      periodSeq: token.periodSeq,
      mode,
      durationMs,
      deviceId,
      savedAt: Date.now(),
    };
    try {
      this.store.setItem(this.storageKey, JSON.stringify(record));
    } catch {
      // A full or unavailable quota must not break a match.
    }
  }

  private clearPersisted(): void {
    try {
      this.store?.removeItem(this.storageKey);
    } catch {
      // ignore
    }
  }

  /** The token this origin last had in flight, if it is recent enough to matter. */
  readPersisted(): PersistedPeriod | null {
    if (!this.store) return null;
    let raw: string | null;
    try {
      raw = this.store.getItem(this.storageKey);
    } catch {
      return null;
    }
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw) as PersistedPeriod;
      if (
        typeof rec?.matchId !== 'string' ||
        typeof rec?.periodSeq !== 'number' ||
        (rec.mode !== 'auto' && rec.mode !== 'driver')
      ) {
        return null;
      }
      if (Date.now() - rec.savedAt > PERSIST_TTL_MS) {
        this.clearPersisted();
        return null;
      }
      return rec;
    } catch {
      return null;
    }
  }

  /**
   * Adopt a token left behind by a previous page load and ask the board what
   * became of it. Enters `arming`, not `running`: nothing is believed until the
   * board confirms, and if the period is over the reconcile will say so.
   * Returns false when there was nothing to resume.
   */
  restore(): boolean {
    const rec = this.readPersisted();
    if (!rec) return false;
    const t = this.now();
    this.anchorAt = t;
    this.lastReconcileAt = t;
    this.restoring = true;
    this.reassertsLeft = 0;
    this.status = {
      ...IDLE,
      phase: 'arming',
      token: { matchId: rec.matchId, periodSeq: rec.periodSeq },
      mode: rec.mode,
      durationMs: rec.durationMs,
      remainingMs: rec.durationMs,
      deviceId: rec.deviceId,
    };
    this.onChange?.(this.status);
    this.reconcile();
    return true;
  }
}
