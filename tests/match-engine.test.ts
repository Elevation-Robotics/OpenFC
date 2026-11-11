// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GAP_MAX_S,
  MATCH_PRESETS,
  MatchConfig,
  MatchEngine,
  PERIOD_MAX_S,
  PERIOD_MIN_S,
} from '@/lib/match-engine';
import { OpenFCEvent } from '@/lib/openfc-protocol';
import { v13Board } from '@/lib/match-board';

const FAKE = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'performance',
  'Date',
] as const;

function config(over: Partial<MatchConfig> = {}): MatchConfig {
  return {
    autoDurationMs: 15000,
    driverDurationMs: 90000,
    gapDurationMs: 5000,
    sequence: 'both',
    transitions: 'timed',
    ...over,
  };
}

function makeEngine(over: Partial<MatchConfig> = {}) {
  const sent: string[] = [];
  const engine = new MatchEngine(config(over), (line) => sent.push(line));
  const cmds = (name: string) => sent.filter((s) => s.includes(`"${name}"`));
  return { engine, sent, cmds };
}

const expired = (mode: 'auto' | 'driver'): OpenFCEvent => ({
  evt: 'timer_expired',
  mode,
  duration_ms: 1,
  elapsed_ms: 1,
});

beforeEach(() => vi.useFakeTimers({ toFake: [...FAKE] }));
afterEach(() => vi.useRealTimers());

describe('start + sequencing', () => {
  it('enters auto and sends start_period auto for a full match', () => {
    const { engine, cmds } = makeEngine();
    engine.start();
    expect(engine.getState().phase).toBe('auto');
    expect(cmds('start_period').some((s) => s.includes('auto'))).toBe(true);
    engine.destroy();
  });

  it('auto → gap → driver → done across a full match', () => {
    const { engine, cmds } = makeEngine();
    engine.start();
    engine.handleEvent(expired('auto'));
    expect(engine.getState().phase).toBe('gap');

    vi.advanceTimersByTime(5200); // gap countdown elapses
    expect(engine.getState().phase).toBe('driver');
    expect(cmds('start_period').some((s) => s.includes('driver'))).toBe(true);

    engine.handleEvent(expired('driver'));
    expect(engine.getState().phase).toBe('done');
    engine.destroy();
  });

  it('skips the gap when gapDurationMs is 0', () => {
    const { engine } = makeEngine({ gapDurationMs: 0 });
    engine.start();
    engine.handleEvent(expired('auto'));
    expect(engine.getState().phase).toBe('driver');
    engine.destroy();
  });

  it('auto-only sequence ends after the auto period', () => {
    const { engine } = makeEngine({ sequence: 'auto' });
    engine.start();
    expect(engine.getState().phase).toBe('auto');
    engine.handleEvent(expired('auto'));
    expect(engine.getState().phase).toBe('done');
    engine.destroy();
  });

  it('driver-only sequence starts directly in driver', () => {
    const { engine, cmds } = makeEngine({ sequence: 'driver' });
    engine.start();
    expect(engine.getState().phase).toBe('driver');
    expect(cmds('start_period').some((s) => s.includes('driver'))).toBe(true);
    engine.destroy();
  });
});

describe('manual transitions', () => {
  it('holds in waiting after auto instead of running a gap', () => {
    const { engine } = makeEngine({ transitions: 'manual' });
    engine.start();
    engine.handleEvent(expired('auto'));
    expect(engine.getState().phase).toBe('waiting');
    // The hold is indefinite: no countdown carries it into driver.
    vi.advanceTimersByTime(60000);
    expect(engine.getState().phase).toBe('waiting');
    engine.destroy();
  });

  it('advance() from waiting starts driver', () => {
    const { engine, cmds } = makeEngine({ transitions: 'manual' });
    engine.start();
    engine.handleEvent(expired('auto'));
    engine.advance();
    expect(engine.getState().phase).toBe('driver');
    expect(cmds('start_period').some((s) => s.includes('driver'))).toBe(true);
    engine.destroy();
  });

  it('advance() ends a running auto early and estops before re-arming', () => {
    const { engine, sent } = makeEngine({ transitions: 'manual' });
    engine.start();
    vi.advanceTimersByTime(3000);
    engine.advance();
    expect(engine.getState().phase).toBe('waiting');
    // The board rejects start_period while its own timer runs, so the early
    // end must cancel it first.
    expect(sent.some((s) => s.includes('"estop"'))).toBe(true);
    engine.advance();
    expect(engine.getState().phase).toBe('driver');
    const estopAt = sent.findIndex((s) => s.includes('"estop"'));
    const driverAt = sent.findIndex(
      (s) => s.includes('start_period') && s.includes('driver'),
    );
    expect(estopAt).toBeLessThan(driverAt);
    engine.destroy();
  });

  it('advance() during driver ends the match', () => {
    const { engine } = makeEngine({ transitions: 'manual' });
    engine.start();
    engine.handleEvent(expired('auto'));
    engine.advance();
    expect(engine.getState().phase).toBe('driver');
    engine.advance();
    expect(engine.getState().phase).toBe('done');
    engine.destroy();
  });

  it('advance() skips the remainder of a timed gap', () => {
    const { engine } = makeEngine({ transitions: 'timed' });
    engine.start();
    engine.handleEvent(expired('auto'));
    expect(engine.getState().phase).toBe('gap');
    engine.advance();
    expect(engine.getState().phase).toBe('driver');
    engine.destroy();
  });

  it('a single-period sequence ends rather than waiting', () => {
    const { engine } = makeEngine({ sequence: 'auto', transitions: 'manual' });
    engine.start();
    engine.handleEvent(expired('auto'));
    expect(engine.getState().phase).toBe('done');
    engine.destroy();
  });

  it('canAdvance() is false outside a live match', () => {
    const { engine } = makeEngine({ transitions: 'manual' });
    expect(engine.canAdvance()).toBe(false);
    engine.start();
    expect(engine.canAdvance()).toBe(true);
    engine.stop();
    expect(engine.canAdvance()).toBe(false);
    engine.destroy();
  });

  it('advance() is a no-op once the match is over', () => {
    const { engine, cmds } = makeEngine({ transitions: 'manual' });
    engine.start();
    engine.handleEvent(expired('auto'));
    engine.advance();
    engine.handleEvent(expired('driver'));
    expect(engine.getState().phase).toBe('done');
    const before = cmds('start_period').length;
    engine.advance();
    expect(engine.getState().phase).toBe('done');
    expect(cmds('start_period').length).toBe(before);
    engine.destroy();
  });

  it('stops pinging while waiting, since no period is armed', () => {
    const { engine, cmds } = makeEngine({ transitions: 'manual' });
    engine.start();
    engine.handleEvent(expired('auto'));
    const before = cmds('ping').length;
    vi.advanceTimersByTime(2000);
    expect(cmds('ping').length).toBe(before);
    engine.destroy();
  });
});

describe('safety transitions', () => {
  it('stop() sends estop and enters stopped', () => {
    const { engine, cmds } = makeEngine();
    engine.start();
    engine.stop();
    expect(engine.getState().phase).toBe('stopped');
    expect(cmds('estop').length).toBe(1);
    engine.destroy();
  });

  it('a watchdog estop during an active period enters error', () => {
    const { engine } = makeEngine();
    engine.start();
    engine.handleEvent({ evt: 'estop', source: 'watchdog' });
    expect(engine.getState().phase).toBe('error');
    engine.destroy();
  });

  it('falls back to advancing if no timer_expired arrives within 2s', () => {
    const { engine } = makeEngine({ sequence: 'auto', autoDurationMs: 1000 });
    engine.start();
    vi.advanceTimersByTime(1000 + 2000 + 200); // period + fallback window
    expect(engine.getState().phase).toBe('done');
    engine.destroy();
  });
});

describe('ping keepalive + sync', () => {
  it('pings ~every 250ms while active and stops after estop', () => {
    const { engine, cmds } = makeEngine({ sequence: 'auto', autoDurationMs: 5000 });
    engine.start();
    vi.advanceTimersByTime(1000);
    const after1s = cmds('ping').length;
    expect(after1s).toBeGreaterThanOrEqual(3);
    engine.stop();
    vi.advanceTimersByTime(1000);
    expect(cmds('ping').length).toBe(after1s);
    engine.destroy();
  });

  it('syncRemaining re-bases the countdown after a reconnect', () => {
    const { engine } = makeEngine({ sequence: 'auto', autoDurationMs: 15000 });
    engine.start();
    vi.advanceTimersByTime(1000);
    engine.syncRemaining(5000);
    vi.advanceTimersByTime(100);
    const remaining = engine.getState().timeRemainingMs;
    expect(remaining).toBeLessThanOrEqual(5000);
    expect(remaining).toBeGreaterThan(4500);
    engine.destroy();
  });
});

describe('reconnect resync', () => {
  it('trusts the board when it still has the period running', () => {
    const { engine, cmds } = makeEngine({ sequence: 'auto', autoDurationMs: 15000 });
    engine.start();
    const before = cmds('start_period').length;
    vi.advanceTimersByTime(1000);
    engine.resyncTimer(true, 5000);
    vi.advanceTimersByTime(100);
    expect(cmds('start_period').length).toBe(before);
    expect(engine.getState().timeRemainingMs).toBeLessThanOrEqual(5000);
    engine.destroy();
  });

  it('re-arms the board when start_period was lost while the link was down', () => {
    const { engine, cmds } = makeEngine({ sequence: 'auto', autoDurationMs: 15000 });
    engine.start();
    vi.advanceTimersByTime(1000);
    engine.resyncTimer(false, 0);
    const starts = cmds('start_period');
    expect(starts.length).toBe(2);
    expect(starts[1]).toContain('auto');
    engine.destroy();
  });

  it('does not re-arm for a period about to end', () => {
    const { engine, cmds } = makeEngine({ sequence: 'auto', autoDurationMs: 1000 });
    engine.start();
    vi.advanceTimersByTime(900);
    engine.resyncTimer(false, 0);
    expect(cmds('start_period').length).toBe(1);
    engine.destroy();
  });

  it('ignores a resync outside an active period', () => {
    const { engine, cmds } = makeEngine();
    engine.resyncTimer(false, 0);
    expect(cmds('start_period').length).toBe(0);
    engine.destroy();
  });

  it('re-arms with the running period\u2019s own token', () => {
    // Untokenised, this re-arm cannot tell a start_period lost on the wire
    // from a period that finished while the link was down, and in the second
    // case it re-enables the robots after the match. The token moves that
    // decision to the board.
    const { engine, cmds } = makeEngine({ sequence: 'auto', autoDurationMs: 15000 });
    engine.start();
    const first = JSON.parse(cmds('start_period')[0]);
    vi.advanceTimersByTime(1000);
    engine.resyncTimer(false, 0);
    const rearm = JSON.parse(cmds('start_period')[1]);
    expect(rearm.match_id).toBe(first.match_id);
    expect(rearm.period_seq).toBe(first.period_seq);
    engine.destroy();
  });
});

describe('period tokens', () => {
  it('gives every period a new sequence number', () => {
    // The board refuses to run a token it has retired, so reusing a sequence
    // number would have the driver period rejected with period_complete.
    const { engine, cmds } = makeEngine();
    engine.start();
    engine.handleEvent(expired('auto'));
    vi.advanceTimersByTime(5200);
    const starts = cmds('start_period').map((s) => JSON.parse(s));
    expect(starts.length).toBe(2);
    expect(starts[0].match_id).toBe(starts[1].match_id);
    expect(starts[1].period_seq).toBe(starts[0].period_seq + 1);
    engine.destroy();
  });

  it('keeps one match_id for the whole match, within the firmware limit', () => {
    const { engine, cmds } = makeEngine();
    engine.start();
    const { match_id: id } = JSON.parse(cmds('start_period')[0]);
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(id.length).toBeLessThanOrEqual(32);
    engine.destroy();
  });

  it('does not reuse a match_id across matches', () => {
    const a = makeEngine();
    const b = makeEngine();
    a.engine.start();
    b.engine.start();
    expect(JSON.parse(a.cmds('start_period')[0]).match_id).not.toBe(
      JSON.parse(b.cmds('start_period')[0]).match_id,
    );
    a.engine.destroy();
    b.engine.destroy();
  });
});

describe('presets', () => {
  it('have unique ids', () => {
    const ids = MATCH_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The board rejects a duration outside PERIOD_MIN_MS..PERIOD_MAX_MS, so a
  // preset that violates the bounds would fail only at match start.
  it('stay inside the durations the firmware accepts', () => {
    for (const p of MATCH_PRESETS) {
      expect(p.config.auto).toBeGreaterThanOrEqual(PERIOD_MIN_S);
      expect(p.config.auto).toBeLessThanOrEqual(PERIOD_MAX_S);
      expect(p.config.driver).toBeGreaterThanOrEqual(PERIOD_MIN_S);
      expect(p.config.driver).toBeLessThanOrEqual(PERIOD_MAX_S);
      expect(p.config.gap).toBeGreaterThanOrEqual(0);
      expect(p.config.gap).toBeLessThanOrEqual(GAP_MAX_S);
    }
  });

  it('each run to completion through the engine', () => {
    for (const p of MATCH_PRESETS) {
      const { engine, cmds } = makeEngine({
        autoDurationMs: p.config.auto * 1000,
        driverDurationMs: p.config.driver * 1000,
        gapDurationMs: p.config.gap * 1000,
        sequence: p.config.sequence,
      });
      engine.start();
      engine.handleEvent(expired(engine.getState().phase as 'auto' | 'driver'));
      if (p.config.sequence === 'both') {
        vi.advanceTimersByTime(p.config.gap * 1000 + 200);
        expect(engine.getState().phase).toBe('driver');
        engine.handleEvent(expired('driver'));
      }
      expect(engine.getState().phase).toBe('done');
      expect(cmds('start_period').length).toBe(
        p.config.sequence === 'both' ? 2 : 1,
      );
      engine.destroy();
    }
  });
});

describe('V1.3 board', () => {
  function makeV13(over: Partial<MatchConfig> = {}) {
    const sent: string[] = [];
    const push = (line: string) => sent.push(line);
    const engine = new MatchEngine(config(over), push, v13Board(push));
    const parsed = () => sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    const last = (name: string) => parsed().filter((c) => c.cmd === name).at(-1);
    return { engine, sent, parsed, last };
  }
  const bu = (evt: Record<string, unknown>) => evt as unknown as OpenFCEvent;

  it('drives the Smart ports and the legacy ports together', () => {
    const { engine, parsed, sent } = makeV13();
    engine.start();
    const cmds = parsed();
    expect(cmds).toContainEqual({ cmd: 'field_period', driver: 15000, auton: 15000 });
    expect(cmds).toContainEqual({ cmd: 'field_state', state: 'auton' });
    expect(cmds).toContainEqual({ cmd: 'legacy_set', enable: true, mode: 'auto' });
    // field_period goes first so the controllers count down the right period.
    const i = sent.findIndex((s) => s.includes('field_period'));
    const j = sent.findIndex((s) => s.includes('field_state'));
    expect(i).toBeLessThan(j);
    expect(sent.some((s) => s.includes('start_period') || s.includes('estop'))).toBe(false);
    engine.destroy();
  });

  it('ends the period itself when the countdown reaches zero', () => {
    const { engine, last } = makeV13({ sequence: 'auto', autoDurationMs: 1000 });
    engine.start();
    vi.advanceTimersByTime(1100);
    expect(engine.getState().phase).toBe('done');
    expect(last('field_state')).toEqual({ cmd: 'field_state', state: 'disabled' });
    expect(last('legacy_set')).toEqual({ cmd: 'legacy_set', enable: false, mode: 'driver' });
    engine.destroy();
  });

  it('runs auto then driver with a timed gap', () => {
    const { engine, last } = makeV13({ autoDurationMs: 1000, gapDurationMs: 500 });
    engine.start();
    vi.advanceTimersByTime(1100);
    expect(engine.getState().phase).toBe('gap');
    expect(last('field_state')).toEqual({ cmd: 'field_state', state: 'disabled' });
    vi.advanceTimersByTime(600);
    expect(engine.getState().phase).toBe('driver');
    expect(last('field_state')).toEqual({ cmd: 'field_state', state: 'driver' });
    expect(last('legacy_set')).toEqual({ cmd: 'legacy_set', enable: true, mode: 'driver' });
    engine.destroy();
  });

  it('treats bu_match_end as the period ending', () => {
    const { engine, last } = makeV13({ sequence: 'driver' });
    engine.start();
    engine.handleEvent(bu({ evt: 'bu_match_end' }));
    expect(engine.getState().phase).toBe('done');
    expect(last('legacy_set')).toEqual({ cmd: 'legacy_set', enable: false, mode: 'driver' });
    engine.destroy();
  });

  it('errors on the field watchdog and takes the legacy ports down', () => {
    const { engine, last } = makeV13();
    engine.start();
    engine.handleEvent(bu({ evt: 'bu_field_watchdog' }));
    expect(engine.getState().phase).toBe('error');
    expect(last('legacy_set')).toEqual({ cmd: 'legacy_set', enable: false, mode: 'driver' });
    engine.destroy();
  });

  it('disables everything on STOP', () => {
    const { engine, last } = makeV13();
    engine.start();
    engine.stop();
    expect(engine.getState().phase).toBe('stopped');
    expect(last('field_state')).toEqual({ cmd: 'field_state', state: 'disabled' });
    expect(last('legacy_set')).toEqual({ cmd: 'legacy_set', enable: false, mode: 'driver' });
    engine.destroy();
  });

  it('re-engages a disengaged board and re-sends the state', () => {
    const { engine, parsed } = makeV13();
    engine.start();
    engine.handleEvent(bu({ evt: 'bu_error', reason: 'not_engaged', cmd: 'field_state' }));
    const cmds = parsed();
    const k = cmds.findIndex((c) => c.cmd === 'field_engage');
    expect(cmds[k]).toEqual({ cmd: 'field_engage', on: true, interlock: false });
    expect(cmds[k + 1]).toEqual({ cmd: 'field_state', state: 'auton' });
    engine.destroy();
  });

  it('pings with the bring-up ping and never re-arms on reconnect', () => {
    const { engine, sent } = makeV13();
    engine.start();
    vi.advanceTimersByTime(600);
    expect(sent.filter((s) => s.includes('"ping"')).length).toBeGreaterThan(0);
    const before = sent.length;
    engine.resyncTimer(false, 0);
    expect(sent.length).toBe(before);
    engine.destroy();
  });
});
