'use client';

// Full-screen match countdown. Browser timer via rAF (in MatchEngine); board
// timer is authoritative for safety. See spec §9.2. Works with production
// (protocol 3) boards and V1.3 boards; lib/match-board.ts has the difference.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  MatchConfig,
  MatchEngine,
  MatchPhase,
  MatchState,
} from '@/lib/match-engine';
import { boardFor } from '@/lib/match-board';
import { useSerial } from '../SerialProvider';
import DeviceStatus from './DeviceStatus';

const COLORS: Record<MatchPhase, { bg: string; fg: string }> = {
  idle: { bg: '#0d1117', fg: '#ffffff' },
  gap: { bg: '#0d1117', fg: '#ffffff' },
  waiting: { bg: '#0d1117', fg: '#ffffff' },
  auto: { bg: '#0d1f4d', fg: '#93c5fd' },
  driver: { bg: '#0d2e14', fg: '#86efac' },
  stopped: { bg: '#2e0d0d', fg: '#fca5a5' },
  error: { bg: '#2e0d0d', fg: '#fca5a5' },
  done: { bg: '#1a1a2e', fg: '#ffffff' },
};

function fmt(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function MatchTimer({ config }: { config: MatchConfig }) {
  const router = useRouter();
  const { send, subscribe, state: serial } = useSerial();
  const boardKind = serial.boardKind ?? 'proto3';
  const engineRef = useRef<MatchEngine | null>(null);
  const configRef = useRef(config);
  const [m, setM] = useState<MatchState>({
    phase: 'idle',
    phaseStartedAt: 0,
    phaseDurationMs: 0,
    timeRemainingMs: 0,
  });
  const [showHint, setShowHint] = useState(true);

  // Create the engine once per board dialect. The dialect is known before this
  // page is reached (setup requires a connected board) and a reconnect to the
  // same board reports the same one, so this does not recreate mid-match.
  useEffect(() => {
    const sendLine = (line: string) => void send(line);
    const engine = new MatchEngine(configRef.current, sendLine, boardFor(boardKind, sendLine));
    engineRef.current = engine;
    const unsub = engine.subscribe(setM);
    return () => {
      unsub();
      engine.destroy();
      engineRef.current = null;
    };
  }, [send, boardKind]);

  // Feed board events to the engine and re-sync on reconnect (get_timer / state).
  useEffect(() => {
    return subscribe((evt) => {
      const engine = engineRef.current;
      if (!engine) return;
      engine.handleEvent(evt);
      // timer_state is the board's answer to get_timer, sent on every (re)connect.
      // Its `active: false` case is meaningful: it means a start_period was lost
      // while the link was down, so the engine re-arms the board.
      if (evt.evt === 'timer_state') {
        engine.resyncTimer(evt.active === true, evt.remaining_ms ?? 0);
      }
      if (evt.evt === 'state' && evt.timed && typeof evt.remaining_ms === 'number') {
        engine.syncRemaining(evt.remaining_ms);
      }
    });
  }, [subscribe]);

  // Space = STOP during an active match (§9.2.5); Enter = advance the phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const engine = engineRef.current;
      if (!engine) return;
      const ph = engine.getState().phase;
      if (e.code === 'Space') {
        if (ph === 'auto' || ph === 'driver' || ph === 'gap' || ph === 'waiting') {
          e.preventDefault();
          engine.stop();
        }
        return;
      }
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        if (ph === 'idle') {
          e.preventDefault();
          engine.start();
        } else if (engine.canAdvance()) {
          e.preventDefault();
          engine.advance();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setShowHint(false), 5000);
    return () => clearTimeout(t);
  }, []);

  const { bg, fg } = COLORS[m.phase];
  const running = m.phase === 'auto' || m.phase === 'driver';
  const active = running || m.phase === 'gap' || m.phase === 'waiting';
  const firstMs =
    config.sequence === 'driver' ? config.driverDurationMs : config.autoDurationMs;
  const progress =
    active && m.phaseDurationMs > 0
      ? (m.phaseDurationMs - m.timeRemainingMs) / m.phaseDurationMs
      : 0;

  // Ending a period early is only a transition when another one follows;
  // otherwise it just ends the match, which STOP already does.
  const hasNext =
    config.sequence === 'both' && (m.phase === 'auto' || m.phase === 'gap' ||
      m.phase === 'waiting');

  let bigText = fmt(m.timeRemainingMs);
  if (m.phase === 'idle') bigText = fmt(firstMs);
  else if (m.phase === 'waiting') bigText = fmt(config.driverDurationMs);
  else if (m.phase === 'done') bigText = '✓';
  else if (m.phase === 'stopped' || m.phase === 'error') bigText = '0:00';

  return (
    <div
      className="relative flex h-screen w-screen flex-col items-center justify-center overflow-hidden transition-colors duration-300"
      style={{ backgroundColor: bg, color: fg }}
    >
      {active && (
        <button
          onClick={() => engineRef.current?.stop()}
          style={{ zIndex: 50 }}
          className="fixed right-4 top-4 rounded-md bg-red-600 px-5 py-3 text-lg font-bold text-white shadow-lg hover:bg-red-500"
        >
          STOP
        </button>
      )}

      <div
        className="text-center font-mono font-bold leading-none"
        style={{ fontSize: 'clamp(8rem, 20vw, 18rem)' }}
      >
        {bigText}
      </div>
      <div className="mt-4 text-2xl font-semibold tracking-widest sm:text-4xl">
        {label(m)}
      </div>

      <div className="mt-6 h-1 w-3/4 max-w-3xl overflow-hidden rounded bg-white/10">
        <div
          className="h-full bg-white/70 transition-[width] duration-100"
          style={{ width: `${progress * 100}%` }}
        />
      </div>

      {m.phase === 'idle' && (
        <button
          onClick={() => engineRef.current?.start()}
          className="mt-10 rounded-lg bg-green-600 px-10 py-4 text-2xl font-bold text-white hover:bg-green-500"
        >
          START MATCH ▶
        </button>
      )}
      {hasNext && (
        <button
          onClick={() => engineRef.current?.advance()}
          className="mt-10 rounded-lg bg-green-600 px-10 py-4 text-2xl font-bold text-white hover:bg-green-500"
        >
          {m.phase === 'auto' ? 'SKIP TO DRIVER ▶' : 'START DRIVER ▶'}
        </button>
      )}
      {m.phase === 'done' && (
        <div className="mt-10 flex gap-4">
          <ActionButton onClick={() => engineRef.current?.reset()}>Run Again</ActionButton>
          <ActionButton onClick={() => router.push('/field')}>New Match</ActionButton>
        </div>
      )}
      {(m.phase === 'stopped' || m.phase === 'error') && (
        <div className="mt-10">
          <ActionButton onClick={() => router.push('/field')}>Back to Setup</ActionButton>
        </div>
      )}

      <footer className="absolute bottom-3 left-0 right-0 flex flex-col items-center gap-1 text-xs">
        <DeviceStatus />
        {active && showHint && (
          <span className="text-white/50">
            {hasNext ? 'ENTER to advance · SPACE to stop' : 'Press SPACE to stop'}
          </span>
        )}
      </footer>
    </div>
  );
}

function label(m: MatchState): string {
  switch (m.phase) {
    case 'idle':
      return 'READY';
    case 'auto':
      return 'AUTONOMOUS';
    case 'driver':
      return 'DRIVER CONTROL';
    case 'gap':
      return `TRANSITION IN ${fmt(m.timeRemainingMs)}`;
    case 'waiting':
      return 'READY FOR DRIVER CONTROL';
    case 'done':
      return 'MATCH COMPLETE';
    case 'stopped':
      return 'MATCH STOPPED';
    case 'error':
      return 'BOARD WATCHDOG — CHECK CONNECTION';
  }
}

function ActionButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-md border border-white/30 px-6 py-3 text-lg font-medium text-white hover:bg-white/10"
    >
      {children}
    </button>
  );
}
