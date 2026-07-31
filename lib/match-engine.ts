// Match state machine — period sequencing + timing. See spec §9.2.2–§9.2.4.
// Framework-agnostic: the match page subscribes for state updates.

import { cmd, OpenFCEvent } from './openfc-protocol';

export type MatchPhase =
  | 'idle'
  | 'auto'
  | 'gap'
  | 'driver'
  | 'done'
  | 'stopped'
  | 'error';

export type MatchSequence = 'auto' | 'driver' | 'both';

export interface MatchConfig {
  autoDurationMs: number;
  driverDurationMs: number;
  gapDurationMs: number;
  sequence: MatchSequence;
}

// Period bounds. The upper bound mirrors the firmware's PERIOD_MAX_MS (10 min);
// asking for more is rejected by the board, so the UI must not offer it.
export const PERIOD_MIN_S = 1;
export const PERIOD_MAX_S = 600;
export const GAP_MAX_S = 60;

export interface MatchPreset {
  id: string;
  label: string;
  detail: string;
  config: { auto: number; driver: number; gap: number; sequence: MatchSequence };
}

/**
 * Starting points for practice. These mirror common VEX formats but are only
 * defaults — every duration stays editable, since practice rarely runs to
 * competition timing.
 */
export const MATCH_PRESETS: MatchPreset[] = [
  {
    id: 'full',
    label: 'Full match',
    detail: '15s auto → 1:45 driver',
    config: { auto: 15, driver: 105, gap: 5, sequence: 'both' },
  },
  {
    id: 'auto',
    label: 'Autonomous only',
    detail: '15s',
    config: { auto: 15, driver: 105, gap: 5, sequence: 'auto' },
  },
  {
    id: 'driver-skills',
    label: 'Driver skills',
    detail: '1:00 driver',
    config: { auto: 15, driver: 60, gap: 5, sequence: 'driver' },
  },
  {
    id: 'auto-skills',
    label: 'Autonomous skills',
    detail: '1:00 auto',
    config: { auto: 60, driver: 105, gap: 5, sequence: 'auto' },
  },
];

export interface MatchState {
  phase: MatchPhase;
  phaseStartedAt: number;
  phaseDurationMs: number;
  timeRemainingMs: number;
}

export type SendFn = (line: string) => void;
export const PING_INTERVAL_MS = 250;
const EXPIRY_FALLBACK_MS = 2000;
/** Don't re-arm the board on reconnect for a period this close to ending. */
const RESYNC_MIN_MS = 500;

export class MatchEngine {
  private state: MatchState = {
    phase: 'idle',
    phaseStartedAt: 0,
    phaseDurationMs: 0,
    timeRemainingMs: 0,
  };
  private listeners = new Set<(s: MatchState) => void>();
  private pingId: ReturnType<typeof setInterval> | null = null;
  private rafId: number | null = null;
  private fallbackId: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: MatchConfig, private send: SendFn) {}

  subscribe(fn: (s: MatchState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
  getState(): MatchState {
    return this.state;
  }
  private set(patch: Partial<MatchState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn(this.state));
  }

  start(): void {
    if (this.config.sequence === 'driver') this.enterActive('driver');
    else this.enterActive('auto');
  }

  stop(): void {
    this.stopPing();
    this.clearFallback();
    this.stopCountdown();
    this.send(cmd.estop());
    this.set({ phase: 'stopped', timeRemainingMs: 0 });
  }

  reset(): void {
    this.cleanup();
    this.set({ phase: 'idle', phaseDurationMs: 0, timeRemainingMs: 0 });
  }

  destroy(): void {
    this.cleanup();
    this.listeners.clear();
  }

  /** Feed board events so the engine can advance / error out. */
  handleEvent(evt: OpenFCEvent): void {
    const { phase } = this.state;
    if (evt.evt === 'timer_expired') {
      if (phase === 'auto' || phase === 'driver') this.advanceFromActive();
    } else if (evt.evt === 'estop' && evt.source === 'watchdog') {
      if (phase === 'auto' || phase === 'driver') this.enterError();
    }
  }

  /** Re-sync the browser countdown after a reconnect (get_timer response). */
  syncRemaining(remainingMs: number): void {
    if (this.state.phase === 'auto' || this.state.phase === 'driver') {
      this.set({
        phaseStartedAt:
          performance.now() - (this.state.phaseDurationMs - remainingMs),
      });
    }
  }

  /**
   * Reconcile with the board after a reconnect. The board is authoritative
   * while it has a period running. If it does not but the engine still does,
   * the start_period was written while the link was down and never landed —
   * re-arm the board for whatever the browser has left.
   */
  resyncTimer(active: boolean, remainingMs: number): void {
    const phase = this.state.phase;
    if (phase !== 'auto' && phase !== 'driver') return;
    if (active) {
      this.syncRemaining(remainingMs);
      return;
    }
    const left = Math.round(this.state.timeRemainingMs);
    // Below the threshold the period is ending anyway; re-arming would only
    // race the expiry handling.
    if (left > RESYNC_MIN_MS) this.send(cmd.startPeriod(phase, left));
  }

  private enterActive(mode: 'auto' | 'driver'): void {
    const durationMs =
      mode === 'auto' ? this.config.autoDurationMs : this.config.driverDurationMs;
    this.clearFallback();
    this.set({
      phase: mode,
      phaseStartedAt: performance.now(),
      phaseDurationMs: durationMs,
      timeRemainingMs: durationMs,
    });
    this.send(cmd.startPeriod(mode, durationMs));
    this.startPing();
    this.startCountdown();
  }

  private enterGap(): void {
    this.clearFallback();
    this.set({
      phase: 'gap',
      phaseStartedAt: performance.now(),
      phaseDurationMs: this.config.gapDurationMs,
      timeRemainingMs: this.config.gapDurationMs,
    });
    this.startCountdown();
  }

  private advanceFromActive(): void {
    const from = this.state.phase;
    if (from !== 'auto' && from !== 'driver') return;
    this.stopPing();
    this.clearFallback();
    if (from === 'auto' && this.config.sequence === 'both') {
      if (this.config.gapDurationMs > 0) this.enterGap();
      else this.enterActive('driver');
    } else {
      this.enterDone();
    }
  }

  private enterDone(): void {
    this.cleanup();
    this.set({ phase: 'done', timeRemainingMs: 0 });
  }
  private enterError(): void {
    this.cleanup();
    this.set({ phase: 'error', timeRemainingMs: 0 });
  }

  private startPing(): void {
    this.stopPing();
    this.pingId = setInterval(() => this.send(cmd.ping()), PING_INTERVAL_MS);
  }
  private stopPing(): void {
    if (this.pingId) clearInterval(this.pingId);
    this.pingId = null;
  }
  private clearFallback(): void {
    if (this.fallbackId) clearTimeout(this.fallbackId);
    this.fallbackId = null;
  }
  private startCountdown(): void {
    this.stopCountdown();
    this.rafId = requestAnimationFrame(this.tick);
  }
  private stopCountdown(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }
  private cleanup(): void {
    this.stopPing();
    this.clearFallback();
    this.stopCountdown();
  }

  private tick = (): void => {
    const elapsed = performance.now() - this.state.phaseStartedAt;
    const remaining = Math.max(0, this.state.phaseDurationMs - elapsed);
    this.set({ timeRemainingMs: remaining });
    if (remaining <= 0) {
      if (this.state.phase === 'gap') {
        this.enterActive('driver');
        return;
      }
      if (
        (this.state.phase === 'auto' || this.state.phase === 'driver') &&
        this.fallbackId === null
      ) {
        // Board should emit timer_expired; wait up to 2s, then proceed anyway.
        this.fallbackId = setTimeout(
          () => this.advanceFromActive(),
          EXPIRY_FALLBACK_MS,
        );
      }
    }
    this.rafId = requestAnimationFrame(this.tick);
  };
}
