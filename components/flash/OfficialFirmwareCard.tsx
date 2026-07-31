'use client';

// The one-click official firmware install. Reads the published manifest so the
// version and changelog shown here always match what will actually be written.
// See spec §7.1, §8.

import { useEffect, useState } from 'react';
import { useSerial } from '../SerialProvider';
import {
  OfficialRelease,
  fetchManifest,
  isRunningRelease,
  latestCertifiedRelease,
} from '@/lib/firmware-hash';

interface Props {
  onFlash: () => void;
  busy: boolean;
}

export default function OfficialFirmwareCard({ onFlash, busy }: Props) {
  const { state } = useSerial();
  const [release, setRelease] = useState<OfficialRelease | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const latest = latestCertifiedRelease(await fetchManifest());
        if (cancelled) return;
        if (!latest) setError('No certified firmware is published.');
        else setRelease(latest);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load manifest.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="rounded-xl border border-red-900/60 bg-red-950/20 p-5 text-sm text-red-300">
        {error}
      </div>
    );
  }

  if (!release) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-5 text-sm text-gray-500">
        Loading firmware…
      </div>
    );
  }

  const upToDate = isRunningRelease(state.fwHash, release);

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-900/50 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Official Firmware</h2>
          <p className="mt-0.5 text-sm text-gray-400">
            v{release.version} · released {release.released}
          </p>
        </div>
        {upToDate && (
          <span className="rounded bg-green-900/50 px-2.5 py-1 text-xs font-semibold text-green-300">
            ✓ Already installed
          </span>
        )}
      </div>

      <p className="mt-3 text-sm text-gray-300">{release.description}.</p>

      <button
        onClick={onFlash}
        disabled={!state.connected || busy}
        className="mt-5 w-full rounded-md bg-blue-600 px-4 py-3 font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy
          ? 'Flashing…'
          : upToDate
            ? `Reinstall v${release.version}`
            : `Install v${release.version}`}
      </button>

      {!state.connected && (
        <p className="mt-2 text-center text-sm text-gray-500">
          Connect a board to enable flashing.
        </p>
      )}
      {state.connected && !busy && (
        <p className="mt-2 text-center text-xs text-gray-500">
          Takes about 30 seconds. Leave the board plugged in.
        </p>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300">
          What&apos;s in this release
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-gray-400">
          {release.changelog}
        </p>
        <p className="mt-2 break-all font-mono text-[11px] text-gray-600">
          SHA-256: {release.binary_sha256}
        </p>
      </details>
    </div>
  );
}
