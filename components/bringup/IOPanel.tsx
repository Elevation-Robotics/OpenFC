'use client';

// NeoPixel identify/color test. Buttons are already shown live in
// BoardBanner's heartbeat, so this panel is just the LEDs.

import { useState } from 'react';
import { useSerial } from '@/components/SerialProvider';
import { bringupCmd } from '@/lib/openfc-bringup-protocol';

const SWATCHES: { name: string; r: number; g: number; b: number }[] = [
  { name: 'red', r: 255, g: 0, b: 0 },
  { name: 'green', r: 0, g: 255, b: 0 },
  { name: 'blue', r: 0, g: 0, b: 255 },
  { name: 'white', r: 255, g: 255, b: 255 },
  { name: 'off', r: 0, g: 0, b: 0 },
];

export default function IOPanel() {
  const { state, send } = useSerial();
  const [index, setIndex] = useState(0);
  const disabled = !state.connected;

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900/50 p-5">
      <h2 className="text-lg font-semibold">Status LEDs</h2>
      <p className="mt-1 max-w-2xl text-sm text-gray-400">
        3x SK6812RGBW, level-shifted from GPIO8. Identify cycles all three
        through red/green/blue for 3s.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-sm text-gray-300">
          LED{' '}
          <select
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
            className="rounded-md border border-gray-600 bg-gray-950 px-2 py-1 text-sm"
          >
            <option value={0}>0</option>
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </label>
        {SWATCHES.map((sw) => (
          <button
            key={sw.name}
            disabled={disabled}
            onClick={() => void send(bringupCmd.ledSet(index, sw.r, sw.g, sw.b))}
            className="rounded-md border border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-800 disabled:opacity-50"
          >
            {sw.name}
          </button>
        ))}
        <button
          disabled={disabled}
          onClick={() => void send(bringupCmd.identify())}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
        >
          Identify
        </button>
      </div>
    </section>
  );
}
