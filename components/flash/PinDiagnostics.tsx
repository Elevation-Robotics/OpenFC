'use client';

// Hardware diagnostics panel (/flash). Lets you drive each opto GPIO directly
// (set_pin / get_pins) and exercise the high-level enable/disable + driver/auto
// path (set), to isolate the PSRAM-pin conflict on ports 1/2 (IO35-37).
//
// Raw toggle ON = GPIO driven HIGH = opto ON = that V5 pin grounded (asserted).

import { useCallback, useEffect } from 'react';
import { useSerial, useSerialCommands } from '../SerialProvider';
import type { BoardMode, PinState } from '@/lib/openfc-protocol';

// IO numbers per the schematic, used only for display.
const PORT_OF = (label: string) => label.replace(/[^0-9]/g, '');
const KIND_OF = (label: string) => (label.startsWith('AD') ? 'Driver/Auto' : 'Enable/Disable');

export default function PinDiagnostics() {
  const { state } = useSerial();
  const c = useSerialCommands();

  // Pull current pin levels whenever a board connects.
  useEffect(() => {
    if (state.connected) void c.getPins();
  }, [state.connected, c]);

  // Manual enables and raw set_pin diagnostics are both subject to the firmware
  // comms watchdog (600 ms): without a periodic command the board auto-trips to
  // Disabled. Timed periods suspend the watchdog, so only feed it while no
  // period is active. Any command refreshes the watchdog; ping is the cheapest.
  const needsKeepalive =
    !state.timedPeriod.active &&
    (state.diag ||
      state.boardState === 'ENABLED_DRIVER' ||
      state.boardState === 'ENABLED_AUTO');
  useEffect(() => {
    if (!needsKeepalive) return;
    const id = setInterval(() => void c.ping(), 250);
    return () => clearInterval(id);
  }, [needsKeepalive, c]);

  const sendSet = useCallback(
    (enable: boolean, mode: BoardMode) => {
      void c.set(enable, mode);
      // set does not emit a pins event; refresh shadow shortly after.
      setTimeout(() => void c.getPins(), 150);
    },
    [c],
  );

  if (!state.connected) {
    return (
      <p className="text-sm text-gray-500">
        Connect a board to run hardware diagnostics.
      </p>
    );
  }

  const pins: PinState[] = state.pinStates ?? [];

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900/50 p-4">
      <h3 className="text-sm font-semibold text-gray-300">Hardware diagnostics</h3>

      {/* High-level controls (set command) */}
      <div className="mt-3">
        <p className="mb-1 text-xs uppercase tracking-wide text-gray-500">
          Manual control
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => sendSet(false, 'driver')}
            className="rounded bg-red-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-600"
          >
            Disable
          </button>
          <button
            onClick={() => sendSet(true, 'driver')}
            className="rounded bg-green-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-600"
          >
            Enable · Driver
          </button>
          <button
            onClick={() => sendSet(true, 'auto')}
            className="rounded bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-600"
          >
            Enable · Auto
          </button>
        </div>
      </div>

      {/* Raw per-pin toggles (set_pin command) */}
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-gray-500">
            Raw pin toggles
          </p>
          <button
            onClick={() => void c.getPins()}
            className="text-xs text-gray-400 hover:text-gray-200"
          >
            Refresh
          </button>
        </div>
        {pins.length === 0 ? (
          <p className="text-xs text-gray-500">
            No pin data yet — older firmware may not support get_pins.
          </p>
        ) : (
          <ul className="divide-y divide-gray-800">
            {pins.map((p) => (
              <li key={p.pin} className="flex items-center justify-between py-1.5">
                <span className="text-sm text-gray-300">
                  <span className="font-mono">{p.label}</span>{' '}
                  <span className="text-gray-500">
                    Port {PORT_OF(p.label)} · {KIND_OF(p.label)} · IO{p.pin}
                  </span>
                </span>
                <button
                  onClick={() => void c.setPin(p.pin, !p.value)}
                  className={`w-20 rounded px-2 py-1 text-xs font-semibold ${
                    p.value
                      ? 'bg-green-700 text-white hover:bg-green-600'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  {p.value ? 'HIGH' : 'LOW'}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-gray-600">
          HIGH = opto ON = that V5 pin grounded (asserted). ED HIGH = Disabled;
          AD HIGH = Autonomous.
        </p>
      </div>
    </div>
  );
}
