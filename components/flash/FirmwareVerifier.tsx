'use client';

// Shows the connected board's current firmware + integrity verification badge.
// Reads device info (incl. self-reported fw_hash) from the shared serial state.
// See spec §8.

import { useSerial } from '../SerialProvider';
import { VerificationStatus } from '@/lib/firmware-hash';

export default function FirmwareVerifier() {
  const { state } = useSerial();

  if (!state.connected) {
    return (
      <p className="text-sm text-gray-500">
        Connect a board to read its current firmware.
      </p>
    );
  }

  return (
    <div className="rounded-lg border border-gray-700 bg-gray-900/50 p-4">
      <h3 className="text-sm font-semibold text-gray-300">Current firmware</h3>
      <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span>
          Version:{' '}
          <span className="font-mono text-gray-200">{state.fwVersion ?? '—'}</span>
        </span>
        <span>
          HW:{' '}
          <span className="font-mono text-gray-200">{state.hwVersion ?? '—'}</span>
        </span>
      </div>
      {state.fwHash && (
        <p className="mt-1 break-all font-mono text-xs text-gray-500">
          Hash: {state.fwHash}
        </p>
      )}
      <div className="mt-3">
        <Badge status={state.verification} hasHash={!!state.fwHash} />
      </div>
    </div>
  );
}

function Badge({
  status,
  hasHash,
}: {
  status: VerificationStatus | null;
  hasHash: boolean;
}) {
  if (!hasHash) {
    return (
      <span className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-300">
        Firmware does not report a hash (pre-1.2 build)
      </span>
    );
  }
  if (status === null) {
    return (
      <span className="rounded bg-gray-700 px-2 py-1 text-xs text-gray-400">
        Checking manifest…
      </span>
    );
  }
  if (status.kind === 'official') {
    return (
      <span className="rounded bg-green-900/50 px-3 py-1 text-sm font-semibold text-green-300">
        ✓ Official Firmware
      </span>
    );
  }
  if (status.kind === 'known') {
    return (
      <span className="rounded bg-yellow-900/50 px-3 py-1 text-sm font-semibold text-yellow-300">
        Known build — not certified
      </span>
    );
  }
  return (
    <span className="rounded bg-yellow-900/50 px-3 py-1 text-sm font-semibold text-yellow-300">
      Unverified Firmware
    </span>
  );
}
