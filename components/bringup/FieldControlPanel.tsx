'use client';

// The real field-control engine (ported OpenFC-Smart session protocol),
// driving Smart ports A and B in unison. Engage owns the buses (raw port
// diagnostics are refused while engaged); the commanded state applies to
// every linked controller, queuing per-port until that port reaches A7
// field mode (robot radio linked).
//
// Operational notes carried over from the proven bench workflow:
//  - Treat Engage as "field power on". If a controller sits unlinked and
//    won't grant a session, power-cycle IT while engaged — the engine stays
//    armed and catches the cold window automatically.
//  - Session commit can take ~15 s of request/answer cycling after engage.
//  - The firmware auto-disables driver/auton if this page stops pinging for
//    2.5 s (closing the tab is an e-stop).

import { useEffect, useRef, useState } from 'react';
import { useSerial } from '@/components/SerialProvider';
import {
  BringupEvent,
  BringupFieldState,
  FieldState,
  bringupCmd,
  isBringupEvent,
} from '@/lib/openfc-bringup-protocol';

const FM_LABEL: Record<number, { text: string; tone: string }> = {
  0: { text: 'no stream', tone: 'text-gray-500' },
  1: { text: 'A0 joystick-only (no field UI yet)', tone: 'text-yellow-300' },
  2: { text: 'A7 FIELD MODE', tone: 'text-green-300' },
};

export default function FieldControlPanel() {
  const { state, subscribe, send } = useSerial();
  const [field, setField] = useState<BringupFieldState | null>(null);
  const fieldRef = useRef(field);
  fieldRef.current = field;

  useEffect(() => {
    return subscribe((raw) => {
      if (!isBringupEvent(raw)) return;
      const evt = raw as unknown as BringupEvent;
      if (evt.evt === 'bu_field') setField(evt);
    });
  }, [subscribe]);

  // Keepalive: the firmware's watchdog drops driver/auton to disabled after
  // 2.5 s without a ping. Ping at 1 Hz whenever engaged so an enabled state
  // survives, and stopping (tab close, disconnect) acts as an e-stop.
  useEffect(() => {
    if (!state.connected) return;
    const id = setInterval(() => {
      if (fieldRef.current?.engaged) void send(bringupCmd.ping());
    }, 1000);
    return () => clearInterval(id);
  }, [state.connected, send]);

  const disabled = !state.connected;
  const engaged = field?.engaged ?? false;

  const setState = (s: FieldState) => void send(bringupCmd.fieldState(s));

  return (
    <section className="rounded-xl border-2 border-blue-800 bg-gray-900/50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Field control (ports A + B)</h2>
          <p className="mt-1 max-w-2xl text-sm text-gray-400">
            The ported OpenFC-Smart session engine. Engage, wait for
            link/session on each port (power-cycle a stubborn controller
            while engaged), then command states. Driver/auton queue per port
            until its robot radio reaches field mode.
          </p>
        </div>
        <button
          disabled={disabled}
          onClick={() => void send(bringupCmd.fieldEngage(!engaged))}
          className={`rounded-md px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-50 ${
            engaged ? 'bg-red-700 hover:bg-red-600' : 'bg-green-700 hover:bg-green-600'
          }`}
        >
          {engaged ? 'Disengage' : 'Engage'}
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <StateButton
          label="Disabled"
          active={field?.state === 'disabled'}
          disabled={disabled || !engaged}
          onClick={() => setState('disabled')}
        />
        <StateButton
          label="Driver"
          active={field?.state === 'driver'}
          disabled={disabled || !engaged}
          onClick={() => setState('driver')}
        />
        <StateButton
          label="Auton"
          active={field?.state === 'auton'}
          disabled={disabled || !engaged}
          onClick={() => setState('auton')}
        />
        {field && (
          <span className="self-center text-xs text-gray-500">
            periods: driver {Math.round(field.driver_ms / 1000)}s · auton{' '}
            {Math.round(field.auton_ms / 1000)}s
          </span>
        )}
      </div>

      {engaged && field && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {field.ports.map((p) => {
            const fm = FM_LABEL[p.fm] ?? FM_LABEL[0];
            const queued = field.state !== 'disabled' && p.fm !== 2;
            return (
              <div key={p.port} className="rounded-md border border-gray-700 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">Port {p.port}</span>
                  <span className={p.link ? 'text-green-300' : 'text-gray-500'}>
                    {p.link ? 'LINKED' : p.ctrl ? 'controller seen' : 'no controller'}
                  </span>
                </div>
                <p className={`mt-1 text-sm ${fm.tone}`}>
                  {fm.text}
                  {p.robot ? ` · robot ${p.robot}` : ''}
                  {queued && p.link ? ' · state QUEUED until field mode' : ''}
                </p>
                <p className="mt-1 font-mono text-xs text-gray-500">
                  lack {p.lack} · sack {p.sack} · pack {p.pack} · enumreq {p.enumreq}
                  {p.swreplug > 0 ? ` · replugs ${p.swreplug}` : ''}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function StateButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md px-4 py-1.5 text-sm font-semibold transition disabled:opacity-50 ${
        active
          ? 'bg-blue-600 text-white'
          : 'border border-gray-600 text-gray-200 hover:bg-gray-800'
      }`}
    >
      {label}
    </button>
  );
}
