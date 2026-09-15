'use client';

// RUN/BOOT_CTRL control for the companion RP2350 ("Serial Expander", drives
// Smart ports C/D) plus a SPI echo test — the first thing to try once both
// firmwares are flashed, before trusting any C/D port result.

import { useEffect, useState } from 'react';
import { useSerial } from '@/components/SerialProvider';
import {
  BringupEvent,
  BringupRp2350State,
  BringupSpiResult,
  bringupCmd,
  isBringupEvent,
} from '@/lib/openfc-bringup-protocol';

export default function RP2350LinkPanel() {
  const { state, subscribe, send } = useSerial();
  const [rp, setRp] = useState<BringupRp2350State | null>(null);
  const [pingResult, setPingResult] = useState<BringupSpiResult | null>(null);
  const [pinging, setPinging] = useState(false);

  useEffect(() => {
    return subscribe((raw) => {
      if (!isBringupEvent(raw)) return;
      const evt = raw as unknown as BringupEvent;
      if (evt.evt === 'bu_rp2350_state') setRp(evt);
      else if (evt.evt === 'bu_spi_result') {
        setPingResult(evt);
        setPinging(false);
      }
    });
  }, [subscribe]);

  const disabled = !state.connected;

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900/50 p-5">
      <h2 className="text-lg font-semibold">RP2350 link</h2>
      <p className="mt-1 max-w-2xl text-sm text-gray-400">
        RUN is held low (reset) at boot. Release it, give the RP2350 a
        moment to start its SPI-slave loop, then try the ping. To (re)flash
        the RP2350 use the V1.3 flasher at /flash/v1_3 — it releases RUN and
        programs the chip over the ESP32&apos;s SWD bridge.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={disabled}
          onClick={() => void send(bringupCmd.rp2350Ctrl({ run: true }))}
          className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-600 disabled:opacity-50"
        >
          Release RUN
        </button>
        <button
          disabled={disabled}
          onClick={() => void send(bringupCmd.rp2350Ctrl({ run: false }))}
          className="rounded-md bg-gray-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-gray-600 disabled:opacity-50"
        >
          Hold RUN low
        </button>
        <button
          disabled={disabled}
          onClick={() => void send(bringupCmd.rp2350Ctrl({ boot_ctrl: false }))}
          className="rounded-md border border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-800 disabled:opacity-50"
        >
          BOOT_CTRL low
        </button>
        <button
          disabled={disabled}
          onClick={() => void send(bringupCmd.rp2350Ctrl({ boot_ctrl: true }))}
          className="rounded-md border border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-800 disabled:opacity-50"
        >
          BOOT_CTRL high
        </button>
        <button
          disabled={disabled || pinging}
          onClick={() => {
            setPinging(true);
            setPingResult(null);
            void send(bringupCmd.rp2350SpiPing());
          }}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
        >
          {pinging ? 'Pinging…' : 'SPI ping'}
        </button>
      </div>

      <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <Field label="run" value={rp ? String(rp.run) : '—'} />
        <Field label="boot_ctrl" value={rp ? String(rp.boot_ctrl) : '—'} />
        <Field label="irq" value={rp ? (rp.irq ? 'high' : 'low') : '—'} />
        <Field
          label="spi ping"
          value={pingResult ? (pingResult.ok ? 'OK' : 'no response') : '—'}
          tone={pingResult ? (pingResult.ok ? 'ok' : 'warn') : undefined}
        />
      </dl>
    </section>
  );
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'ok' | 'warn';
}) {
  const color =
    tone === 'ok' ? 'text-green-300' : tone === 'warn' ? 'text-yellow-300' : 'text-gray-200';
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className={color}>{value}</dd>
    </div>
  );
}
