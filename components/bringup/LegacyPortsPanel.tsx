'use client';

// Legacy V5 Competition-Switch ports (4, driven in unison). Polarity carried
// over from the certified v1.1 board was CONFIRMED against a live V5 on the
// bench (2026-09-01) — see firmware-bringup-v1_3/esp32/include/
// openfc_pins_v13.h. The raw ED/AD toggles below remain useful for
// per-port fault isolation, but legacy_set's enable/mode framing is now
// trustworthy on this hardware.

import { useEffect, useState } from 'react';
import { useSerial } from '@/components/SerialProvider';
import {
  BringupEvent,
  BringupLegacyState,
  bringupCmd,
  isBringupEvent,
} from '@/lib/openfc-bringup-protocol';

export default function LegacyPortsPanel() {
  const { state, subscribe, send } = useSerial();
  const [legacy, setLegacy] = useState<BringupLegacyState | null>(null);

  useEffect(() => {
    return subscribe((raw) => {
      if (!isBringupEvent(raw)) return;
      const evt = raw as unknown as BringupEvent;
      if (evt.evt === 'bu_legacy_state') setLegacy(evt);
    });
  }, [subscribe]);

  const disabled = !state.connected;

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900/50 p-5">
      <h2 className="text-lg font-semibold">Legacy ports (RJ1-RJ4, unison)</h2>
      <p className="mt-1 max-w-2xl text-sm text-gray-400">
        One ENABLE/DISABLE + one DRIVER/AUT net drives all 4 legacy ports.
        Use the raw toggles first, with the board disconnected from anything
        that can move, to confirm which pin level means what on this
        hardware.
      </p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          disabled={disabled}
          onClick={() => void send(bringupCmd.legacySet(true, 'driver'))}
          className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-green-600 disabled:opacity-50"
        >
          Enable · Driver
        </button>
        <button
          disabled={disabled}
          onClick={() => void send(bringupCmd.legacySet(true, 'auto'))}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-blue-600 disabled:opacity-50"
        >
          Enable · Auto
        </button>
        <button
          disabled={disabled}
          onClick={() => void send(bringupCmd.legacySet(false, 'driver'))}
          className="rounded-md bg-gray-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-gray-600 disabled:opacity-50"
        >
          Disable
        </button>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <RawToggle
          label="ED pin (ENABLE/DISABLE)"
          disabled={disabled}
          level={legacy?.ed_pin_level ?? null}
          onSet={(v) => void send(bringupCmd.legacyRaw(v, legacy?.ad_pin_level ?? false))}
        />
        <RawToggle
          label="AD pin (DRIVER/AUT)"
          disabled={disabled}
          level={legacy?.ad_pin_level ?? null}
          onSet={(v) => void send(bringupCmd.legacyRaw(legacy?.ed_pin_level ?? false, v))}
        />
      </div>

      {legacy && (
        <p className="mt-3 text-xs text-gray-500">
          Board reports: enable={String(legacy.enable)} mode={legacy.mode}{' '}
          {legacy.diag && <span className="text-yellow-300">(raw diagnostic active)</span>}
        </p>
      )}
    </section>
  );
}

function RawToggle({
  label,
  level,
  disabled,
  onSet,
}: {
  label: string;
  level: boolean | null;
  disabled: boolean;
  onSet: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-gray-700 px-3 py-2">
      <span className="text-sm text-gray-300">{label}</span>
      <div className="flex items-center gap-2">
        <span className={`font-mono text-xs ${level ? 'text-green-300' : 'text-gray-500'}`}>
          {level === null ? '—' : level ? 'HIGH' : 'LOW'}
        </span>
        <button
          disabled={disabled}
          onClick={() => onSet(false)}
          className="rounded border border-gray-600 px-2 py-1 text-xs hover:bg-gray-800 disabled:opacity-50"
        >
          LOW
        </button>
        <button
          disabled={disabled}
          onClick={() => onSet(true)}
          className="rounded border border-gray-600 px-2 py-1 text-xs hover:bg-gray-800 disabled:opacity-50"
        >
          HIGH
        </button>
      </div>
    </div>
  );
}
