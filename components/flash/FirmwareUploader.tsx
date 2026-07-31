'use client';

// File picker + drag-drop for a custom .bin. The official release has its own
// one-click card, so this is only the firmware-development path. See spec §7.1.

import { useCallback, useRef, useState } from 'react';
import {
  VerificationStatus,
  checkAgainstManifest,
  fetchManifest,
  sha256Hex,
} from '@/lib/firmware-hash';

export interface SelectedFirmware {
  name: string;
  size: number;
  data: ArrayBuffer;
  sha256: string;
  verification: VerificationStatus;
}

interface Props {
  onSelect: (fw: SelectedFirmware | null) => void;
  disabled?: boolean;
}

export default function FirmwareUploader({ onSelect, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<SelectedFirmware | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ingest = useCallback(
    async (name: string, data: ArrayBuffer) => {
      setBusy(true);
      setError(null);
      try {
        const sha256 = await sha256Hex(data);
        let verification: VerificationStatus = { kind: 'unverified' };
        try {
          verification = checkAgainstManifest(sha256, await fetchManifest());
        } catch {
          // Manifest unavailable — treat as unverified custom firmware.
        }
        const fw: SelectedFirmware = {
          name,
          size: data.byteLength,
          data,
          sha256,
          verification,
        };
        setSelected(fw);
        onSelect(fw);
      } finally {
        setBusy(false);
      }
    },
    [onSelect],
  );

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith('.bin')) {
        setError('Please choose a .bin firmware file.');
        return;
      }
      await ingest(file.name, await file.arrayBuffer());
    },
    [ingest],
  );

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (disabled) return;
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        className={`rounded-lg border-2 border-dashed p-6 text-center transition ${
          dragging ? 'border-blue-400 bg-blue-950/30' : 'border-gray-600'
        } ${disabled ? 'opacity-50' : ''}`}
      >
        <p className="text-sm text-gray-300">Drag &amp; drop a .bin file here</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => inputRef.current?.click()}
            disabled={disabled || busy}
            className="rounded-md border border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-800 disabled:opacity-50"
          >
            Browse
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".bin"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />

        {busy && <p className="mt-3 text-sm text-gray-400">Hashing…</p>}
        {selected && !busy && (
          <div className="mt-4 rounded-md bg-gray-900 p-3 text-left text-sm">
            <p className="font-mono text-gray-200">
              {selected.name}{' '}
              <span className="text-gray-500">
                ({(selected.size / 1024).toFixed(0)} KB)
              </span>
            </p>
            <p className="mt-1 break-all font-mono text-xs text-gray-400">
              SHA-256: {selected.sha256}
            </p>
            <div className="mt-2">
              <FileBadge status={selected.verification} />
            </div>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}

function FileBadge({ status }: { status: VerificationStatus }) {
  if (status.kind === 'official') {
    return (
      <span className="rounded bg-green-900/50 px-2 py-1 text-xs text-green-300">
        ✓ Official firmware (v{status.release.version})
      </span>
    );
  }
  if (status.kind === 'known') {
    return (
      <span className="rounded bg-yellow-900/50 px-2 py-1 text-xs text-yellow-300">
        Known build, not certified (v{status.release.version})
      </span>
    );
  }
  return (
    <span className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-300">
      Custom / unverified firmware
    </span>
  );
}
