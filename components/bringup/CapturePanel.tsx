'use client';

// Smart-port bus capture: records every byte both ways on the chosen ports
// (bringupCmd.capture), collects the bu_cap records a dump sends back, and
// saves them as JSON lines for offline analysis.

import { useEffect, useRef, useState } from 'react';
import { useSerial } from '@/components/SerialProvider';
import {
  BringupCap,
  BringupCapRing,
  BringupCapStatus,
  BringupEvent,
  SmartPort,
  bringupCmd,
  isBringupEvent,
} from '@/lib/openfc-bringup-protocol';

const ALL_PORTS: SmartPort[] = ['A', 'B', 'C', 'D'];

export default function CapturePanel() {
  const { state, subscribe, send } = useSerial();
  const [ports, setPorts] = useState<SmartPort[]>(ALL_PORTS);
  const [stream, setStream] = useState(false);
  const [status, setStatus] = useState<BringupCapStatus | null>(null);
  const [count, setCount] = useState(0);
  const records = useRef<BringupCap[]>([]);

  useEffect(() => {
    return subscribe((raw) => {
      if (!isBringupEvent(raw)) return;
      const evt = raw as unknown as BringupEvent;
      if (evt.evt === 'bu_cap') {
        records.current.push(evt);
        setCount(records.current.length);
      } else if (evt.evt === 'bu_cap_status') {
        setStatus(evt);
      }
    });
  }, [subscribe]);

  const disabled = !state.connected;
  const recording = status?.recording ?? false;

  const start = () => {
    records.current = [];
    setCount(0);
    void send(bringupCmd.capture(ports, true, stream));
  };
  const stop = () => void send(bringupCmd.capture(ports, false));
  const dump = () => void send(bringupCmd.captureDump());
  const download = () => {
    const body = records.current.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([body], { type: 'application/x-ndjson' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `openfc-capture-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const togglePort = (p: SmartPort) =>
    setPorts((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900/50 p-5">
      <div>
        <h2 className="text-lg font-semibold">Bus capture</h2>
        <p className="mt-1 max-w-2xl text-sm text-gray-400">
          Records every byte in both directions on the chosen Smart ports
          while the field is engaged. Dump sends the recording here; ports C
          and D only come out after Disengage. Download saves it as JSON
          lines, one record per line.
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div className="flex gap-3 text-sm">
          {ALL_PORTS.map((p) => (
            <label key={p} className="flex items-center gap-1 text-gray-300">
              <input
                type="checkbox"
                checked={ports.includes(p)}
                disabled={recording}
                onChange={() => togglePort(p)}
              />
              {p}
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input
            type="checkbox"
            checked={stream}
            disabled={recording}
            onChange={(e) => setStream(e.target.checked)}
          />
          Stream A/B live
        </label>
        <div className="flex flex-wrap gap-2">
          {recording ? (
            <button
              disabled={disabled}
              onClick={stop}
              className="rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50"
            >
              Stop
            </button>
          ) : (
            <button
              disabled={disabled || ports.length === 0}
              onClick={start}
              className="rounded-md bg-green-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-green-600 disabled:opacity-50"
            >
              Start
            </button>
          )}
          <button
            disabled={disabled}
            onClick={dump}
            className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
          >
            Dump
          </button>
          <button
            disabled={count === 0}
            onClick={download}
            className="rounded-md border border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-800 disabled:opacity-50"
          >
            Download{count > 0 ? ` (${count})` : ''}
          </button>
        </div>
      </div>

      {status && (
        <p className="mt-3 font-mono text-xs text-gray-400">
          {ringLine('A/B', status.ab)}
          {status.cd ? ` · ${ringLine('C/D', status.cd)}` : ' · C/D: RP2350 not answering'}
          {status.done ? ' · dump complete' : ''}
        </p>
      )}
    </section>
  );
}

function ringLine(label: string, r: BringupCapRing): string {
  const kb = (n: number) => (n / 1024).toFixed(1);
  return `${label}: ${r.records} records, ${kb(r.used)}/${kb(r.size)} KB held${
    r.dropped ? `, ${r.dropped} dropped` : ''
  }`;
}
