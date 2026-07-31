'use client';

// Shared Web Serial connection state. Mounted at the root layout so the
// connection survives navigation between /flash, /field and /field/match.
// See spec §6.1, §11.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import {
  SerialConnection,
  getGrantedPorts,
  isWebSerialSupported,
} from '@/lib/serial';
import {
  BoardMode,
  BoardState,
  OpenFCEvent,
  PROTO_LEGACY,
  PinState,
  cmd,
} from '@/lib/openfc-protocol';
import {
  VerificationStatus,
  checkAgainstManifest,
  fetchManifest,
} from '@/lib/firmware-hash';

export interface TimedPeriod {
  active: boolean;
  mode: BoardMode | null;
  durationMs: number;
  remainingMs: number;
}

export interface SerialState {
  connected: boolean;
  connecting: boolean;
  error: string | null;
  deviceId: string | null;
  fwVersion: string | null;
  hwVersion: string | null;
  fwHash: string | null;
  /** Wire-protocol revision; null until the board answers get_info. */
  proto: number | null;
  /** Link is down but being retried automatically. */
  reconnecting: boolean;
  /** Number of the reconnect attempt in flight, for UI feedback. */
  reconnectAttempt: number;
  boardState: BoardState | null;
  /** Raw set_pin diagnostics own the outputs, so boardState is not authoritative. */
  diag: boolean;
  timedPeriod: TimedPeriod;
  verification: VerificationStatus | null;
  pinStates: PinState[] | null;
}

const initialState: SerialState = {
  connected: false,
  connecting: false,
  error: null,
  deviceId: null,
  fwVersion: null,
  hwVersion: null,
  fwHash: null,
  proto: null,
  reconnecting: false,
  reconnectAttempt: 0,
  boardState: null,
  diag: false,
  timedPeriod: { active: false, mode: null, durationMs: 0, remainingMs: 0 },
  verification: null,
  pinStates: null,
};

type Action =
  | { type: 'CONNECTING' }
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' }
  | { type: 'LINK_LOST' }
  | { type: 'RECONNECTING'; attempt: number }
  | { type: 'ERROR'; message: string }
  | { type: 'EVENT'; event: OpenFCEvent }
  | { type: 'VERIFICATION'; status: VerificationStatus };

function reducer(state: SerialState, action: Action): SerialState {
  switch (action.type) {
    case 'CONNECTING':
      return { ...initialState, connecting: true };
    case 'CONNECTED':
      return {
        ...state,
        connecting: false,
        connected: true,
        error: null,
        reconnecting: false,
        reconnectAttempt: 0,
      };
    case 'DISCONNECTED':
      return { ...initialState };
    // Link dropped but the board keeps running (a timed period survives a
    // disconnect), so identity and last-known board state are deliberately
    // retained — the match UI must not blank out mid-match.
    case 'LINK_LOST':
      return { ...state, connected: false, connecting: false, reconnecting: true };
    case 'RECONNECTING':
      return { ...state, reconnecting: true, reconnectAttempt: action.attempt };
    case 'ERROR':
      return { ...state, connecting: false, error: action.message };
    case 'VERIFICATION':
      return { ...state, verification: action.status };
    case 'EVENT':
      return applyEvent(state, action.event);
    default:
      return state;
  }
}

function applyEvent(state: SerialState, evt: OpenFCEvent): SerialState {
  switch (evt.evt) {
    case 'hello':
      return {
        ...state,
        deviceId: evt.device_id,
        fwVersion: evt.fw_version,
        hwVersion: evt.hw_version,
        fwHash: evt.fw_hash ?? null,
        proto: evt.proto ?? PROTO_LEGACY,
        verification: null,
      };
    case 'state':
      return {
        ...state,
        boardState: evt.state,
        diag: evt.diag === true,
        timedPeriod: evt.timed
          ? {
              active: true,
              mode: evt.mode,
              durationMs: evt.duration_ms ?? 0,
              remainingMs: evt.remaining_ms ?? 0,
            }
          : { active: false, mode: null, durationMs: 0, remainingMs: 0 },
      };
    case 'timer_state':
      return {
        ...state,
        timedPeriod: evt.active
          ? {
              active: true,
              mode: (evt.mode as BoardMode) ?? null,
              durationMs: evt.duration_ms ?? 0,
              remainingMs: evt.remaining_ms ?? 0,
            }
          : { active: false, mode: null, durationMs: 0, remainingMs: 0 },
      };
    case 'timer_expired':
      return {
        ...state,
        timedPeriod: { active: false, mode: null, durationMs: 0, remainingMs: 0 },
      };
    case 'pins':
      return { ...state, pinStates: evt.pins };
    default:
      return state;
  }
}

export interface SerialContextValue {
  state: SerialState;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  send: (line: string) => Promise<void>;
  subscribe: (fn: (event: OpenFCEvent) => void) => () => void;
  getConnection: () => SerialConnection | null;
}

const SerialContext = createContext<SerialContextValue | null>(null);

export function SerialProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const connectionRef = useRef<SerialConnection | null>(null);
  const listenersRef = useRef<Set<(e: OpenFCEvent) => void>>(new Set());

  const handleEvent = useCallback((event: OpenFCEvent) => {
    dispatch({ type: 'EVENT', event });
    listenersRef.current.forEach((fn) => fn(event));
    if (event.evt === 'hello' && event.fw_hash) {
      const hash = event.fw_hash;
      fetchManifest()
        .then((m) =>
          dispatch({ type: 'VERIFICATION', status: checkAgainstManifest(hash, m) }),
        )
        .catch(() => dispatch({ type: 'VERIFICATION', status: { kind: 'unverified' } }));
    }
  }, []);

  /**
   * Read identity (the boot-time hello is long gone), current state, and any
   * running timer. Used on first connect and after every reconnect, which is
   * what restores a match already in progress on the board. (§6.2)
   */
  const resync = useCallback((connection: SerialConnection) => {
    setTimeout(() => {
      void connection.send(cmd.getInfo());
      void connection.send(cmd.getState());
      void connection.send(cmd.getTimer());
    }, 250);
  }, []);

  const buildConnection = useCallback(() => {
    const connection: SerialConnection = new SerialConnection({
      onEvent: handleEvent,
      onDisconnect: (willRetry) =>
        dispatch({ type: willRetry ? 'LINK_LOST' : 'DISCONNECTED' }),
      onReconnecting: (attempt) => dispatch({ type: 'RECONNECTING', attempt }),
      onReconnected: () => {
        dispatch({ type: 'CONNECTED' });
        resync(connection);
      },
    });
    return connection;
  }, [handleEvent, resync]);

  const connect = useCallback(async () => {
    dispatch({ type: 'CONNECTING' });
    const connection = buildConnection();
    try {
      await connection.connect();
      connectionRef.current = connection;
      dispatch({ type: 'CONNECTED' });
      resync(connection);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect.';
      // User cancelling the port picker should not surface as an error.
      dispatch(
        /NotFoundError|No port selected|cancel/i.test(message)
          ? { type: 'DISCONNECTED' }
          : { type: 'ERROR', message },
      );
    }
  }, [buildConnection, resync]);

  const disconnect = useCallback(async () => {
    await connectionRef.current?.disconnect();
    connectionRef.current = null;
    dispatch({ type: 'DISCONNECTED' });
  }, []);

  const send = useCallback(async (line: string) => {
    await connectionRef.current?.send(line);
  }, []);

  const subscribe = useCallback((fn: (event: OpenFCEvent) => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  const getConnection = useCallback(() => connectionRef.current, []);

  // Restore the link on load without a picker prompt. Chrome remembers the
  // port grant, so a refresh (or an accidental navigation) mid-match silently
  // reattaches to the still-running board instead of stranding the operator
  // behind a Connect button. Runs once; no-ops when nothing was granted.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    let cancelled = false;
    void (async () => {
      if (!isWebSerialSupported() || connectionRef.current) return;
      const [port] = await getGrantedPorts();
      if (!port || cancelled || connectionRef.current) return;
      const connection = buildConnection();
      if (await connection.connectSaved(port)) {
        connectionRef.current = connection;
        dispatch({ type: 'CONNECTED' });
        resync(connection);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildConnection, resync]);

  // Physical replug. The read loop catches most drops, but these fire reliably
  // even when the port was idle, and the connect event lets a reattached board
  // be picked up immediately rather than on the next backoff tick.
  useEffect(() => {
    if (!isWebSerialSupported()) return;
    const onNativeDisconnect = () => connectionRef.current?.handleDrop();
    const onNativeConnect = () => connectionRef.current?.retryNow();
    navigator.serial.addEventListener('disconnect', onNativeDisconnect);
    navigator.serial.addEventListener('connect', onNativeConnect);
    return () => {
      navigator.serial.removeEventListener('disconnect', onNativeDisconnect);
      navigator.serial.removeEventListener('connect', onNativeConnect);
    };
  }, []);

  useEffect(() => {
    return () => {
      void connectionRef.current?.disconnect();
    };
  }, []);

  const value = useMemo<SerialContextValue>(
    () => ({ state, connect, disconnect, send, subscribe, getConnection }),
    [state, connect, disconnect, send, subscribe, getConnection],
  );

  return <SerialContext.Provider value={value}>{children}</SerialContext.Provider>;
}

export function useSerial(): SerialContextValue {
  const ctx = useContext(SerialContext);
  if (!ctx) throw new Error('useSerial must be used within a SerialProvider');
  return ctx;
}

/** Typed command senders bound to the active connection (spec §6.4). */
export function useSerialCommands() {
  const { send } = useSerial();
  return useMemo(
    () => ({
      ping: () => send(cmd.ping()),
      getState: () => send(cmd.getState()),
      getTimer: () => send(cmd.getTimer()),
      getInfo: () => send(cmd.getInfo()),
      identify: () => send(cmd.identify()),
      set: (enable: boolean, mode: BoardMode) => send(cmd.set(enable, mode)),
      estop: () => send(cmd.estop()),
      startPeriod: (mode: BoardMode, durationMs: number) =>
        send(cmd.startPeriod(mode, durationMs)),
      setPin: (pin: number, value: boolean) => send(cmd.setPin(pin, value)),
      getPins: () => send(cmd.getPins()),
    }),
    [send],
  );
}
