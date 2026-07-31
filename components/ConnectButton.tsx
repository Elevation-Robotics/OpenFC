'use client';

// Reusable connect/disconnect control with status. See spec §11.

import { useSerial } from './SerialProvider';
import { isWebSerialSupported } from '@/lib/serial';

export default function ConnectButton() {
  const { state, connect, disconnect } = useSerial();
  const supported = isWebSerialSupported();

  // The board keeps running while the link is down, so this is a transient
  // notice with a way out, not a return to the disconnected state.
  if (state.reconnecting) {
    return (
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-full bg-yellow-900/40 px-3 py-1 text-sm text-yellow-200">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-yellow-300/40 border-t-yellow-300" />
          Reconnecting…
        </span>
        <button
          onClick={() => void disconnect()}
          className="rounded-md border border-gray-600 px-3 py-1.5 text-sm text-gray-200 transition hover:bg-gray-800"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (state.connected) {
    return (
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-full bg-green-900/40 px-3 py-1 text-sm text-green-200">
          <span className="h-2 w-2 rounded-full bg-green-400" />
          {state.deviceId ?? 'Connected'}
        </span>
        <button
          onClick={() => void disconnect()}
          className="rounded-md border border-gray-600 px-3 py-1.5 text-sm text-gray-200 transition hover:bg-gray-800"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        onClick={() => void connect()}
        disabled={!supported || state.connecting}
        className="inline-flex items-center gap-2 rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state.connecting ? (
          <>
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            Connecting…
          </>
        ) : (
          'Connect to OpenFC'
        )}
      </button>
      {state.error && (
        <span className="text-sm text-red-400">
          {state.error}{' '}
          <button onClick={() => void connect()} className="underline">
            Retry
          </button>
        </span>
      )}
    </div>
  );
}
