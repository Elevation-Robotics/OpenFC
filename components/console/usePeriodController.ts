'use client';

// React binding for PeriodController. Keeps one controller alive across
// reconnects — the board keeps counting while the link is down, so tearing the
// controller down with the connection would lose the token that is the only way
// back into the running period.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSerial } from '../SerialProvider';
import {
  PeriodController,
  PeriodStatus,
  mintMatchId,
} from '@/lib/period-controller';
import { BoardMode, PeriodToken } from '@/lib/openfc-protocol';

export interface UsePeriodController {
  status: PeriodStatus;
  start: (mode: BoardMode, durationMs: number, token?: PeriodToken) => void;
  end: () => void;
  reassert: () => void;
  reconcile: () => void;
  resyncTo: (remainingMs: number) => 'sent' | 'skipped' | 'out_of_range';
  clear: () => void;
  /** A token was recovered from a previous page load and is being reconciled. */
  restored: boolean;
}

export function usePeriodController(): UsePeriodController {
  const { send, subscribe, state } = useSerial();
  const controllerRef = useRef<PeriodController | null>(null);
  const [status, setStatus] = useState<PeriodStatus>(() => ({
    phase: 'idle',
    token: null,
    mode: null,
    durationMs: 0,
    remainingMs: 0,
    boardRemainingMs: null,
    driftMs: null,
    deviceId: null,
    bound: false,
    error: null,
    recovered: false,
  }));
  const [restored, setRestored] = useState(false);

  // `send` is stable from the provider, but guard anyway: rebuilding the
  // controller would drop a live token.
  const sendRef = useRef(send);
  sendRef.current = send;

  if (!controllerRef.current) {
    controllerRef.current = new PeriodController({
      send: (line) => void sendRef.current(line),
      onChange: setStatus,
    });
  }

  useEffect(() => {
    const controller = controllerRef.current;
    return subscribe((evt) => controller?.handleEvent(evt));
  }, [subscribe]);

  // Drive the countdown and the periodic reconcile.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      controllerRef.current?.tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // On the first connection of this page load, pick up any token the previous
  // one left behind. This is the reload case: the board may still be running
  // the period, and only the board can say.
  const restoredOnce = useRef(false);
  useEffect(() => {
    if (!state.connected || restoredOnce.current) return;
    restoredOnce.current = true;
    // After the provider's own get_info/get_state/get_timer burst, so the
    // reconcile is not lost in the reply to a query we did not send.
    const id = setTimeout(() => {
      if (controllerRef.current?.restore()) setRestored(true);
    }, 400);
    return () => clearTimeout(id);
  }, [state.connected]);

  // Every reconnect is a chance for the board to have moved on without us.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (state.connected && !wasConnected.current) {
      controllerRef.current?.reconcile();
    }
    wasConnected.current = state.connected;
  }, [state.connected]);

  const start = useCallback(
    (mode: BoardMode, durationMs: number, token?: PeriodToken) => {
      const c = controllerRef.current;
      if (!c) return;
      // A period_seq must never repeat on a board, so default to a fresh
      // match_id rather than reusing one with an incremented sequence.
      c.start(
        mode,
        durationMs,
        token ?? { matchId: mintMatchId(), periodSeq: 1 },
        state.deviceId,
      );
      setRestored(false);
    },
    [state.deviceId],
  );

  return {
    status,
    start,
    end: useCallback(() => controllerRef.current?.end(), []),
    reassert: useCallback(() => controllerRef.current?.reassert(), []),
    reconcile: useCallback(() => controllerRef.current?.reconcile(), []),
    resyncTo: useCallback(
      (ms: number) => controllerRef.current?.resyncTo(ms) ?? 'skipped',
      [],
    ),
    clear: useCallback(() => {
      controllerRef.current?.clear();
      setRestored(false);
    }, []),
    restored,
  };
}
