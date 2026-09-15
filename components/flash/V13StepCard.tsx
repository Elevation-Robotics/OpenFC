'use client';

// One MCU's step on the V1.3 flasher (app/flash/v1_3): the published image
// as the default action, with a custom .bin behind a disclosure for firmware
// development. The page owns the flash routine; this only picks the bytes.

import { useState } from 'react';
import FirmwareUploader, { SelectedFirmware } from './FirmwareUploader';
import type { V13Image } from '@/lib/firmware-hash';

interface Props {
  step: number;
  title: string;
  /** Short explanation of what this step writes and how. */
  children: React.ReactNode;
  version: string | null;
  image: V13Image | null;
  /** Runs the flash with the given bytes; `label` names the source in the log. */
  onFlash: (fetchData: () => Promise<ArrayBuffer>, label: string) => void;
  fetchImage: (image: V13Image) => Promise<ArrayBuffer>;
  connected: boolean;
  busy: boolean;
  /** Extra reason the step is not runnable right now (shown under the button). */
  blockedReason?: string | null;
}

export default function V13StepCard({
  step,
  title,
  children,
  version,
  image,
  onFlash,
  fetchImage,
  connected,
  busy,
  blockedReason,
}: Props) {
  const [custom, setCustom] = useState<SelectedFirmware | null>(null);
  const disabled = !connected || busy || !!blockedReason;

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900/50 p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gray-800 text-xs font-semibold text-gray-300">
          {step}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{title}</h2>
          <div className="mt-1 space-y-2 text-sm text-gray-400">{children}</div>
        </div>
      </div>

      <button
        onClick={() => {
          if (!image) return;
          onFlash(() => fetchImage(image), `published v${version}`);
        }}
        disabled={disabled || !image}
        className="mt-4 w-full rounded-md bg-blue-600 px-4 py-2.5 font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy
          ? 'Flashing…'
          : image
            ? `Flash ${title} v${version}`
            : 'No published image'}
      </button>
      {image && (
        <p className="mt-2 break-all text-center font-mono text-[11px] text-gray-600">
          {(image.size / 1024).toFixed(0)} KB · SHA-256 {image.sha256}
        </p>
      )}
      {!connected && (
        <p className="mt-2 text-center text-sm text-gray-500">
          Connect the board to enable flashing.
        </p>
      )}
      {connected && blockedReason && (
        <p className="mt-2 text-center text-sm text-yellow-300">{blockedReason}</p>
      )}

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-gray-500 hover:text-gray-300">
          Flash a custom build instead
        </summary>
        <div className="mt-3">
          <FirmwareUploader onSelect={setCustom} disabled={busy} />
        </div>
        <button
          onClick={() => {
            if (!custom) return;
            const data = custom.data;
            onFlash(async () => data, custom.name);
          }}
          disabled={disabled || !custom}
          className="mt-3 w-full rounded-md border border-gray-600 px-4 py-2 text-sm font-semibold text-gray-100 transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Flashing…' : `Flash custom ${title} image`}
        </button>
      </details>
    </section>
  );
}
