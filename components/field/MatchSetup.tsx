'use client';

// Practice match setup: a preset to start from, then every duration editable.
// On start, navigates to the match screen with config in the query string
// (bookmarkable, so a frequently-used setup can be saved). See spec §9.1.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  GAP_MAX_S,
  MATCH_PRESETS,
  MatchSequence,
  MatchTransitions,
  PERIOD_MAX_S,
  PERIOD_MIN_S,
} from '@/lib/match-engine';
import { useSerial } from '../SerialProvider';

function clampInt(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Seconds as m:ss, so long practice periods are readable at a glance. */
function fmt(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

export default function MatchSetup() {
  const router = useRouter();
  const { state } = useSerial();
  const [auto, setAuto] = useState(15);
  const [driver, setDriver] = useState(105);
  const [gap, setGap] = useState(5);
  const [sequence, setSequence] = useState<MatchSequence>('both');
  const [transitions, setTransitions] = useState<MatchTransitions>('manual');
  const [presetId, setPresetId] = useState('full');

  const applyPreset = (id: string) => {
    const preset = MATCH_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setPresetId(id);
    setAuto(preset.config.auto);
    setDriver(preset.config.driver);
    setGap(preset.config.gap);
    setSequence(preset.config.sequence);
  };

  // Any manual edit means the config no longer matches the preset it came from.
  const edit = <T,>(setter: (v: T) => void) => (value: T) => {
    setPresetId('');
    setter(value);
  };

  const timedGap = sequence === 'both' && transitions === 'timed';

  const total =
    (sequence !== 'driver' ? auto : 0) +
    (sequence !== 'auto' ? driver : 0) +
    (timedGap ? gap : 0);

  const start = () => {
    const a = clampInt(auto, PERIOD_MIN_S, PERIOD_MAX_S);
    const d = clampInt(driver, PERIOD_MIN_S, PERIOD_MAX_S);
    const g = clampInt(gap, 0, GAP_MAX_S);
    router.push(
      `/field/match?auto=${a}&driver=${d}&gap=${g}&seq=${sequence}&trans=${transitions}`,
    );
  };

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900/50 p-6">
      <h2 className="text-lg font-semibold">Practice Match</h2>
      <p className="mt-1 text-sm text-gray-400">
        Pick a starting point, then adjust anything.
      </p>

      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {MATCH_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => applyPreset(p.id)}
            className={`rounded-lg border px-3 py-2 text-left transition ${
              presetId === p.id
                ? 'border-green-500 bg-green-950/40'
                : 'border-gray-700 hover:border-gray-500 hover:bg-gray-800/50'
            }`}
          >
            <span className="block text-sm font-medium text-gray-100">
              {p.label}
            </span>
            <span className="block text-xs text-gray-500">{p.detail}</span>
          </button>
        ))}
      </div>

      <div className="mt-6 space-y-4 border-t border-gray-800 pt-5">
        <fieldset className="space-y-2">
          <legend className="text-sm text-gray-400">Periods to run</legend>
          <Radio
            name="seq"
            checked={sequence === 'both'}
            onChange={() => edit(setSequence)('both')}
            label="Autonomous → Driver"
          />
          <Radio
            name="seq"
            checked={sequence === 'auto'}
            onChange={() => edit(setSequence)('auto')}
            label="Autonomous only"
          />
          <Radio
            name="seq"
            checked={sequence === 'driver'}
            onChange={() => edit(setSequence)('driver')}
            label="Driver only"
          />
        </fieldset>

        {sequence !== 'driver' && (
          <NumberField
            label="Autonomous"
            value={auto}
            min={PERIOD_MIN_S}
            max={PERIOD_MAX_S}
            onChange={edit(setAuto)}
          />
        )}
        {sequence !== 'auto' && (
          <NumberField
            label="Driver"
            value={driver}
            min={PERIOD_MIN_S}
            max={PERIOD_MAX_S}
            onChange={edit(setDriver)}
          />
        )}
        {sequence === 'both' && (
          <fieldset className="space-y-2">
            <legend className="text-sm text-gray-400">Between periods</legend>
            <Radio
              name="trans"
              checked={transitions === 'manual'}
              onChange={() => edit(setTransitions)('manual')}
              label="Wait for me (manual)"
            />
            <Radio
              name="trans"
              checked={transitions === 'timed'}
              onChange={() => edit(setTransitions)('timed')}
              label="Timed gap"
            />
            <p className="text-xs text-gray-500">
              {transitions === 'manual'
                ? 'Robots stay disabled after autonomous until you start driver control.'
                : 'Driver control starts automatically after the gap.'}
            </p>
          </fieldset>
        )}

        {timedGap && (
          <div>
            <NumberField
              label="Transition gap"
              value={gap}
              min={0}
              max={GAP_MAX_S}
              onChange={edit(setGap)}
            />
            <p className="mt-1 text-xs text-gray-500">
              Robots are disabled between the two periods.
            </p>
          </div>
        )}
      </div>

      <p className="mt-5 text-sm text-gray-400">
        Total field time{' '}
        <span className="font-mono text-gray-200">{fmt(total)}</span>
        {sequence === 'both' && transitions === 'manual' && (
          <span className="text-gray-500"> plus the transition you control</span>
        )}
      </p>

      <button
        onClick={start}
        disabled={!state.connected}
        className="mt-3 w-full rounded-md bg-green-600 px-4 py-3 font-semibold text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Start Match ▶
      </button>
      {!state.connected && (
        <p className="mt-2 text-center text-sm text-gray-500">
          Requires a connected board.
        </p>
      )}
      {state.connected && state.boardKind === 'v13' && (
        <p className="mt-3 text-sm text-gray-400">
          V1.3 board: drives the Smart ports and the legacy ports together.
          Keep this page open for the whole match. This page ends each
          period, and if it goes away the Smart ports disable after 2.5 s but
          the legacy ports stay as they are.
        </p>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4">
      <span className="text-sm text-gray-300">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-20 rounded-md border border-gray-600 bg-gray-950 px-2 py-1 text-right font-mono text-gray-100"
        />
        <span className="text-sm text-gray-500">sec</span>
        <span className="w-14 text-right font-mono text-sm text-gray-500">
          {fmt(value)}
        </span>
      </span>
    </label>
  );
}

function Radio({
  name,
  checked,
  onChange,
  label,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-gray-200">
      <input type="radio" name={name} checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}
