'use client';

// Raw wire log for the bring-up page. A copy of components/console/EventLog,
// not a reuse of it — two things needed to differ:
//   1. The production log's "hide noise" filter matches the certified
//      protocol's `heartbeat` event; the bring-up firmware's equivalent is
//      `bu_state`, which that filter doesn't know about, so every 1Hz tick
//      was landing in the log unfiltered.
//   2. Its autoscroll used `scrollIntoView`, which walks up through every
//      scrollable ancestor including the page itself — combined with #1's
//      1Hz ticks, that yanked the whole page to the bottom every second.
//      Fixed here by scrolling only the log's own container, and only when
//      the user was already at the bottom (so reading history isn't fought).

import { useEffect, useRef, useState } from 'react';
import { useSerial } from '@/components/SerialProvider';

interface RawEvent {
  evt: string;
  [key: string]: unknown;
}

interface Entry {
  id: number;
  at: number;
  evt: RawEvent;
}

// bu_cap is hidden with the heartbeats: a dump is thousands of lines, and
// the Bus capture panel collects them itself.
const NOISE_EVENTS = new Set(['bu_state', 'heartbeat', 'bu_cap']);

const TONE: Record<string, string> = {
  bu_error: 'text-red-300',
  error: 'text-red-300',
  ack: 'text-gray-500',
  bu_cap: 'text-cyan-300',
  bu_state: 'text-gray-700',
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
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribe((evt) => {
      if (pausedRef.current) return;
      setEntries((prev) => {
        const next = [...prev, { id: nextId.current++, at: Date.now(), evt: evt as RawEvent }];
        return next.length > 400 ? next.slice(-400) : next;
      });
    });
  }, [subscribe]);

  const shown = hideNoise ? entries.filter((e) => !NOISE_EVENTS.has(e.evt.evt)) : entries;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || paused) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (atBottom) el.scrollTop = el.scrollHeight;
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
                shown.map((e) => `${stamp(e.at)} ${JSON.stringify(e.evt)}`).join('\n'),
              )
            }
            className="rounded-md border border-gray-600 px-3 py-1 text-gray-200 hover:bg-gray-800"
          >
            Copy
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="mt-3 h-72 overflow-y-auto rounded-lg border border-gray-800 bg-gray-950 p-2 font-mono text-xs leading-relaxed"
      >
        {shown.length === 0 ? (
          <p className="p-2 text-gray-600">Nothing yet. Events appear here as the board sends them.</p>
        ) : (
          shown.map((e) => (
            <div key={e.id} className={TONE[e.evt.evt] ?? 'text-gray-300'}>
              <span className="text-gray-600">{stamp(e.at)}</span> {JSON.stringify(e.evt)}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function stamp(at: number): string {
  const d = new Date(at);
  return d.toTimeString().slice(0, 8) + '.' + d.getMilliseconds().toString().padStart(3, '0');
}
