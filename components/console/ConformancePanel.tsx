'use client';

// Runs the proto-3 conformance suite against the attached board and shows what
// it found. This is the only way to observe the guarantees proto 3 adds: they
// are all things the board must refuse to do, and a board missing every check
// behaves identically to a correct one until a host reloads mid-match.

import { useCallback, useRef, useState } from 'react';
import { useSerial } from '../SerialProvider';
import { OpenFCEvent } from '@/lib/openfc-protocol';
import {
  CHECKS,
  CheckResult,
  ConformanceIO,
  runConformance,
  summarise,
} from '@/lib/period-conformance';

const DOT: Record<CheckResult['outcome'], string> = {
  pass: 'bg-green-400',
  fail: 'bg-red-400',
  skip: 'bg-gray-600',
};

export default function ConformancePanel() {
  const { state, send, subscribe } = useSerial();
  const [results, setResults] = useState<CheckResult[]>([]);
  const [running, setRunning] = useState(false);
  const [dryRun, setDryRun] = useState(false);
  const runningRef = useRef(false);

  const run = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setResults([]);

    const io: ConformanceIO = {
      deviceId: state.deviceId,
      send: (line) => void send(line),
      delay: (ms) => new Promise((r) => setTimeout(r, ms)),
      watch: (fn) => subscribe(fn),
      // Subscribes before the caller sends, so a board that replies in under a
      // millisecond cannot beat the listener into place.
      waitFor: (match, timeoutMs) =>
        new Promise<OpenFCEvent | null>((resolve) => {
          let done = false;
          const finish = (evt: OpenFCEvent | null) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            unsub();
            resolve(evt);
          };
          const timer = setTimeout(() => finish(null), timeoutMs);
          const unsub = subscribe((evt) => {
            if (match(evt)) finish(evt);
          });
        }),
    };

    try {
      await runConformance(io, {
        dryRun,
        onProgress: (r) => setResults((prev) => [...prev, r]),
      });
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [state.deviceId, send, subscribe, dryRun]);

  const totals = summarise(results);
  const pending = CHECKS.length - results.length;

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Protocol conformance</h2>
          <p className="mt-1 max-w-xl text-sm text-gray-400">
            Drives the board into each failure case proto 3 is meant to catch and
            reports what it actually did. Robots will be enabled briefly during
            most checks — clear the field first.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
              disabled={running}
            />
            Dry run
          </label>
          <button
            onClick={() => void run()}
            disabled={!state.connected || running}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? 'Running…' : 'Run suite'}
          </button>
        </div>
      </div>

      {dryRun && (
        <p className="mt-2 text-xs text-yellow-300">
          Dry run skips every check that enables the outputs — which is most of
          them. Use it to confirm the board answers, not to certify it.
        </p>
      )}

      {results.length > 0 && (
        <p className="mt-4 text-sm">
          <span className="text-green-300">{totals.pass} passed</span>
          {totals.fail > 0 && (
            <span className="text-red-300"> · {totals.fail} failed</span>
          )}
          {totals.skip > 0 && (
            <span className="text-gray-500"> · {totals.skip} skipped</span>
          )}
          {pending > 0 && <span className="text-gray-500"> · {pending} to go</span>}
        </p>
      )}

      <ul className="mt-4 space-y-2">
        {results.map((r) => (
          <li
            key={r.id}
            className="rounded-lg border border-gray-800 bg-gray-950/60 p-3"
          >
            <div className="flex items-start gap-3">
              <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[r.outcome]}`} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-100">
                  {r.title}
                  {r.durationMs > 0 && (
                    <span className="ml-2 font-mono text-xs text-gray-600">
                      {(r.durationMs / 1000).toFixed(1)}s
                    </span>
                  )}
                </p>
                <p
                  className={`mt-0.5 text-sm ${
                    r.outcome === 'fail' ? 'text-red-300' : 'text-gray-400'
                  }`}
                >
                  {r.detail}
                </p>
                {r.outcome === 'fail' && (
                  <p className="mt-1 text-xs text-gray-500">{r.rationale}</p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {!state.connected && (
        <p className="mt-4 text-sm text-gray-500">Connect a board to run the suite.</p>
      )}
    </section>
  );
}
