import { describe, it, expect, beforeEach } from 'vitest';
import {
  PeriodController,
  PeriodStore,
  RESYNC_EXTEND_MAX_MS,
  mintMatchId,
} from '@/lib/period-controller';
import { MATCH_ID_MAX_LEN } from '@/lib/period-controller';
import { OpenFCEvent } from '@/lib/openfc-protocol';

/** In-memory PeriodStore, so persistence is exercised without a DOM. */
function memStore(seed?: Record<string, string>): PeriodStore & {
  data: Record<string, string>;
} {
  const data: Record<string, string> = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

let clock = 0;
function harness(store: PeriodStore | null = memStore()) {
  const sent: string[] = [];
  const controller = new PeriodController({
    send: (line) => sent.push(line),
    now: () => clock,
    store,
  });
  const parsed = () => sent.map((s) => JSON.parse(s));
  const of = (name: string) => parsed().filter((p) => p.cmd === name);
  return { controller, sent, parsed, of, store };
}

const TOKEN = { matchId: 'qm-42', periodSeq: 1 };

const running = (over: Partial<Record<string, unknown>> = {}): OpenFCEvent =>
  ({
    evt: 'timer_state',
    active: true,
    mode: 'auto',
    duration_ms: 15000,
    remaining_ms: 10000,
    match_id: TOKEN.matchId,
    period_seq: TOKEN.periodSeq,
    bound: true,
    ...over,
  }) as OpenFCEvent;

const idle = (over: Partial<Record<string, unknown>> = {}): OpenFCEvent =>
  ({ evt: 'timer_state', active: false, ...over }) as OpenFCEvent;

beforeEach(() => {
  clock = 0;
});

describe('mintMatchId', () => {
  it('stays inside the firmware match_id limit', () => {
    for (let i = 0; i < 50; i++) {
      const id = mintMatchId();
      expect(id.length).toBeGreaterThan(0);
      expect(id.length).toBeLessThanOrEqual(MATCH_ID_MAX_LEN);
    }
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintMatchId()));
    expect(ids.size).toBe(200);
  });
});

describe('starting a period', () => {
  it('sends the token and the device binding', () => {
    const { controller, of } = harness();
    controller.start('auto', 15000, TOKEN, 'openfc-494274');
    expect(of('start_period')[0]).toEqual({
      cmd: 'start_period',
      mode: 'auto',
      duration_ms: 15000,
      match_id: 'qm-42',
      period_seq: 1,
      device_id: 'openfc-494274',
    });
    expect(controller.getStatus().phase).toBe('arming');
  });

  it('is only running once the board confirms it', () => {
    const { controller } = harness();
    controller.start('auto', 15000, TOKEN);
    expect(controller.getStatus().phase).toBe('arming');
    controller.handleEvent(running());
    const s = controller.getStatus();
    expect(s.phase).toBe('running');
    expect(s.remainingMs).toBe(10000);
    expect(s.bound).toBe(true);
  });

  it('records drift between the host and board clocks', () => {
    const { controller } = harness();
    controller.start('auto', 15000, TOKEN);
    controller.handleEvent(running({ remaining_ms: 15000 }));
    clock += 5000;
    controller.handleEvent(running({ remaining_ms: 9800 }));
    // Host thought 10000 ms was left, board says 9800 — 200 ms of drift.
    expect(controller.getStatus().driftMs).toBe(200);
  });
});

describe('the re-enable hole', () => {
  it('treats a retired token as finished, never as a lost start', () => {
    const { controller, of } = harness();
    controller.start('auto', 15000, TOKEN);
    controller.handleEvent(running());
    // The host goes away; the period expires; the host comes back and asks.
    controller.handleEvent(
      idle({ last_match_id: TOKEN.matchId, last_period_seq: TOKEN.periodSeq }),
    );
    expect(controller.getStatus().phase).toBe('ended');
    expect(controller.getStatus().recovered).toBe(true);
    // Nothing may be sent that could start it again.
    expect(of('start_period').length).toBe(1);
  });

  it('gives up on a restored token the board knows nothing about', () => {
    // The dangerous case: a reload finds a stored token, and the board reports
    // no period and no retired token. That is indistinguishable from a match
    // that ended on a board which has since rebooted, so it must not re-arm.
    const store = memStore({
      'openfc.period': JSON.stringify({
        matchId: 'qm-42',
        periodSeq: 1,
        mode: 'auto',
        durationMs: 15000,
        deviceId: null,
        savedAt: Date.now(),
      }),
    });
    const { controller, of } = harness(store);
    expect(controller.restore()).toBe(true);
    controller.handleEvent(idle());
    expect(controller.getStatus().phase).toBe('ended');
    expect(of('start_period').length).toBe(0);
  });

  it('rejoins a restored period the board is still running', () => {
    const store = memStore({
      'openfc.period': JSON.stringify({
        matchId: 'qm-42',
        periodSeq: 1,
        mode: 'auto',
        durationMs: 15000,
        deviceId: 'openfc-494274',
        savedAt: Date.now(),
      }),
    });
    const { controller, of } = harness(store);
    controller.restore();
    expect(of('get_timer').length).toBe(1);
    controller.handleEvent(running({ remaining_ms: 6120 }));
    const s = controller.getStatus();
    expect(s.phase).toBe('running');
    expect(s.remainingMs).toBe(6120);
    // Rejoining must never re-send start_period.
    expect(of('start_period').length).toBe(0);
  });

  it('stops on period_complete rather than retrying with the same token', () => {
    const { controller } = harness();
    controller.start('auto', 15000, TOKEN);
    controller.handleEvent({
      evt: 'error',
      reason: 'period_complete',
      cmd: 'start_period',
    });
    expect(controller.getStatus().phase).toBe('ended');
  });

  it('does not re-arm a board that lost the period without retiring it', () => {
    // A board reset wipes both the period and its retired token. Re-asserting
    // would look like a brand-new period to it and run the full duration again.
    const { controller, of } = harness();
    controller.start('auto', 15000, TOKEN);
    controller.handleEvent(running());
    controller.handleEvent(idle());
    expect(controller.getStatus().phase).toBe('aborted');
    expect(controller.getStatus().error).toBe('board_reset');
    expect(of('start_period').length).toBe(1);
  });

  it('re-asserts a start the board never picked up, but only a few times', () => {
    const { controller, of } = harness();
    controller.start('auto', 15000, TOKEN);
    for (let i = 0; i < 10; i++) controller.handleEvent(idle());
    // One original plus a bounded number of retries — never an endless loop.
    const sends = of('start_period').length;
    expect(sends).toBeGreaterThan(1);
    expect(sends).toBeLessThanOrEqual(4);
  });

  it('forgets the persisted token once the period is over', () => {
    const { controller, store } = harness();
    controller.start('auto', 15000, TOKEN);
    controller.handleEvent(running());
    expect(controller.readPersisted()).not.toBeNull();
    controller.handleEvent({
      evt: 'timer_expired',
      mode: 'auto',
      duration_ms: 15000,
      elapsed_ms: 15000,
      reason: 'timer',
      match_id: TOKEN.matchId,
      period_seq: TOKEN.periodSeq,
    });
    expect(controller.getStatus().phase).toBe('ended');
    expect(controller.readPersisted()).toBeNull();
    void store;
  });

  it('ignores a stale persisted token', () => {
    const store = memStore({
      'openfc.period': JSON.stringify({
        matchId: 'yesterday',
        periodSeq: 1,
        mode: 'auto',
        durationMs: 15000,
        deviceId: null,
        savedAt: Date.now() - 3_600_000,
      }),
    });
    const { controller, of } = harness(store);
    expect(controller.restore()).toBe(false);
    expect(of('get_timer').length).toBe(0);
  });
});

describe('another host owns the board', () => {
  it('backs off when a foreign period is running', () => {
    const { controller, of } = harness();
    controller.start('auto', 15000, TOKEN);
    controller.handleEvent(
      running({ match_id: 'other-field', period_seq: 7 }),
    );
    expect(controller.getStatus().phase).toBe('rejected');
    expect(controller.getStatus().error).toBe('timer_active');
    // Nothing further may be sent at a board someone else is using.
    expect(of('start_period').length).toBe(1);
    expect(of('resync').length).toBe(0);
  });

  it('treats wrong_device as terminal', () => {
    const { controller } = harness();
    controller.start('auto', 15000, TOKEN, 'openfc-494274');
    controller.handleEvent({
      evt: 'error',
      reason: 'wrong_device',
      cmd: 'start_period',
    });
    expect(controller.getStatus().phase).toBe('rejected');
  });

  it('ignores a timer_expired belonging to another period', () => {
    const { controller } = harness();
    controller.start('auto', 15000, TOKEN);
    controller.handleEvent(running());
    controller.handleEvent({
      evt: 'timer_expired',
      mode: 'driver',
      duration_ms: 1000,
      elapsed_ms: 1000,
      reason: 'timer',
      match_id: 'someone-else',
      period_seq: 3,
    });
    expect(controller.getStatus().phase).toBe('running');
  });
});

describe('resync', () => {
  function live() {
    const h = harness();
    h.controller.start('auto', 60000, TOKEN, 'openfc-494274');
    h.controller.handleEvent(running({ duration_ms: 60000, remaining_ms: 30000 }));
    return h;
  }

  it('shortens without restriction', () => {
    const { controller, of } = live();
    expect(controller.resyncTo(10000)).toBe('sent');
    expect(of('resync')[0]).toEqual({
      cmd: 'resync',
      match_id: 'qm-42',
      period_seq: 1,
      device_id: 'openfc-494274',
      remaining_ms: 10000,
    });
  });

  it('refuses to send an extension the board would reject', () => {
    const { controller, of } = live();
    expect(controller.resyncTo(30000 + RESYNC_EXTEND_MAX_MS + 1)).toBe(
      'out_of_range',
    );
    expect(of('resync').length).toBe(0);
  });

  it('allows an extension inside the clamp', () => {
    const { controller } = live();
    expect(controller.resyncTo(30000 + RESYNC_EXTEND_MAX_MS - 100)).toBe('sent');
  });

  it('skips a correction too small to be worth a round trip', () => {
    const { controller, of } = live();
    expect(controller.resyncTo(30050)).toBe('skipped');
    expect(of('resync').length).toBe(0);
  });

  it('sends nothing when no period is running', () => {
    const { controller, of } = harness();
    expect(controller.resyncTo(10000)).toBe('skipped');
    expect(of('resync').length).toBe(0);
  });

  it('re-reads the board after a token_mismatch instead of assuming', () => {
    const { controller, of } = live();
    controller.handleEvent({
      evt: 'error',
      reason: 'token_mismatch',
      cmd: 'resync',
    });
    expect(of('get_timer').length).toBeGreaterThan(0);
    expect(controller.getStatus().phase).toBe('running');
  });

  it('keeps the period alive after resync_out_of_range', () => {
    const { controller } = live();
    controller.handleEvent({
      evt: 'error',
      reason: 'resync_out_of_range',
      cmd: 'resync',
    });
    expect(controller.getStatus().phase).toBe('running');
    expect(controller.getStatus().error).toBe('resync_out_of_range');
  });
});

describe('ending a period', () => {
  it('distinguishes an operator abort from a normal expiry', () => {
    const { controller } = harness();
    controller.start('driver', 105000, TOKEN);
    controller.handleEvent(running({ mode: 'driver' }));
    controller.end();
    controller.handleEvent({
      evt: 'timer_expired',
      mode: 'driver',
      duration_ms: 105000,
      elapsed_ms: 31400,
      reason: 'ended',
      match_id: TOKEN.matchId,
      period_seq: TOKEN.periodSeq,
    });
    expect(controller.getStatus().phase).toBe('aborted');
  });

  it('sends end_period with the token and binding', () => {
    const { controller, of } = harness();
    controller.start('auto', 15000, TOKEN, 'openfc-494274');
    controller.handleEvent(running());
    controller.end();
    expect(of('end_period')[0]).toEqual({
      cmd: 'end_period',
      match_id: 'qm-42',
      period_seq: 1,
      device_id: 'openfc-494274',
    });
  });

  it('does not try to end a period that is not running', () => {
    const { controller, of } = harness();
    controller.end();
    expect(of('end_period').length).toBe(0);
  });

  it('an estop ends the period', () => {
    const { controller } = harness();
    controller.start('auto', 15000, TOKEN);
    controller.handleEvent(running());
    controller.handleEvent({ evt: 'estop', source: 'software' });
    expect(controller.getStatus().phase).toBe('aborted');
  });
});

describe('countdown', () => {
  it('extrapolates from the board reading between reconciles', () => {
    const { controller } = harness();
    controller.start('auto', 15000, TOKEN);
    controller.handleEvent(running({ remaining_ms: 10000 }));
    clock += 400;
    controller.tick();
    expect(controller.getStatus().remainingMs).toBeCloseTo(9600, 0);
  });

  it('reconciles with the board about once a second', () => {
    const { controller, of } = harness();
    controller.start('auto', 15000, TOKEN);
    controller.handleEvent(running());
    for (let i = 0; i < 30; i++) {
      clock += 100;
      controller.tick();
    }
    const polls = of('get_timer').length;
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(polls).toBeLessThanOrEqual(4);
  });

  it('never counts below zero', () => {
    const { controller } = harness();
    controller.start('auto', 15000, TOKEN);
    controller.handleEvent(running({ remaining_ms: 200 }));
    clock += 5000;
    controller.tick();
    expect(controller.getStatus().remainingMs).toBe(0);
  });
});
