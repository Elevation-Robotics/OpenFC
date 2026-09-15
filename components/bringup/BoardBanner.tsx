'use client';

// Identity + live heartbeat for the V1_3 bring-up board. Mirrors the shape of
// app/console/page.tsx's BoardBanner, but reads bu_hello/bu_state directly
// via subscribe() instead of through SerialState (see
// lib/openfc-bringup-protocol.ts for why).

import { useEffect, useState } from 'react';
import { useSerial } from '@/components/SerialProvider';
import {
  BringupEvent,
  BringupHello,
  BringupState,
  isBringupEvent,
} from '@/lib/openfc-bringup-protocol';

export default function BoardBanner() {
  const { state, subscribe } = useSerial();
  const [hello, setHello] = useState<BringupHello | null>(null);
  const [hb, setHb] = useState<BringupState | null>(null);

  useEffect(() => {
    return subscribe((raw) => {
      if (!isBringupEvent(raw)) return;
      const evt = raw as unknown as BringupEvent;
      if (evt.evt === 'bu_hello') setHello(evt);
      else if (evt.evt === 'bu_state') setHb(evt);
    });
  }, [subscribe]);

  if (!state.connected && !state.reconnecting) return null;

  return (
    <div className="mb-6 rounded-lg border border-gray-700 bg-gray-900/50 px-4 py-3">
      <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <Field label="device_id" value={hello?.device_id ?? '—'} mono />
        <Field label="firmware" value={hello?.fw_version ?? '—'} />
        <Field label="hardware" value={hello?.hw_version ?? '—'} />
        <Field
          label="uptime"
          value={hb ? `${(hb.uptime_ms / 1000).toFixed(1)}s` : '—'}
        />
        <Field
          label="buttons"
          value={
            hb
              ? `boot:${hb.boot_btn ? 'down' : 'up'} btn1:${hb.btn1 ? 'down' : 'up'} btn2:${hb.btn2 ? 'down' : 'up'}`
              : '—'
          }
          mono
        />
        <Field
          label="rp2350 irq"
          value={hb ? (hb.rp2350_irq ? 'high' : 'low') : '—'}
          tone={hb?.rp2350_irq ? 'ok' : undefined}
        />
      </dl>
      {!hello && (
        <p className="mt-2 text-xs text-yellow-300">
          No bu_hello yet — click Ping or reconnect if this board isn&apos;t
          running the V1_3 bring-up firmware.
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
