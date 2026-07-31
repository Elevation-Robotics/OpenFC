'use client';

// Small inline status badge: device id, board state, fw version, verification.
// Used in page headers and the match screen footer. See spec §11.

import { useSerial } from '../SerialProvider';
import { VerificationStatus } from '@/lib/firmware-hash';

function VerificationBadge({ status }: { status: VerificationStatus | null }) {
  if (!status) return null;
  if (status.kind === 'official') {
    return (
      <span className="rounded bg-green-900/50 px-1.5 py-0.5 text-green-300">
        ✓ Official
      </span>
    );
  }
  if (status.kind === 'known') {
    return (
      <span className="rounded bg-yellow-900/50 px-1.5 py-0.5 text-yellow-300">
        Known (uncertified)
      </span>
    );
  }
  return (
    <span className="rounded bg-yellow-900/50 px-1.5 py-0.5 text-yellow-300">
      Unverified
    </span>
  );
}

export default function DeviceStatus() {
  const { state, reconnect } = useSerial();

  // Reconnecting is distinct from disconnected: a timed period is still
  // running on the board, so the identity shown here stays valid.
  if (state.reconnecting) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-yellow-300">
        <span className="h-2 w-2 animate-pulse rounded-full bg-yellow-400" />
        Reconnecting{state.deviceId ? ` to ${state.deviceId}` : ''}…
        <span className="text-gray-500">board still running</span>
        {/* Reachable from the match screen: on platforms that forget the port
            grant this is the only way back, and the match must not be left. */}
        {state.needsUserGesture && (
          <button
            onClick={() => void reconnect()}
            className="rounded-md bg-yellow-600 px-2 py-0.5 text-xs font-semibold text-white transition hover:bg-yellow-500"
          >
            Reconnect
          </button>
        )}
      </span>
    );
  }

  if (!state.connected) {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-gray-500">
        <span className="h-2 w-2 rounded-full bg-gray-600" />
        Not connected
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-sm text-gray-300">
      <span className="h-2 w-2 rounded-full bg-green-400" />
      <span className="font-mono">{state.deviceId ?? 'openfc'}</span>
      <span className="text-gray-500">{state.boardState ?? '—'}</span>
      {state.fwVersion && <span className="text-gray-500">v{state.fwVersion}</span>}
      <VerificationBadge status={state.verification} />
    </span>
  );
}
