'use client';

// Firmware flasher page. See spec §7.
//
// Two paths share one flash routine: the official one-click install (the
// default, and the only one most users need) and a custom .bin for people
// developing firmware. Both go through runFlash so port ownership and recovery
// behave identically.

import { useCallback, useState } from 'react';
import Link from 'next/link';
import BrowserGate from '@/components/BrowserGate';
import ConnectButton from '@/components/ConnectButton';
import SiteFooter from '@/components/SiteFooter';
import FirmwareVerifier from '@/components/flash/FirmwareVerifier';
import FirmwareUploader, {
  SelectedFirmware,
} from '@/components/flash/FirmwareUploader';
import FlashProgress from '@/components/flash/FlashProgress';
import OfficialFirmwareCard from '@/components/flash/OfficialFirmwareCard';
import PinDiagnostics from '@/components/flash/PinDiagnostics';
import { useSerial } from '@/components/SerialProvider';
import { flashFirmware } from '@/lib/esptool-flash';
import { fetchOfficialFirmware } from '@/lib/firmware-hash';
import { cmd } from '@/lib/openfc-protocol';

export default function FlashPage() {
  const { state, getConnection, send } = useSerial();
  const [selected, setSelected] = useState<SelectedFirmware | null>(null);
  const [flashing, setFlashing] = useState(false);
  const [pct, setPct] = useState(0);
  const [message, setMessage] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** Flash an already-fetched image. `prepare` runs before the port is taken. */
  const runFlash = useCallback(
    async (prepare: () => Promise<ArrayBuffer>) => {
      const conn = getConnection();
      if (!conn || !conn.port) {
        setError('Connect a board before flashing.');
        return;
      }
      setError(null);
      setFlashing(true);
      setPct(0);
      setMessage('Starting…');
      setLog([]);

      const onProgress = (p: number, msg: string) => {
        if (p >= 0) setPct(p);
        if (msg) {
          setMessage(msg);
          setLog((prev) => [...prev, msg]);
        }
      };

      const port = conn.port;
      let paused = false;
      try {
        // Download and verify before touching the port, so a failed download
        // never leaves the board mid-flash.
        const data = await prepare();
        await conn.pauseForFlash();
        paused = true;
        await flashFirmware(port, data, onProgress);
        await conn.resumeAfterFlash();
        paused = false;
        // Refresh identity after reboot; the board re-emits hello on get_info.
        setTimeout(() => {
          void send(cmd.getInfo());
          void send(cmd.getState());
        }, 500);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Flash failed.';
        onProgress(-1, `Error: ${msg}`);
        setError(msg);
        // Restore the JSON read loop so the board stays usable.
        if (paused) {
          try {
            await conn.resumeAfterFlash();
          } catch {
            // ignore
          }
        }
      } finally {
        setFlashing(false);
      }
    },
    [getConnection, send],
  );

  const flashOfficial = useCallback(
    () =>
      runFlash(async () => {
        setMessage('Downloading official firmware…');
        const { data } = await fetchOfficialFirmware();
        return data;
      }),
    [runFlash],
  );

  const flashCustom = useCallback(() => {
    if (!selected) return;
    void runFlash(async () => selected.data);
  }, [runFlash, selected]);

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <BrowserGate />
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-300">
            ← OpenFC
          </Link>
          <h1 className="text-2xl font-bold">Flash Firmware — V1 Board</h1>
          <p className="mt-1 text-sm text-gray-400">
            For the original single-MCU V1 board (one ESP32, hardware rev 1.1).
            The firmware version number is unrelated to the board revision.
          </p>
        </div>
        <ConnectButton />
      </div>

      <section className="mb-6">
        <FirmwareVerifier />
      </section>

      <section className="mb-6">
        <OfficialFirmwareCard
          onFlash={() => void flashOfficial()}
          busy={flashing}
        />
      </section>

      <FlashProgress active={flashing} pct={pct} message={message} log={log} />
      {error && <p className="mt-3 text-center text-sm text-red-400">{error}</p>}

      <p className="mt-6 rounded-lg border border-yellow-900/60 bg-yellow-950/20 px-4 py-3 text-sm text-yellow-200">
        Have a V1.3 dual-MCU board (ESP32-S3 plus RP2350 Smart-port expander)?
        Do not flash it from this page. It takes two different images — use
        the{' '}
        <Link href="/flash/v1_3" className="text-blue-400 hover:underline">
          V1.3 flasher
        </Link>
        .
      </p>

      <details className="mt-8 rounded-lg border border-gray-800 bg-gray-900/30 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-gray-300">
          Flash a custom build
        </summary>
        <p className="mt-2 text-sm text-gray-500">
          For firmware development. A custom build is not certified, and the
          field controller will flag the board as unverified.
        </p>
        <div className="mt-4">
          <FirmwareUploader onSelect={setSelected} disabled={flashing} />
        </div>
        <button
          onClick={flashCustom}
          disabled={!state.connected || !selected || flashing}
          className="mt-4 w-full rounded-md border border-gray-600 px-4 py-2.5 text-sm font-semibold text-gray-100 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {flashing ? 'Flashing…' : 'Flash Custom Firmware'}
        </button>
      </details>

      <section className="mt-8">
        <PinDiagnostics />
      </section>

      <SiteFooter />
    </main>
  );
}
