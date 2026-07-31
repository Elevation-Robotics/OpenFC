// Protocol-3 conformance suite — exercises a real board over the wire and
// reports what it actually did.
//
// This exists because the guarantees proto 3 adds are all negative ones: the
// board must *not* restart a replayed period, must *not* obey a foreign
// device_id, must *not* re-run a retired token. None of that can be observed
// from normal use — a correct board and a board with the checks missing look
// identical until the day a host reloads mid-match. Each check below drives the
// board into the failure case deliberately and asserts on the reply.
//
// Safety: every check that enables outputs uses a short period and ends with an
// estop, and the suite refuses to run while a period it does not own is live.

import {
  BoardMode,
  OpenFCEvent,
  PeriodToken,
  cmd,
} from './openfc-protocol';

export type CheckOutcome = 'pass' | 'fail' | 'skip';

export interface CheckResult {
  id: string;
  title: string;
  /** Why this check matters, shown next to the result. */
  rationale: string;
  outcome: CheckOutcome;
  /** What the board actually did. */
  detail: string;
  /** Whether the outputs are driven at any point during this check. */
  enablesOutputs: boolean;
  durationMs: number;
}

/** Everything a check needs to talk to a board, injectable for tests. */
export interface ConformanceIO {
  send(line: string): void;
  /**
   * Resolve with the first event satisfying `match`, or null after `timeoutMs`.
   * Implementations must start listening before the caller's send lands.
   */
  waitFor(
    match: (evt: OpenFCEvent) => boolean,
    timeoutMs: number,
  ): Promise<OpenFCEvent | null>;
  /**
   * Observe every event until the returned function is called. Needed for
   * assertions about what the board did *not* send: an estop following a
   * timer_expired arrives in the same read as it, so a check that waits for one
   * event and then starts looking for the other has already missed it.
   */
  watch(fn: (evt: OpenFCEvent) => void): () => void;
  delay(ms: number): Promise<void>;
  /** The board's own id, from hello. Required for the binding checks. */
  deviceId: string | null;
}

export interface ConformanceOptions {
  /** Skip anything that turns the robots on. */
  dryRun?: boolean;
  onProgress?: (result: CheckResult) => void;
}

/** Reply timeout. The board answers in single-digit ms; this is generous. */
const REPLY_TIMEOUT_MS = 1500;

/** Period length for checks that must observe a running countdown. */
const PROBE_PERIOD_MS = 4000;

const isErr = (reason: string) => (e: OpenFCEvent) =>
  e.evt === 'error' && e.reason === reason;
const isAck = (c: string) => (e: OpenFCEvent) => e.evt === 'ack' && e.cmd === c;

let seqCounter = Math.floor(Date.now() / 1000) % 100000;
/** Sequence numbers must never repeat on a board, so never restart at 1. */
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

export interface Check {
  id: string;
  title: string;
  rationale: string;
  enablesOutputs: boolean;
  run(io: ConformanceIO): Promise<{ outcome: CheckOutcome; detail: string }>;
}

/** Read the board's view of the timer in one round trip. */
async function readTimer(io: ConformanceIO): Promise<OpenFCEvent | null> {
  const p = io.waitFor((e) => e.evt === 'timer_state', REPLY_TIMEOUT_MS);
  io.send(cmd.getTimer());
  return p;
}

/** Stop anything running and wait for the board to settle. */
async function safeStop(io: ConformanceIO): Promise<void> {
  io.send(cmd.estop());
  await io.delay(150);
}

async function startProbe(
  io: ConformanceIO,
  token: PeriodToken,
  mode: BoardMode = 'auto',
  durationMs: number = PROBE_PERIOD_MS,
): Promise<OpenFCEvent | null> {
  const p = io.waitFor(
    (e) => isAck('start_period')(e) || e.evt === 'error',
    REPLY_TIMEOUT_MS,
  );
  io.send(
    cmd.startPeriod(mode, durationMs, {
      ...token,
      deviceId: io.deviceId ?? undefined,
    }),
  );
  return p;
}

export const CHECKS: Check[] = [
  {
    id: 'proto',
    title: 'Board reports protocol 3',
    rationale:
      'Everything below is a proto-3 guarantee. On an older board the extra fields are ignored, and a replayed start_period restarts the match instead of being recognised.',
    enablesOutputs: false,
    async run(io) {
      const p = io.waitFor((e) => e.evt === 'hello', REPLY_TIMEOUT_MS);
      io.send(cmd.getInfo());
      const hello = await p;
      if (!hello || hello.evt !== 'hello') {
        return { outcome: 'fail', detail: 'No hello within 1.5 s.' };
      }
      const proto = hello.proto ?? 1;
      return {
        outcome: proto >= 3 ? 'pass' : 'fail',
        detail: `proto ${proto}, firmware ${hello.fw_version}, device ${hello.device_id}.`,
      };
    },
  },
  {
    id: 'idle',
    title: 'No period is running',
    rationale:
      'The suite drives the board into deliberate failure cases. Doing that while someone else has a match live would interfere with it.',
    enablesOutputs: false,
    async run(io) {
      const t = await readTimer(io);
      if (!t || t.evt !== 'timer_state') {
        return { outcome: 'fail', detail: 'No timer_state within 1.5 s.' };
      }
      if (t.active) {
        return {
          outcome: 'fail',
          detail: `A period is running (${t.match_id ?? 'untokenised'}, ${t.remaining_ms} ms left). Stop it before running the suite.`,
        };
      }
      return { outcome: 'pass', detail: 'Board is idle.' };
    },
  },
  {
    id: 'invalid-token',
    title: 'Half a token is rejected',
    rationale:
      'match_id without period_seq, or an over-long match_id, would silently truncate into a token that collides with someone else\u2019s.',
    enablesOutputs: false,
    async run(io) {
      const p = io.waitFor(
        (e) => e.evt === 'error' || isAck('start_period')(e),
        REPLY_TIMEOUT_MS,
      );
      // match_id with no period_seq.
      io.send(
        JSON.stringify({
          cmd: 'start_period',
          mode: 'auto',
          duration_ms: 1000,
          match_id: 'conformance-partial',
        }),
      );
      const r = await p;
      if (r && isErr('invalid_token')(r)) {
        return { outcome: 'pass', detail: 'Rejected with invalid_token.' };
      }
      if (r && isAck('start_period')(r)) {
        await safeStop(io);
        return {
          outcome: 'fail',
          detail: 'Board started a period from a half-formed token.',
        };
      }
      return {
        outcome: 'fail',
        detail: r && r.evt === 'error' ? `Wrong reason: ${r.reason}.` : 'No reply.',
      };
    },
  },
  {
    id: 'wrong-device',
    title: 'A command for another board is refused',
    rationale:
      'Every OpenFC enumerates under the same USB name. On a multi-field event the wrong pick in the port chooser is one click away, and this is the only thing that catches it.',
    enablesOutputs: false,
    async run(io) {
      if (!io.deviceId) {
        return { outcome: 'skip', detail: 'Board identity unknown.' };
      }
      const p = io.waitFor(
        (e) => e.evt === 'error' || isAck('start_period')(e),
        REPLY_TIMEOUT_MS,
      );
      io.send(
        cmd.startPeriod('auto', 1000, {
          matchId: 'conformance-wrongdev',
          periodSeq: nextSeq(),
          deviceId: 'openfc-000000',
        }),
      );
      const r = await p;
      if (r && isErr('wrong_device')(r)) {
        return {
          outcome: 'pass',
          detail: `Refused a command addressed to openfc-000000 (this is ${io.deviceId}).`,
        };
      }
      if (r && isAck('start_period')(r)) {
        await safeStop(io);
        return {
          outcome: 'fail',
          detail: 'Board obeyed a command addressed to a different device_id.',
        };
      }
      return {
        outcome: 'fail',
        detail: r && r.evt === 'error' ? `Wrong reason: ${r.reason}.` : 'No reply.',
      };
    },
  },
  {
    id: 'replay',
    title: 'Replaying a running period does not restart it',
    rationale:
      'The whole point of the design. A host that reloads mid-match re-sends its start_period; if the board treats that as a new period the countdown jumps back to full and the match silently gains time.',
    enablesOutputs: true,
    async run(io) {
      const token = { matchId: 'conf-replay', periodSeq: nextSeq() };
      const started = await startProbe(io, token);
      if (!started || started.evt === 'error') {
        return {
          outcome: 'fail',
          detail: `Could not start: ${started?.evt === 'error' ? started.reason : 'no reply'}.`,
        };
      }
      await io.delay(1200);
      const before = await readTimer(io);
      if (!before || before.evt !== 'timer_state' || !before.active) {
        await safeStop(io);
        return { outcome: 'fail', detail: 'Period was not running after start.' };
      }
      // The reload: same token, same duration, as a returning host would send.
      await startProbe(io, token);
      await io.delay(120);
      const after = await readTimer(io);
      await safeStop(io);
      if (!after || after.evt !== 'timer_state' || !after.active) {
        return { outcome: 'fail', detail: 'Period vanished after the replay.' };
      }
      const b = before.remaining_ms ?? 0;
      const a = after.remaining_ms ?? 0;
      if (a > b) {
        return {
          outcome: 'fail',
          detail: `Countdown jumped back: ${b} ms → ${a} ms. The replay restarted the period.`,
        };
      }
      return {
        outcome: 'pass',
        detail: `Countdown kept running: ${b} ms → ${a} ms. Token echoed as ${after.match_id}/${after.period_seq}.`,
      };
    },
  },
  {
    id: 'foreign-token',
    title: 'A different token cannot preempt a running period',
    rationale:
      'Two hosts, one board. Whoever started the match owns it — a second host must be told no rather than quietly taking the field over.',
    enablesOutputs: true,
    async run(io) {
      const mine = { matchId: 'conf-owner', periodSeq: nextSeq() };
      const started = await startProbe(io, mine);
      if (!started || started.evt === 'error') {
        return { outcome: 'fail', detail: 'Could not start the owning period.' };
      }
      await io.delay(200);
      const p = io.waitFor(
        (e) => e.evt === 'error' || isAck('start_period')(e),
        REPLY_TIMEOUT_MS,
      );
      io.send(
        cmd.startPeriod('driver', 30000, {
          matchId: 'conf-intruder',
          periodSeq: nextSeq(),
          deviceId: io.deviceId ?? undefined,
        }),
      );
      const r = await p;
      const after = await readTimer(io);
      await safeStop(io);
      if (r && isErr('timer_active')(r)) {
        const stillMine =
          after?.evt === 'timer_state' && after.match_id === mine.matchId;
        return stillMine
          ? { outcome: 'pass', detail: 'Rejected with timer_active; the original period kept the field.' }
          : { outcome: 'fail', detail: 'Rejected, but the running period changed anyway.' };
      }
      return {
        outcome: 'fail',
        detail:
          r && r.evt === 'error'
            ? `Wrong reason: ${r.reason}.`
            : 'A second host was allowed to preempt a live match.',
      };
    },
  },
  {
    id: 'retired',
    title: 'A finished period cannot be restarted',
    rationale:
      'The re-enable hole. A host that dies just before the buzzer comes back, sees no period running, replays its start_period — and without this the robots turn back on after the match is over.',
    enablesOutputs: true,
    async run(io) {
      const token = { matchId: 'conf-retired', periodSeq: nextSeq() };
      const started = await startProbe(io, token, 'auto', 1200);
      if (!started || started.evt === 'error') {
        return { outcome: 'fail', detail: 'Could not start the probe period.' };
      }
      // Let it run out on its own — retirement must survive a natural expiry.
      const expiry = await io.waitFor((e) => e.evt === 'timer_expired', 3000);
      if (!expiry) {
        await safeStop(io);
        return { outcome: 'fail', detail: 'No timer_expired within 3 s.' };
      }
      const idle = await readTimer(io);
      const reportsLast =
        idle?.evt === 'timer_state' &&
        idle.last_match_id === token.matchId &&
        idle.last_period_seq === token.periodSeq;

      const p = io.waitFor(
        (e) => e.evt === 'error' || isAck('start_period')(e),
        REPLY_TIMEOUT_MS,
      );
      io.send(
        cmd.startPeriod('auto', 1200, {
          ...token,
          deviceId: io.deviceId ?? undefined,
        }),
      );
      const r = await p;
      if (r && isAck('start_period')(r)) {
        await safeStop(io);
        return {
          outcome: 'fail',
          detail: 'The board re-ran a finished period. Robots would have been re-enabled after the match.',
        };
      }
      if (r && isErr('period_complete')(r)) {
        return {
          outcome: 'pass',
          detail: reportsLast
            ? 'Refused with period_complete, and get_timer reports the retired token.'
            : 'Refused with period_complete, but get_timer did not report last_match_id.',
        };
      }
      return {
        outcome: 'fail',
        detail: r && r.evt === 'error' ? `Wrong reason: ${r.reason}.` : 'No reply.',
      };
    },
  },
  {
    id: 'retired-earlier',
    title: 'An earlier period of the same match stays retired',
    rationale:
      'A real match is two periods, not one. If finishing the driver period forgets that auto already ran, a host replaying its auto start_period gets a second autonomous period with the robots enabled — the same re-enable hole, one period further back.',
    enablesOutputs: true,
    async run(io) {
      const matchId = 'conf-two';
      const first = { matchId, periodSeq: nextSeq() };
      const second = { matchId, periodSeq: nextSeq() };

      for (const token of [first, second]) {
        const started = await startProbe(io, token, 'auto', 1200);
        if (!started || started.evt === 'error') {
          await safeStop(io);
          return {
            outcome: 'fail',
            detail: `Could not start period ${token.periodSeq}: ${started?.evt === 'error' ? started.reason : 'no reply'}.`,
          };
        }
        if (!(await io.waitFor((e) => e.evt === 'timer_expired', 3000))) {
          await safeStop(io);
          return {
            outcome: 'fail',
            detail: `No timer_expired for period ${token.periodSeq} within 3 s.`,
          };
        }
      }

      // Replay the *first* period, the one a single retirement slot forgets.
      const p = io.waitFor(
        (e) => e.evt === 'error' || isAck('start_period')(e),
        REPLY_TIMEOUT_MS,
      );
      io.send(
        cmd.startPeriod('auto', 1200, {
          ...first,
          deviceId: io.deviceId ?? undefined,
        }),
      );
      const r = await p;
      if (r && isAck('start_period')(r)) {
        await safeStop(io);
        return {
          outcome: 'fail',
          detail:
            'The board re-ran the first period after the second one finished. Retirement only remembers the most recent period, so every earlier period of a match is replayable.',
        };
      }
      if (r && isErr('period_complete')(r)) {
        const idle = await readTimer(io);
        const highWater =
          idle?.evt === 'timer_state' &&
          idle.last_match_id === matchId &&
          (idle.last_period_seq ?? 0) >= second.periodSeq;
        return {
          outcome: 'pass',
          detail: highWater
            ? 'Refused with period_complete, and get_timer reports the match high-water seq.'
            : 'Refused with period_complete, but get_timer did not report the later seq as the high-water mark.',
        };
      }
      return {
        outcome: 'fail',
        detail: r && r.evt === 'error' ? `Wrong reason: ${r.reason}.` : 'No reply.',
      };
    },
  },
  {
    id: 'resync-shorten',
    title: 'Resync can shorten a period',
    rationale:
      'The host clock is authoritative when it says the match has less time left than the board thinks; cutting a period short is never a safety risk.',
    enablesOutputs: true,
    async run(io) {
      const token = { matchId: 'conf-shorten', periodSeq: nextSeq() };
      const started = await startProbe(io, token, 'auto', 8000);
      if (!started || started.evt === 'error') {
        return { outcome: 'fail', detail: 'Could not start the probe period.' };
      }
      await io.delay(200);
      const p = io.waitFor(
        (e) => isAck('resync')(e) || e.evt === 'error',
        REPLY_TIMEOUT_MS,
      );
      io.send(
        cmd.resync({ ...token, deviceId: io.deviceId ?? undefined }, 2000),
      );
      const r = await p;
      const after = await readTimer(io);
      await safeStop(io);
      if (!r || r.evt !== 'ack') {
        return {
          outcome: 'fail',
          detail: r?.evt === 'error' ? `Rejected: ${r.reason}.` : 'No ack.',
        };
      }
      const remaining = after?.evt === 'timer_state' ? after.remaining_ms ?? 0 : 0;
      if (remaining > 2500) {
        return {
          outcome: 'fail',
          detail: `Acked but the deadline did not move: ${remaining} ms left.`,
        };
      }
      return {
        outcome: 'pass',
        detail: `Shortened to ~2 s (${remaining} ms left), delta_ms ${r.delta_ms}.`,
      };
    },
  },
  {
    id: 'resync-clamp',
    title: 'Resync cannot extend a period by more than 2 s',
    rationale:
      'An extension keeps robots live past when the match says they should be. A host asking for a big one has a throttled browser timer, not a longer match.',
    enablesOutputs: true,
    async run(io) {
      const token = { matchId: 'conf-clamp', periodSeq: nextSeq() };
      const started = await startProbe(io, token, 'auto', 3000);
      if (!started || started.evt === 'error') {
        return { outcome: 'fail', detail: 'Could not start the probe period.' };
      }
      await io.delay(200);
      const p = io.waitFor(
        (e) => isAck('resync')(e) || e.evt === 'error',
        REPLY_TIMEOUT_MS,
      );
      io.send(
        cmd.resync({ ...token, deviceId: io.deviceId ?? undefined }, 120000),
      );
      const r = await p;
      const after = await readTimer(io);
      await safeStop(io);
      if (r && isErr('resync_out_of_range')(r)) {
        const remaining =
          after?.evt === 'timer_state' ? after.remaining_ms ?? 0 : 0;
        return remaining <= 5000
          ? { outcome: 'pass', detail: `Refused a 2-minute extension; ${remaining} ms still left.` }
          : { outcome: 'fail', detail: 'Refused, but the deadline moved anyway.' };
      }
      return {
        outcome: 'fail',
        detail:
          r?.evt === 'ack'
            ? 'The board accepted a 2-minute extension of a 3-second period.'
            : `Unexpected reply: ${r?.evt === 'error' ? r.reason : 'none'}.`,
      };
    },
  },
  {
    id: 'end-period',
    title: 'end_period stops the match without reporting a fault',
    rationale:
      'A referee stopping a match early is a normal event. Reported as an estop it would show up as a hardware alarm on the field display every single time.',
    enablesOutputs: true,
    async run(io) {
      const token = { matchId: 'conf-end', periodSeq: nextSeq() };
      const started = await startProbe(io, token, 'driver', 20000);
      if (!started || started.evt === 'error') {
        return { outcome: 'fail', detail: 'Could not start the probe period.' };
      }
      await io.delay(200);
      // An estop would arrive alongside the timer_expired, so watch for both
      // at once rather than looking for the second after seeing the first.
      let sawEstop = false;
      const stopWatching = io.watch((e) => {
        if (e.evt === 'estop') sawEstop = true;
      });
      const settled = io.waitFor((e) => e.evt === 'timer_expired', REPLY_TIMEOUT_MS);
      io.send(cmd.endPeriod({ ...token, deviceId: io.deviceId ?? undefined }));
      const expiry = await settled;
      await io.delay(100);
      stopWatching();
      const after = await readTimer(io);
      await safeStop(io);
      if (!expiry || expiry.evt !== 'timer_expired') {
        return { outcome: 'fail', detail: 'No timer_expired after end_period.' };
      }
      if (expiry.reason !== 'ended') {
        return {
          outcome: 'fail',
          detail: `Reported reason "${expiry.reason ?? 'none'}" instead of "ended".`,
        };
      }
      const stillRunning = after?.evt === 'timer_state' && after.active;
      if (stillRunning) {
        return { outcome: 'fail', detail: 'Period was still running afterwards.' };
      }
      return {
        outcome: sawEstop ? 'fail' : 'pass',
        detail: sawEstop
          ? 'Stopped correctly, but also raised an estop — an operator abort is not a fault.'
          : `Stopped with reason "ended" after ${expiry.elapsed_ms} ms, no estop raised.`,
      };
    },
  },
  {
    id: 'token-mismatch',
    title: 'A stale token cannot end someone else\u2019s period',
    rationale:
      'end_period and resync must name the period that is actually running, or a host holding an old token could stop a match it has nothing to do with.',
    enablesOutputs: true,
    async run(io) {
      const token = { matchId: 'conf-mismatch', periodSeq: nextSeq() };
      const started = await startProbe(io, token, 'auto', 5000);
      if (!started || started.evt === 'error') {
        return { outcome: 'fail', detail: 'Could not start the probe period.' };
      }
      await io.delay(200);
      const p = io.waitFor(
        (e) => e.evt === 'error' || isAck('end_period')(e),
        REPLY_TIMEOUT_MS,
      );
      io.send(
        cmd.endPeriod({
          matchId: token.matchId,
          periodSeq: token.periodSeq + 1,
          deviceId: io.deviceId ?? undefined,
        }),
      );
      const r = await p;
      const after = await readTimer(io);
      await safeStop(io);
      if (r && isErr('token_mismatch')(r)) {
        return after?.evt === 'timer_state' && after.active
          ? { outcome: 'pass', detail: 'Refused with token_mismatch; the period kept running.' }
          : { outcome: 'fail', detail: 'Refused, but the period stopped anyway.' };
      }
      return {
        outcome: 'fail',
        detail:
          r?.evt === 'ack'
            ? 'A stale token was allowed to end a running period.'
            : `Unexpected reply: ${r?.evt === 'error' ? r.reason : 'none'}.`,
      };
    },
  },
  {
    id: 'estop-ungated',
    title: 'estop works with no token and no device_id',
    rationale:
      'Anything that can reach the board must be able to stop the robots. A rejected estop is a far worse failure than one delivered to the wrong field.',
    enablesOutputs: true,
    async run(io) {
      const token = { matchId: 'conf-estop', periodSeq: nextSeq() };
      const started = await startProbe(io, token, 'auto', 10000);
      if (!started || started.evt === 'error') {
        return { outcome: 'fail', detail: 'Could not start the probe period.' };
      }
      await io.delay(200);
      const p = io.waitFor((e) => e.evt === 'estop' || e.evt === 'error', 2000);
      io.send(cmd.estop());
      const r = await p;
      await io.delay(150);
      const after = await readTimer(io);
      if (r?.evt === 'error') {
        return { outcome: 'fail', detail: `estop was rejected: ${r.reason}.` };
      }
      const stillRunning = after?.evt === 'timer_state' && after.active;
      if (stillRunning) {
        await safeStop(io);
        return { outcome: 'fail', detail: 'estop did not stop the period.' };
      }
      return {
        outcome: 'pass',
        detail: 'Bare estop stopped a bound period immediately.',
      };
    },
  },
];

/**
 * Run the suite in order, reporting each result as it lands. Stops early if the
 * board is not on proto 3 or is already running a period — every later check
 * would be meaningless, and some would interfere with a live match.
 */
export async function runConformance(
  io: ConformanceIO,
  opts: ConformanceOptions = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  let halted = false;

  for (const check of CHECKS) {
    const skipReason = halted
      ? 'Skipped: an earlier check failed in a way that makes this one unsafe or meaningless.'
      : opts.dryRun && check.enablesOutputs
        ? 'Skipped: this check enables the outputs and dry run is on.'
        : null;

    let result: CheckResult;
    if (skipReason) {
      result = {
        id: check.id,
        title: check.title,
        rationale: check.rationale,
        outcome: 'skip',
        detail: skipReason,
        enablesOutputs: check.enablesOutputs,
        durationMs: 0,
      };
    } else {
      const startedAt = Date.now();
      try {
        const { outcome, detail } = await check.run(io);
        result = {
          id: check.id,
          title: check.title,
          rationale: check.rationale,
          outcome,
          detail,
          enablesOutputs: check.enablesOutputs,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        // A throwing check must still leave the board safe.
        try {
          io.send(cmd.estop());
        } catch {
          // ignore
        }
        result = {
          id: check.id,
          title: check.title,
          rationale: check.rationale,
          outcome: 'fail',
          detail: err instanceof Error ? err.message : 'Check threw.',
          enablesOutputs: check.enablesOutputs,
          durationMs: Date.now() - startedAt,
        };
      }
      // These two are preconditions, not findings.
      if (
        (check.id === 'proto' || check.id === 'idle') &&
        result.outcome === 'fail'
      ) {
        halted = true;
      }
    }

    results.push(result);
    opts.onProgress?.(result);
  }
  return results;
}

export function summarise(results: CheckResult[]): {
  pass: number;
  fail: number;
  skip: number;
} {
  return {
    pass: results.filter((r) => r.outcome === 'pass').length,
    fail: results.filter((r) => r.outcome === 'fail').length,
    skip: results.filter((r) => r.outcome === 'skip').length,
  };
}
