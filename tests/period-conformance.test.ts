// The conformance suite is only worth running if it can tell a correct board
// from a broken one. These tests drive it against a simulated board whose
// proto-3 behaviour can be switched off one guarantee at a time, and assert
// that removing a guarantee turns the corresponding check red.

import { describe, it, expect } from 'vitest';
import {
  CHECKS,
  ConformanceIO,
  runConformance,
  summarise,
} from '@/lib/period-conformance';
import { OpenFCEvent } from '@/lib/openfc-protocol';

interface BoardFlaws {
  /** Pretend to be firmware 1.3.0. */
  proto2?: boolean;
  /** Restart the period when its own token is replayed. */
  replayRestarts?: boolean;
  /** Run a token that has already finished. */
  forgetsRetired?: boolean;
  /** Obey a command addressed to a different device_id. */
  ignoresDeviceId?: boolean;
  /** Let a second host preempt a running period. */
  allowsPreempt?: boolean;
  /** Accept any resync, however large. */
  noResyncClamp?: boolean;
  /** Raise an estop when a period is ended by end_period. */
  estopsOnEnd?: boolean;
  /** Obey resync/end_period naming a period it is not running. */
  ignoresTokenMismatch?: boolean;
}

const DEVICE_ID = 'openfc-494274';

/**
 * A board simulator, driven by a virtual clock so the suite's real waits do not
 * make the test slow. Time advances only when the suite calls delay().
 */
class FakeBoard {
  private clock = 0;
  private active = false;
  private matchId: string | null = null;
  private seq: number | null = null;
  private mode = 'auto';
  private duration = 0;
  private startedAt = 0;
  private retiredId: string | null = null;
  private retiredSeq: number | null = null;
  private listeners = new Set<(e: OpenFCEvent) => void>();

  constructor(private flaws: BoardFlaws = {}) {}

  private emit(e: OpenFCEvent) {
    this.listeners.forEach((fn) => fn(e));
  }

  private remaining(): number {
    const elapsed = this.clock - this.startedAt;
    return Math.max(0, this.duration - elapsed);
  }

  private expireIfDue() {
    if (this.active && this.remaining() <= 0) this.finish('timer');
  }

  private finish(reason: 'timer' | 'ended') {
    const evt: OpenFCEvent = {
      evt: 'timer_expired',
      mode: this.mode as 'auto' | 'driver',
      duration_ms: this.duration,
      elapsed_ms: Math.min(this.clock - this.startedAt, this.duration),
      reason,
      ...(this.matchId !== null
        ? { match_id: this.matchId, period_seq: this.seq ?? 0 }
        : {}),
    };
    this.retiredId = this.matchId;
    this.retiredSeq = this.seq;
    this.active = false;
    this.matchId = null;
    this.seq = null;
    this.emit(evt);
    if (reason === 'timer' || this.flaws.estopsOnEnd) {
      this.emit({ evt: 'estop', source: 'timer' });
    }
  }

  advance(ms: number) {
    this.clock += ms;
    this.expireIfDue();
  }

  subscribe(fn: (e: OpenFCEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private err(reason: string, cmd: string) {
    this.emit({ evt: 'error', reason, cmd });
  }

  private ack(cmd: string, extra: Record<string, number> = {}) {
    this.emit({ evt: 'ack', cmd, ...extra } as OpenFCEvent);
  }

  receive(line: string) {
    this.expireIfDue();
    const c = JSON.parse(line) as Record<string, unknown>;
    const cmd = c.cmd as string;

    if (cmd === 'get_info') {
      this.emit({
        evt: 'hello',
        proto: this.flaws.proto2 ? 2 : 3,
        fw_version: this.flaws.proto2 ? '1.3.0' : '1.4.0',
        hw_version: '1.1',
        device_id: DEVICE_ID,
      });
      return;
    }
    if (cmd === 'get_timer') {
      this.emit(
        this.active
          ? {
              evt: 'timer_state',
              active: true,
              mode: this.mode,
              duration_ms: this.duration,
              remaining_ms: this.remaining(),
              match_id: this.matchId ?? undefined,
              period_seq: this.seq ?? undefined,
              bound: true,
            }
          : {
              evt: 'timer_state',
              active: false,
              ...(this.retiredId
                ? {
                    last_match_id: this.retiredId,
                    last_period_seq: this.retiredSeq ?? 0,
                  }
                : {}),
            },
      );
      return;
    }
    if (cmd === 'estop') {
      if (this.active) this.finish('ended');
      this.emit({ evt: 'estop', source: 'software' });
      return;
    }
    this.receivePeriodCommand(cmd, c);
  }

  private receivePeriodCommand(cmd: string, c: Record<string, unknown>) {
    const hasId = typeof c.match_id === 'string';
    const hasSeq = typeof c.period_seq === 'number';
    const id = c.match_id as string | undefined;
    const seq = c.period_seq as number | undefined;

    if (!this.flaws.proto2 && hasId !== hasSeq) {
      this.err('invalid_token', cmd);
      return;
    }
    if (
      !this.flaws.proto2 &&
      !this.flaws.ignoresDeviceId &&
      typeof c.device_id === 'string' &&
      c.device_id !== DEVICE_ID
    ) {
      this.err('wrong_device', cmd);
      return;
    }

    if (cmd === 'start_period') {
      const mine =
        this.active && this.matchId === id && this.seq === seq && hasId;
      if (mine && !this.flaws.replayRestarts && !this.flaws.proto2) {
        this.ack('start_period');
        return;
      }
      if (this.active && !this.flaws.allowsPreempt && !mine) {
        this.err('timer_active', 'start_period');
        return;
      }
      if (
        hasId &&
        !this.flaws.proto2 &&
        !this.flaws.forgetsRetired &&
        this.retiredId === id &&
        this.retiredSeq === seq
      ) {
        this.err('period_complete', 'start_period');
        return;
      }
      this.active = true;
      this.mode = (c.mode as string) ?? 'auto';
      this.duration = c.duration_ms as number;
      this.startedAt = this.clock;
      this.matchId = hasId ? (id as string) : null;
      this.seq = hasSeq ? (seq as number) : null;
      this.ack('start_period');
      return;
    }

    const namesRunning =
      this.active && hasId && this.matchId === id && this.seq === seq;
    if (!namesRunning && !this.flaws.ignoresTokenMismatch) {
      this.err('token_mismatch', cmd);
      return;
    }

    if (cmd === 'resync') {
      const wanted = c.remaining_ms as number;
      const current = this.remaining();
      if (!this.flaws.noResyncClamp && wanted - current > 2000) {
        this.err('resync_out_of_range', 'resync');
        return;
      }
      this.duration = this.clock - this.startedAt + wanted;
      this.ack('resync', { delta_ms: wanted - current });
      return;
    }
    if (cmd === 'end_period') {
      this.ack('end_period');
      this.finish('ended');
    }
  }
}

/**
 * Bridges the suite to a FakeBoard. delay() and waitFor() advance the virtual
 * clock rather than waiting, so a suite with seconds of real waits runs in
 * milliseconds while still exercising the real timing logic.
 */
function fakeIO(board: FakeBoard): ConformanceIO {
  return {
    deviceId: DEVICE_ID,
    send: (line) => board.receive(line),
    delay: async (ms) => board.advance(ms),
    watch: (fn) => board.subscribe(fn),
    waitFor: (match, timeoutMs) =>
      new Promise((resolve) => {
        let found: OpenFCEvent | null = null;
        const unsub = board.subscribe((e) => {
          if (!found && match(e)) found = e;
        });
        // The board replies synchronously inside send(); give the caller a
        // microtask to issue it, then let the virtual clock run out.
        queueMicrotask(() => {
          if (!found) board.advance(timeoutMs);
          unsub();
          resolve(found);
        });
      }),
  };
}

async function run(flaws: BoardFlaws = {}) {
  const results = await runConformance(fakeIO(new FakeBoard(flaws)));
  const by = (id: string) => results.find((r) => r.id === id);
  return { results, by };
}

describe('a correct board', () => {
  it('passes every check', async () => {
    const { results } = await run();
    const failed = results.filter((r) => r.outcome === 'fail');
    expect(failed.map((f) => `${f.id}: ${f.detail}`)).toEqual([]);
    expect(summarise(results).pass).toBe(CHECKS.length);
  });
});

describe('each guarantee is actually tested', () => {
  it('catches a board that restarts a replayed period', async () => {
    const { by } = await run({ replayRestarts: true });
    expect(by('replay')?.outcome).toBe('fail');
  });

  it('catches a board that re-runs a finished period', async () => {
    const { by } = await run({ forgetsRetired: true });
    expect(by('retired')?.outcome).toBe('fail');
  });

  it('catches a board that ignores device_id', async () => {
    const { by } = await run({ ignoresDeviceId: true });
    expect(by('wrong-device')?.outcome).toBe('fail');
  });

  it('catches a board that lets a second host preempt a match', async () => {
    const { by } = await run({ allowsPreempt: true });
    expect(by('foreign-token')?.outcome).toBe('fail');
  });

  it('catches a missing resync clamp', async () => {
    const { by } = await run({ noResyncClamp: true });
    expect(by('resync-clamp')?.outcome).toBe('fail');
  });

  it('catches an end_period that reports a fault', async () => {
    const { by } = await run({ estopsOnEnd: true });
    expect(by('end-period')?.outcome).toBe('fail');
  });

  it('catches a board that obeys a stale token', async () => {
    const { by } = await run({ ignoresTokenMismatch: true });
    expect(by('token-mismatch')?.outcome).toBe('fail');
  });
});

describe('preconditions', () => {
  it('stops early on a proto-2 board rather than reporting noise', async () => {
    const { results, by } = await run({ proto2: true });
    expect(by('proto')?.outcome).toBe('fail');
    // Everything after the version check is skipped: on proto 2 the failures
    // are all expected, and reporting them as findings would be misleading.
    const afterProto = results.slice(1);
    expect(afterProto.every((r) => r.outcome === 'skip')).toBe(true);
  });

  it('refuses to run while someone else has a period live', async () => {
    const board = new FakeBoard();
    board.receive(
      JSON.stringify({
        cmd: 'start_period',
        mode: 'driver',
        duration_ms: 100000,
        match_id: 'someone-elses-match',
        period_seq: 1,
      }),
    );
    const results = await runConformance(fakeIO(board));
    const idle = results.find((r) => r.id === 'idle');
    expect(idle?.outcome).toBe('fail');
    expect(idle?.detail).toContain('someone-elses-match');
    expect(results.filter((r) => r.outcome === 'skip').length).toBeGreaterThan(0);
  });

  it('dry run skips everything that would enable the outputs', async () => {
    const results = await runConformance(fakeIO(new FakeBoard()), {
      dryRun: true,
    });
    for (const r of results) {
      if (r.enablesOutputs) expect(r.outcome).toBe('skip');
    }
    expect(results.find((r) => r.id === 'proto')?.outcome).toBe('pass');
  });

  it('reports progress as each check lands', async () => {
    const seen: string[] = [];
    await runConformance(fakeIO(new FakeBoard()), {
      onProgress: (r) => seen.push(r.id),
    });
    expect(seen).toEqual(CHECKS.map((c) => c.id));
  });
});
