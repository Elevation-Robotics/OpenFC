'use client';

// Protocol 3 console — unlisted. Nothing links here; it exists so the token,
// binding and resync behaviour can be exercised against real hardware without
// a serial terminal, and so a portal integration can be tried before it is
// wired into a field display.

import BrowserGate from '@/components/BrowserGate';
import ConnectButton from '@/components/ConnectButton';
import SiteFooter from '@/components/SiteFooter';
import ConformancePanel from '@/components/console/ConformancePanel';
import EventLog from '@/components/console/EventLog';
import PeriodPanel from '@/components/console/PeriodPanel';
import { useSerial } from '@/components/SerialProvider';
import { PROTO_TOKENS } from '@/lib/openfc-protocol';

export default function ConsolePage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <BrowserGate />
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Protocol console</h1>
          <p className="mt-1 text-sm text-gray-400">
            Period tokens, device binding and resync, against a real board.
          </p>
        </div>
        <ConnectButton />
      </div>

      <BoardBanner />

      <div className="space-y-6">
        <PeriodPanel />
        <ConformancePanel />
        <EventLog />
      </div>

      <p className="mt-8 text-xs text-gray-600">
        Unlisted diagnostic page. Everything here drives the board directly —
        clear the field before running anything.
      </p>
      <SiteFooter />
    </main>
  );
}

function BoardBanner() {
  const { state } = useSerial();
  if (!state.connected && !state.reconnecting) return null;

  const proto = state.proto;
  const tokensOk = (proto ?? 0) >= PROTO_TOKENS;

  return (
    <div className="mb-6 rounded-lg border border-gray-700 bg-gray-900/50 px-4 py-3">
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <Field label="device_id" value={state.deviceId ?? '—'} mono />
        <Field label="firmware" value={state.fwVersion ?? '—'} />
        <Field label="hardware" value={state.hwVersion ?? '—'} />
        <Field
          label="protocol"
          value={proto === null ? '—' : String(proto)}
          tone={proto === null ? undefined : tokensOk ? 'ok' : 'warn'}
        />
        <Field label="state" value={state.boardState ?? '—'} />
        <Field
          label="period"
          value={
            state.timedPeriod.active
              ? `${state.timedPeriod.mode} · ${Math.round(
                  state.timedPeriod.remainingMs / 100,
                ) / 10}s left`
              : 'idle'
          }
          tone={state.timedPeriod.active ? 'ok' : undefined}
        />
        <Field
          label="token"
          value={
            state.timedPeriod.matchId
              ? `${state.timedPeriod.matchId}/${state.timedPeriod.periodSeq}`
              : state.timedPeriod.lastMatchId
                ? `last: ${state.timedPeriod.lastMatchId}/${state.timedPeriod.lastPeriodSeq}`
                : '—'
          }
          mono
        />
      </dl>
      {proto !== null && !tokensOk && (
        <p className="mt-2 text-xs text-yellow-300">
          Protocol {proto} predates period tokens. The board will accept the
          commands but ignore the token fields, so a replayed start_period
          restarts the period instead of rejoining it.
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'ok' | 'warn';
}) {
  const color =
    tone === 'ok' ? 'text-green-300' : tone === 'warn' ? 'text-yellow-300' : 'text-gray-200';
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className={`${color} ${mono ? 'font-mono text-xs' : ''}`}>{value}</dd>
    </div>
  );
}
