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

// V1.3 boards: which Smart ports have a controller, and the robot name it
// reports (free text set by the team, usually the team number).
function SmartPorts({ ports }: { ports: { port: string; link: boolean; fm: number; robot?: string }[] }) {
  const linked = ports.filter((p) => p.link);
  if (linked.length === 0) {
    return <span className="text-gray-500">no controllers on the Smart ports</span>;
  }
  return (
    <span className="inline-flex flex-wrap gap-2">
      {linked.map((p) => (
        <span
          key={p.port}
          className={`rounded px-1.5 py-0.5 font-mono ${
            p.fm === 2 ? 'bg-green-900/50 text-green-300' : 'bg-yellow-900/50 text-yellow-300'
          }`}
          title={p.fm === 2 ? 'Controller in field mode' : 'Linked, not in field mode'}
        >
          {p.port}
          {p.robot ? ` ${p.robot}` : ''}
        </span>
      ))}
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
      {state.boardKind === 'v13' ? (
        <>
          <span className="rounded bg-blue-900/50 px-1.5 py-0.5 text-blue-300">V1.3 bring-up</span>
          {state.smartPorts && <SmartPorts ports={state.smartPorts} />}
        </>
      ) : (
        <VerificationBadge status={state.verification} />
      )}
    </span>
  );
}
