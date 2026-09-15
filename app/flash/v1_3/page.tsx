'use client';

// Firmware flasher for the V1.3 dual-MCU board. Two steps, two very
// different mechanisms behind one progress UI:
//
//   1. ESP32-S3 — esptool-js over Web Serial, exactly like /flash (the JSON
//      read loop is paused and the port handed to esptool).
//   2. RP2350   — the ESP32 does the writing over its on-board SWD pins; the
//      browser just streams base64 chunks as bring-up JSON commands over the
//      live link (lib/rp2350-flash.ts). Requires step 1's firmware running.
//
// See /docs/v1_3 for the procedure and the wire protocol behind step 2.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import BrowserGate from '@/components/BrowserGate';
import ConnectButton from '@/components/ConnectButton';
import SiteFooter from '@/components/SiteFooter';
import BoardBanner from '@/components/bringup/BoardBanner';
import FlashProgress from '@/components/flash/FlashProgress';
import V13StepCard from '@/components/flash/V13StepCard';
import { useSerial } from '@/components/SerialProvider';
import { flashFirmware } from '@/lib/esptool-flash';
import {
  V13Release,
  fetchManifest,
  fetchV13Image,
  latestV13Release,
} from '@/lib/firmware-hash';
import {
  BringupEvent,
  BringupSpiResult,
  bringupCmd,
  isBringupEvent,
} from '@/lib/openfc-bringup-protocol';
import { flashRp2350 } from '@/lib/rp2350-flash';

type Target = 'esp32' | 'rp2350';

export default function FlashV13Page() {
  const { state, getConnection, send, subscribe } = useSerial();
  const [release, setRelease] = useState<V13Release | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Target | null>(null);
  const [pct, setPct] = useState(0);
  const [message, setMessage] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [bringupSeen, setBringupSeen] = useState(false);
  const [ping, setPing] = useState<BringupSpiResult | 'pending' | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const latest = latestV13Release(await fetchManifest());
        if (cancelled) return;
        if (!latest) setManifestError('No V1.3 firmware is published.');
        else setRelease(latest);
      } catch (e) {
        if (!cancelled) {
          setManifestError(e instanceof Error ? e.message : 'Could not load manifest.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Step 2 only works against the bring-up firmware; track whether this
  // board has ever identified itself as such on this connection.
  useEffect(() => {
    return subscribe((raw) => {
      if (!isBringupEvent(raw)) return;
      const evt = raw as unknown as BringupEvent;
      if (evt.evt === 'bu_hello') setBringupSeen(true);
      else if (evt.evt === 'bu_spi_result') setPing(evt);
    });
  }, [subscribe]);
  useEffect(() => {
    if (!state.connected) {
      setBringupSeen(false);
      setPing(null);
    }
  }, [state.connected]);

  const begin = useCallback((target: Target, label: string) => {
    setError(null);
    setBusy(target);
    setPct(0);
    setMessage('Starting…');
    setLog([`${target === 'esp32' ? 'ESP32-S3' : 'RP2350'}: ${label}`]);
  }, []);

  const onProgress = useCallback((p: number, msg: string) => {
    if (p >= 0) setPct(p);
    if (msg) {
      setMessage(msg);
      setLog((prev) => [...prev, msg]);
    }
  }, []);

  const fail = useCallback(
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Flash failed.';
      onProgress(-1, `Error: ${msg}`);
      setError(msg);
    },
    [onProgress],
  );

  /** Step 1: same port hand-off as /flash, then ask the new firmware who it is. */
  const flashEsp32 = useCallback(
    async (fetchData: () => Promise<ArrayBuffer>, label: string) => {
      const conn = getConnection();
      if (!conn || !conn.port) {
        setError('Connect a board before flashing.');
        return;
      }
      begin('esp32', label);
      const port = conn.port;
      let paused = false;
      try {
        onProgress(0, 'Downloading and verifying image…');
        const data = await fetchData();
        await conn.pauseForFlash();
        paused = true;
        await flashFirmware(port, data, onProgress);
        await conn.resumeAfterFlash();
        paused = false;
        setTimeout(() => void send(bringupCmd.getInfo()), 800);
      } catch (e) {
        fail(e);
        if (paused) {
          try {
            await conn.resumeAfterFlash();
          } catch {
            // ignore
          }
        }
      } finally {
        setBusy(null);
      }
    },
    [begin, fail, getConnection, onProgress, send],
  );

  /** Step 2: never touches the port; the ESP32 writes the RP2350 for us. */
  const flashRp = useCallback(
    async (fetchData: () => Promise<ArrayBuffer>, label: string) => {
      begin('rp2350', label);
      setPing(null);
      try {
        onProgress(0, 'Downloading and verifying image…');
        const data = await fetchData();
        await flashRp2350({ send, subscribe }, data, onProgress);
      } catch (e) {
        fail(e);
      } finally {
        setBusy(null);
      }
    },
    [begin, fail, onProgress, send, subscribe],
  );

  const rpBlocked =
    state.connected && !bringupSeen
      ? 'This board has not identified itself as V1.3 bring-up firmware. Flash the ESP32 (step 1) first, or click Identify.'
      : null;

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <BrowserGate />
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/flash" className="text-sm text-gray-500 hover:text-gray-300">
            ← Flash Firmware
          </Link>
          <h1 className="text-2xl font-bold">Flash V1.3 Firmware</h1>
          <p className="mt-1 text-sm text-gray-400">
            Dual-MCU board: the ESP32-S3 is flashed over USB, then it flashes
            the RP2350 for you. Prototype firmware — not certified for
            competition.{' '}
            <Link href="/docs/v1_3" className="text-blue-400 hover:underline">
              Read the procedure
            </Link>
            .
          </p>
        </div>
        <ConnectButton />
      </div>

      <BoardBanner />

      {manifestError && (
        <div className="mb-6 rounded-xl border border-red-900/60 bg-red-950/20 p-5 text-sm text-red-300">
          {manifestError}
        </div>
      )}
      {release && (
        <div className="mb-6 rounded-lg border border-gray-800 bg-gray-900/30 px-4 py-3 text-sm">
          <p className="text-gray-200">
            <span className="font-semibold">v{release.version}</span>
            <span className="text-gray-500"> · released {release.released}</span>
          </p>
          <p className="mt-1 text-gray-400">{release.description}.</p>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300">
              What&apos;s in this release
            </summary>
            <p className="mt-2 text-xs leading-relaxed text-gray-400">{release.changelog}</p>
          </details>
        </div>
      )}

      <div className="space-y-6">
        <V13StepCard
          step={1}
          title="ESP32-S3"
          version={release?.version ?? null}
          image={release?.esp32 ?? null}
          fetchImage={fetchV13Image}
          onFlash={(f, label) => void flashEsp32(f, label)}
          connected={state.connected}
          busy={busy !== null}
        >
          <p>
            Merged bootloader + partition table + app written at 0x0 with
            esptool over the CH340. The board reboots into the new firmware and
            holds the RP2350 in reset until step 2 releases it. About 30 s.
          </p>
        </V13StepCard>

        <V13StepCard
          step={2}
          title="RP2350"
          version={release?.version ?? null}
          image={release?.rp2350 ?? null}
          fetchImage={fetchV13Image}
          onFlash={(f, label) => void flashRp(f, label)}
          connected={state.connected}
          busy={busy !== null}
          blockedReason={rpBlocked}
        >
          <p>
            The ESP32 releases the RP2350 from reset, reset-halts it over SWD,
            erases flash, writes the image in 384-byte chunks, then reboots it
            into the new image. About 10 s for the bring-up image.
          </p>
          {rpBlocked && (
            <button
              onClick={() => void send(bringupCmd.getInfo())}
              disabled={busy !== null}
              className="rounded-md border border-gray-600 px-3 py-1 text-xs hover:bg-gray-800 disabled:opacity-50"
            >
              Identify
            </button>
          )}
        </V13StepCard>
      </div>

      <FlashProgress active={busy !== null} pct={pct} message={message} log={log} />
      {error && <p className="mt-3 text-center text-sm text-red-400">{error}</p>}

      <section className="mt-6 rounded-xl border border-gray-800 bg-gray-900/30 p-5">
        <h2 className="text-sm font-semibold text-gray-300">Check the link</h2>
        <p className="mt-1 text-sm text-gray-500">
          After both steps, a SPI ping confirms the RP2350 is running and
          answering the ESP32. Ports C and D depend on this.
        </p>
        <div className="mt-3 flex items-center gap-4">
          <button
            onClick={() => {
              setPing('pending');
              void send(bringupCmd.rp2350SpiPing());
            }}
            disabled={!state.connected || !bringupSeen || busy !== null || ping === 'pending'}
            className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {ping === 'pending' ? 'Pinging…' : 'SPI ping'}
          </button>
          {ping && ping !== 'pending' && (
            <span className={ping.ok ? 'text-sm text-green-300' : 'text-sm text-yellow-300'}>
              {ping.ok ? 'RP2350 answered — link OK' : 'No response from RP2350'}
            </span>
          )}
        </div>
      </section>

      <p className="mt-6 text-xs text-gray-600">
        For deeper diagnostics (ports A–D, legacy ports, RUN/BOOT_CTRL) use the{' '}
        <Link href="/bringup-v1_3" className="text-blue-400 hover:underline">
          bring-up console
        </Link>
        . Command-line alternative: <code>firmware-bringup-v1_3/tools/bringup_cli.py</code>.
      </p>

      <SiteFooter />
    </main>
  );
}
