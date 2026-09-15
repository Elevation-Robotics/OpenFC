'use client';

// One RS-485 Smart port (A/B direct on the ESP32, C/D reached through the
// RP2350 over SPI). Same command shapes and event shapes either way — see
// lib/openfc-bringup-protocol.ts — so this component doesn't need to know
// which MCU actually owns the port.

import { useEffect, useState } from 'react';
import { useSerial } from '@/components/SerialProvider';
import {
  BringupEvent,
  BringupLinktestResult,
  BringupSelftestResult,
  SmartPort,
  bringupCmd,
  bytesToHex,
  hexToBytes,
  isBringupEvent,
} from '@/lib/openfc-bringup-protocol';

const RS485_ONLY: Record<SmartPort, boolean> = { A: true, B: true, C: false, D: false };

export default function SmartPortPanel({ port }: { port: SmartPort }) {
  const { state, subscribe, send } = useSerial();
  const [hex, setHex] = useState('0A 4B');
  const [rxLog, setRxLog] = useState<string[]>([]);
  const [linktest, setLinktest] = useState<BringupLinktestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [listening, setListening] = useState(false);
  const [selftest, setSelftest] = useState<BringupSelftestResult | null>(null);
  const [selftesting, setSelftesting] = useState(false);

  const direct = RS485_ONLY[port];

  useEffect(() => {
    return subscribe((raw) => {
      if (!isBringupEvent(raw)) return;
      const evt = raw as unknown as BringupEvent;
      if (evt.evt === 'bu_rs485_rx' && evt.port === port) {
        setRxLog((prev) => [...prev.slice(-19), bytesToHex(evt.bytes) || '(no bytes)']);
        setListening(false);
      } else if (evt.evt === 'bu_linktest_result' && evt.port === port) {
        setLinktest(evt);
        setTesting(false);
      } else if (evt.evt === 'bu_selftest_result' && evt.port === port) {
        setSelftest(evt);
        setSelftesting(false);
      }
    });
  }, [subscribe, port]);

  const disabled = !state.connected;

  const sendRaw = () => {
    const bytes = hexToBytes(hex);
    void send(
      direct
        ? bringupCmd.rs485Raw(port as 'A' | 'B', true, bytes)
        : bringupCmd.rp2350SpiRs485Raw(port as 'C' | 'D', true, bytes),
    );
  };

  const runListen = () => {
    setListening(true);
    void send(bringupCmd.rs485Listen(port as 'A' | 'B', 2000));
  };

  const runSelftest = () => {
    setSelftesting(true);
    setSelftest(null);
    void send(bringupCmd.rs485SelfTest(port as 'A' | 'B'));
  };

  const runLinktest = () => {
    setTesting(true);
    setLinktest(null);
    void send(
      direct
        ? bringupCmd.rs485LinkTest(port as 'A' | 'B')
        : bringupCmd.rp2350SpiLinkTest(port as 'C' | 'D'),
    );
  };

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900/50 p-5">
      <h2 className="text-lg font-semibold">
        Smart port {port} {direct ? '' : <span className="text-xs text-gray-500">(via RP2350)</span>}
      </h2>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          placeholder="hex bytes, e.g. 0A 4B 00 ..."
          className="w-64 rounded-md border border-gray-600 bg-gray-950 px-2 py-1 font-mono text-sm text-gray-200"
        />
        <button
          disabled={disabled}
          onClick={sendRaw}
          className="rounded-md border border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-800 disabled:opacity-50"
        >
          Send + capture
        </button>
        {direct && (
          <button
            disabled={disabled || listening}
            onClick={runListen}
            className="rounded-md border border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-800 disabled:opacity-50"
          >
            {listening ? 'Listening (2s)…' : 'Listen 2s (no send)'}
          </button>
        )}
        {direct && (
          <button
            disabled={disabled || selftesting}
            onClick={runSelftest}
            className="rounded-md border border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-800 disabled:opacity-50"
          >
            {selftesting ? 'Self-testing…' : 'Self-test (no peer needed)'}
          </button>
        )}
        <button
          disabled={disabled || testing}
          onClick={runLinktest}
          className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-blue-600 disabled:opacity-50"
        >
          {testing ? 'Running link test…' : 'Run link test'}
        </button>
      </div>

      {selftest && (
        <div className={`mt-3 text-sm ${selftest.ok ? 'text-green-300' : 'text-red-300'}`}>
          {selftest.ok ? (
            <p>Self-echo OK — sent {bytesToHex(selftest.sent)}, found it in at least one phase below. UART/transceiver/wiring on this port work.</p>
          ) : (
            <p>No echo at all in any phase (sent {bytesToHex(selftest.sent)}). Points at wiring, pin mapping, or assembly on this port — not a protocol or timing issue.</p>
          )}
          <ul className="mt-1 space-y-0.5 font-mono text-xs text-gray-400">
            <li>Internal UART loopback (bypasses GPIO/transceiver): {bytesToHex(selftest.echo_internal_loopback) || '(none)'}</li>
            <li>DE high (writing): {bytesToHex(selftest.echo_while_de_high) || '(none)'}</li>
            <li>DE low, right after: {bytesToHex(selftest.echo_after_de_low) || '(none)'}</li>
            <li>DE low (writing): {bytesToHex(selftest.echo_while_de_low) || '(none)'}</li>
            <li>DE high, right after: {bytesToHex(selftest.echo_after_de_high) || '(none)'}</li>
          </ul>
        </div>
      )}

      {linktest && (
        <div
          className={`mt-3 text-sm ${linktest.ok ? 'text-green-300' : 'text-yellow-300'}`}
        >
          <p>
            {linktest.ok
              ? `Handshake OK${linktest.session ? ' — SESSION granted (F3 78)' : ' — link ack (86 B9)'}`
              : linktest.stage === 'no_poll'
                ? 'No announces seen in the whole window — controller off or not on this port.'
                : linktest.stage === 'no_eligible'
                  ? 'Announces seen but all skipped by the flood/refractory gates — run a longer test.'
                  : 'Replied to announces but the controller never acked. Its warm state may be soured — rerun the test and power-cycle the controller WHILE it runs to catch the cold window.'}
          </p>
          <p className="mt-1 font-mono text-xs text-gray-400">
            {linktest.announces ?? 0} announces ({linktest.cold_announces ?? 0} cold /{' '}
            {linktest.warm_announces ?? 0} warm) · {linktest.replies_sent ?? 0} replies ·{' '}
            {linktest.skipped_flood ?? 0} flood-skipped · acks: {linktest.acks_link ?? 0} link,{' '}
            {linktest.acks_session ?? 0} session
          </p>
        </div>
      )}

      <div className="mt-3 max-h-40 overflow-y-auto rounded-md bg-gray-950 p-2 font-mono text-xs text-gray-400">
        {rxLog.length === 0 ? (
          <p className="text-gray-600">No captures yet.</p>
        ) : (
          rxLog.map((line, i) => <div key={i}>{line}</div>)
        )}
      </div>
    </section>
  );
}
