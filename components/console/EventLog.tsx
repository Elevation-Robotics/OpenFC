'use client';

// Raw wire log. The panels above interpret what the board says; this shows it
// verbatim, because when a check fails the interpretation is the thing in doubt.

import { useEffect, useRef, useState } from 'react';
import { useSerial } from '../SerialProvider';
import { OpenFCEvent } from '@/lib/openfc-protocol';

const MAX_LINES = 400;

interface Entry {
  id: number;
  at: number;
  evt: OpenFCEvent;
}

const TONE: Record<string, string> = {
  error: 'text-red-300',
  estop: 'text-yellow-300',
  timer_expired: 'text-yellow-200',
  ack: 'text-gray-500',
  heartbeat: 'text-gray-700',
};

export default function EventLog() {
  const { subscribe } = useSerial();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [paused, setPaused] = useState(false);
  const [hideNoise, setHideNoise] = useState(true);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const nextId = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribe((evt) => {
      if (pausedRef.current) return;
      setEntries((prev) => {
        const next = [...prev, { id: nextId.current++, at: Date.now(), evt }];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    });
  }, [subscribe]);

  const shown = hideNoise
    ? entries.filter((e) => e.evt.evt !== 'heartbeat')
    : entries;

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [shown.length, paused]);

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900/50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Wire log</h2>
        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-gray-300">
            <input
              type="checkbox"
              checked={hideNoise}
              onChange={(e) => setHideNoise(e.target.checked)}
            />
            Hide heartbeats
          </label>
          <button
            onClick={() => setPaused((p) => !p)}
            className="rounded-md border border-gray-600 px-3 py-1 text-gray-200 hover:bg-gray-800"
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button
            onClick={() => setEntries([])}
            className="rounded-md border border-gray-600 px-3 py-1 text-gray-200 hover:bg-gray-800"
          >
            Clear
          </button>
          <button
            onClick={() =>
              void navigator.clipboard?.writeText(
                shown
                  .map((e) => `${stamp(e.at)} ${JSON.stringify(e.evt)}`)
                  .join('\n'),
              )
            }
            className="rounded-md border border-gray-600 px-3 py-1 text-gray-200 hover:bg-gray-800"
          >
            Copy
          </button>
        </div>
      </div>

      <div className="mt-3 h-72 overflow-y-auto rounded-lg border border-gray-800 bg-gray-950 p-2 font-mono text-xs leading-relaxed">
        {shown.length === 0 ? (
          <p className="p-2 text-gray-600">
            Nothing yet. Events appear here as the board sends them.
          </p>
        ) : (
          shown.map((e) => (
            <div key={e.id} className={TONE[e.evt.evt] ?? 'text-gray-300'}>
              <span className="text-gray-600">{stamp(e.at)}</span>{' '}
              {JSON.stringify(e.evt)}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}

function stamp(at: number): string {
  const d = new Date(at);
  return (
    d.toTimeString().slice(0, 8) +
    '.' +
    d.getMilliseconds().toString().padStart(3, '0')
  );
}
