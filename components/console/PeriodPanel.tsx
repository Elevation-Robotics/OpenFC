'use client';

// Live tokenised period control — the portal integration, exercised by hand.
// Start a period, reload the page, and the token comes back from storage and is
// reconciled against the board rather than restarted.

import { useState } from 'react';
import { usePeriodController } from './usePeriodController';
import { useSerial, useSerialCommands } from '../SerialProvider';
import { PROTO_TOKENS } from '@/lib/openfc-protocol';
import { PeriodStatus } from '@/lib/period-controller';

const PHASE_STYLE: Record<PeriodStatus['phase'], string> = {
  idle: 'text-gray-400',
  arming: 'text-yellow-300',
  running: 'text-green-300',
  ended: 'text-gray-300',
  aborted: 'text-yellow-300',
  rejected: 'text-red-300',
};

function fmt(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  return total.toFixed(1) + 's';
}

export default function PeriodPanel() {
  const { state } = useSerial();
  const c = useSerialCommands();
  const period = usePeriodController();
  const [mode, setMode] = useState<'auto' | 'driver'>('auto');
  const [seconds, setSeconds] = useState(60);
  const [resyncTo, setResyncTo] = useState(30);
  const [resyncNote, setResyncNote] = useState<string | null>(null);

  const s = period.status;
  const live = s.phase === 'running' || s.phase === 'arming';
  const protoOk = (state.proto ?? 0) >= PROTO_TOKENS;

  const doResync = () => {
    const outcome = period.resyncTo(resyncTo * 1000);
    setResyncNote(
      outcome === 'sent'
        ? `Sent resync to ${resyncTo}s.`
        : outcome === 'out_of_range'
          ? 'Not sent: that would extend the period by more than 2s, which the board refuses. Shorten instead, or let it run.'
          : 'Not sent: no running period, or the board is already within 150ms of that.',
    );
  };

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900/50 p-5">
      <h2 className="text-lg font-semibold">Tokenised period</h2>
      <p className="mt-1 max-w-2xl text-sm text-gray-400">
        Start a period, then reload this page. The token is recovered from
        storage and reconciled against the board — if the period is still
        running you rejoin it, and if it finished while you were away the board
        says so instead of starting it again.
      </p>

      {state.connected && !protoOk && (
        <p className="mt-3 rounded-md border border-yellow-700 bg-yellow-950/40 px-3 py-2 text-sm text-yellow-200">
          This board reports protocol {state.proto ?? 'unknown'}. Tokens need 3
          (firmware 1.4.0). It will ignore them and treat every start_period as a
          new period.
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-[auto_auto_1fr]">
        <label className="flex items-center gap-2 text-sm text-gray-300">
          Mode
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as 'auto' | 'driver')}
            disabled={live}
            className="rounded-md border border-gray-600 bg-gray-950 px-2 py-1 text-gray-100 disabled:opacity-50"
          >
            <option value="auto">auto</option>
            <option value="driver">driver</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          Duration
          <input
            type="number"
            min={1}
            max={600}
            value={seconds}
            onChange={(e) => setSeconds(Number(e.target.value))}
            disabled={live}
            className="w-20 rounded-md border border-gray-600 bg-gray-950 px-2 py-1 text-right font-mono text-gray-100 disabled:opacity-50"
          />
          <span className="text-gray-500">sec</span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          onClick={() => period.start(mode, seconds * 1000)}
          disabled={!state.connected || live}
          className="rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start period
        </button>
        <button
          onClick={period.reassert}
          disabled={!s.token}
          className="rounded-md border border-gray-600 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-40"
          title="Re-send the same start_period, exactly as a reconnecting host would."
        >
          Replay start_period
        </button>
        <button
          onClick={period.end}
          disabled={!live}
          className="rounded-md border border-gray-600 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-40"
        >
          End early
        </button>
        <button
          onClick={period.reconcile}
          disabled={!state.connected}
          className="rounded-md border border-gray-600 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-40"
        >
          get_timer
        </button>
        <button
          onClick={() => void c.estop()}
          disabled={!state.connected}
          className="rounded-md bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-40"
        >
          E-STOP
        </button>
        <button
          onClick={period.clear}
          className="rounded-md border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:bg-gray-800"
          title="Forget the local token without touching the board."
        >
          Clear
        </button>
      </div>

      <PeriodReadout status={s} restored={period.restored} />

      <div className="mt-4 border-t border-gray-800 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-300">Resync board to</span>
          <input
            type="number"
            min={0}
            max={600}
            value={resyncTo}
            onChange={(e) => setResyncTo(Number(e.target.value))}
            className="w-20 rounded-md border border-gray-600 bg-gray-950 px-2 py-1 text-right font-mono text-gray-100"
          />
          <span className="text-sm text-gray-500">sec remaining</span>
          <button
            onClick={doResync}
            disabled={s.phase !== 'running'}
            className="rounded-md border border-gray-600 px-3 py-1.5 text-sm text-gray-200 hover:bg-gray-800 disabled:opacity-40"
          >
            Send resync
          </button>
        </div>
        <p className="mt-1 text-xs text-gray-500">
          Shortening is unrestricted. Extending is capped at 2s by the board —
          its crystal drifts about 12ms over a two-minute match, a backgrounded
          browser tab drifts far more, so a large correction means the host is
          wrong.
        </p>
        {resyncNote && <p className="mt-1 text-xs text-gray-400">{resyncNote}</p>}
      </div>
    </section>
  );
}

function PeriodReadout({
  status: s,
  restored,
}: {
  status: PeriodStatus;
  restored: boolean;
}) {
  return (
    <div className="mt-4 rounded-lg border border-gray-800 bg-gray-950/60 p-3">
      {restored && s.phase === 'arming' && (
        <p className="mb-2 text-sm text-yellow-300">
          Recovered a token from a previous page load — asking the board what
          became of it.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <Row label="Phase">
          <span className={PHASE_STYLE[s.phase]}>{s.phase}</span>
          {s.recovered && (
            <span className="ml-2 text-xs text-gray-500">(from the board)</span>
          )}
        </Row>
        <Row label="Remaining">
          <span className="font-mono">{fmt(s.remainingMs)}</span>
        </Row>
        <Row label="Board said">
          <span className="font-mono">
            {s.boardRemainingMs === null ? '—' : fmt(s.boardRemainingMs)}
          </span>
        </Row>
        <Row label="match_id">
          <span className="font-mono text-xs">{s.token?.matchId ?? '—'}</span>
        </Row>
        <Row label="period_seq">
          <span className="font-mono">{s.token?.periodSeq ?? '—'}</span>
        </Row>
        <Row label="Drift">
          <span className="font-mono">
            {s.driftMs === null ? '—' : `${s.driftMs > 0 ? '+' : ''}${s.driftMs}ms`}
          </span>
        </Row>
        <Row label="Bound">{s.bound ? 'yes' : 'no'}</Row>
        <Row label="device_id">
          <span className="font-mono text-xs">{s.deviceId ?? '—'}</span>
        </Row>
        <Row label="Last error">
          <span className={s.error ? 'text-red-300' : ''}>{s.error ?? '—'}</span>
        </Row>
      </dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className="text-gray-200">{children}</dd>
    </div>
  );
}
