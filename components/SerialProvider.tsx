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
  PeriodAddress,
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
  /** Token of the running period (proto 3); null when untokenised or idle. */
  matchId: string | null;
  periodSeq: number | null;
  /** The board requires a device_id on commands for this period. */
  bound: boolean;
  /**
   * Token of the last period to finish, reported by the board while idle. A
   * reconnecting host uses this to tell "my start_period was lost" apart from
   * "my match already ended" — the distinction that decides whether replaying
   * it would re-enable robots after the match.
   */
  lastMatchId: string | null;
  lastPeriodSeq: number | null;
}

const NO_PERIOD: TimedPeriod = {
  active: false,
  mode: null,
  durationMs: 0,
  remainingMs: 0,
  matchId: null,
  periodSeq: null,
  bound: false,
  lastMatchId: null,
  lastPeriodSeq: null,
};

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
  /**
   * Retrying cannot restore the link on its own — the browser forgot the port
   * grant and only a click can bring it back. Automatic retries continue.
   */
  needsUserGesture: boolean;
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
  needsUserGesture: false,
  boardState: null,
  diag: false,
  timedPeriod: NO_PERIOD,
  verification: null,
  pinStates: null,
};

type Action =
  | { type: 'CONNECTING' }
  | { type: 'CONNECTED' }
  | { type: 'DISCONNECTED' }
  | { type: 'LINK_LOST' }
  | { type: 'RECONNECTING'; attempt: number }
  | { type: 'NEEDS_USER_GESTURE' }
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
        needsUserGesture: false,
      };
    case 'DISCONNECTED':
      return { ...initialState };
    // Link dropped but the board keeps running (a timed period survives a
    // disconnect), so identity and last-known board state are deliberately
    // retained — the match UI must not blank out mid-match.
    case 'LINK_LOST':
      return {
        ...state,
        connected: false,
        connecting: false,
        reconnecting: true,
        needsUserGesture: false,
      };
    case 'RECONNECTING':
      return { ...state, reconnecting: true, reconnectAttempt: action.attempt };
    case 'NEEDS_USER_GESTURE':
      return { ...state, needsUserGesture: true };
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
        // state says nothing about a retired token, so its idle case must not
        // clear one already learned from timer_state.
        timedPeriod: evt.timed
          ? {
              ...NO_PERIOD,
              active: true,
              mode: evt.mode,
              durationMs: evt.duration_ms ?? 0,
              remainingMs: evt.remaining_ms ?? 0,
              matchId: evt.match_id ?? null,
              periodSeq: evt.period_seq ?? null,
              bound: evt.bound === true,
              lastMatchId: state.timedPeriod.lastMatchId,
              lastPeriodSeq: state.timedPeriod.lastPeriodSeq,
            }
          : {
              ...NO_PERIOD,
              lastMatchId: state.timedPeriod.lastMatchId,
              lastPeriodSeq: state.timedPeriod.lastPeriodSeq,
            },
      };
    case 'timer_state':
      return {
        ...state,
        timedPeriod: evt.active
          ? {
              ...NO_PERIOD,
              active: true,
              mode: (evt.mode as BoardMode) ?? null,
              durationMs: evt.duration_ms ?? 0,
              remainingMs: evt.remaining_ms ?? 0,
              matchId: evt.match_id ?? null,
              periodSeq: evt.period_seq ?? null,
              bound: evt.bound === true,
            }
          : {
              ...NO_PERIOD,
              lastMatchId: evt.last_match_id ?? null,
              lastPeriodSeq: evt.last_period_seq ?? null,
            },
      };
    case 'timer_expired':
      // The board retires the token here, so record it: this is what stops a
      // later replay from being mistaken for a lost start_period.
      return {
        ...state,
        timedPeriod: {
          ...NO_PERIOD,
          lastMatchId: evt.match_id ?? state.timedPeriod.matchId,
          lastPeriodSeq: evt.period_seq ?? state.timedPeriod.periodSeq,
        },
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
  /**
   * Re-grant a forgotten port from a user gesture, keeping the current session
   * (and the match UI) alive. Only meaningful while `needsUserGesture` is set.
   */
  reconnect: () => Promise<void>;
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
      onNeedsUserGesture: () => dispatch({ type: 'NEEDS_USER_GESTURE' }),
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

  // Falls back to a fresh connect() when there is no session to resume, so the
  // same control works whether or not a drop is being retried. Cancelling the
  // picker leaves the reconnect state untouched: the retries are still running.
  const reconnect = useCallback(async () => {
    const connection = connectionRef.current;
    if (!connection) {
      await connect();
      return;
    }
    try {
      await connection.reconnectWithPrompt();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reconnect.';
      if (!/NotFoundError|No port selected|cancel/i.test(message)) {
        dispatch({ type: 'ERROR', message });
      }
    }
  }, [connect]);

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
    () => ({ state, connect, reconnect, disconnect, send, subscribe, getConnection }),
    [state, connect, reconnect, disconnect, send, subscribe, getConnection],
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
      // `addr` carries the proto-3 token and device binding. Omit it only for
      // a board on an older protocol; with it, a replay of the same token is
      // recognised rather than treated as a request for a new period.
      startPeriod: (mode: BoardMode, durationMs: number, addr?: PeriodAddress) =>
        send(cmd.startPeriod(mode, durationMs, addr)),
      resync: (addr: PeriodAddress, remainingMs: number) =>
        send(cmd.resync(addr, remainingMs)),
      endPeriod: (addr: PeriodAddress) => send(cmd.endPeriod(addr)),
      setPin: (pin: number, value: boolean) => send(cmd.setPin(pin, value)),
      getPins: () => send(cmd.getPins()),
    }),
    [send],
  );
}
