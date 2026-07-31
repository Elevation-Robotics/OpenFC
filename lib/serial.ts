// Web Serial connection layer — single point of contact with the browser serial port.
// See spec §6. Shared by both the flasher and the field controller.
//
// Reconnection: a timed period keeps running on the board with the host absent
// (start_period suspends the comms watchdog), so a dropped cable mid-match must
// not end the match — the host just needs to find its way back and resync. The
// port is therefore kept and reopened automatically, and the match UI stays live
// throughout.
//
// Hardware constraint: on the CH340 the auto-reset circuit drives EN/IO0 from
// DTR+RTS, and asserting RTS *without* DTR reboots the board — which mid-match
// would silently kill a running match. Measured on hw 1.1: dtr+rts and dtr-only
// are safe, rts-only resets. Chrome asserts both on open, which is safe, but
// this is why port.open() must never request `flowControl: 'hardware'`.

import { OpenFCEvent, parseEvent } from './openfc-protocol';

export const BAUD_RATE = 115200;

/** Backoff before reconnect attempt N (1-based), capped so a match resyncs fast. */
export function reconnectDelayMs(attempt: number): number {
  const schedule = [250, 500, 1000, 2000];
  const i = Math.min(Math.max(attempt, 1), schedule.length) - 1;
  return schedule[i];
}

export function isWebSerialSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator;
}

/**
 * Ports the user has already granted this origin. Chrome remembers the grant,
 * so these can be reopened without a user gesture — the basis for reconnecting
 * (and for restoring the link after a page reload) with no picker prompt.
 */
export async function getGrantedPorts(): Promise<SerialPort[]> {
  if (!isWebSerialSupported()) return [];
  try {
    return await navigator.serial.getPorts();
  } catch {
    return [];
  }
}

export interface SerialHandlers {
  onEvent: (event: OpenFCEvent) => void;
  /** Link lost. `willRetry` is false only for a user-requested disconnect. */
  onDisconnect: (willRetry: boolean) => void;
  /** A reconnect attempt is pending; `attempt` is 1-based. */
  onReconnecting?: (attempt: number) => void;
  /** Link re-established; the caller should resync board state. */
  onReconnected?: () => void;
}

/**
 * Owns the SerialPort, its reader/writer, and the line-buffering read loop.
 * Designed so the read loop and locks can be released for esptool-js flashing
 * (pauseForFlash / resumeAfterFlash) without losing the port reference.
 */
export class SerialConnection {
  port: SerialPort | null = null;

  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopRunning = false;
  private buffer = '';
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private readonly handlers: SerialHandlers;

  // Reconnect bookkeeping. `intentionalClose` distinguishes a user pressing
  // Disconnect (stay closed) from a cable falling out (retry).
  private intentionalClose = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private reconnecting = false;
  /** Suppresses retries while esptool owns the port during a flash. */
  private flashing = false;

  constructor(handlers: SerialHandlers) {
    this.handlers = handlers;
  }

  /** Prompt the user for a port, open it, and start the read loop. */
  async connect(): Promise<void> {
    if (!isWebSerialSupported()) {
      throw new Error('Web Serial API is not available in this browser.');
    }
    const port = await navigator.serial.requestPort();
    await this.openAndRead(port);
  }

  /**
   * Reopen an already-granted port without prompting. Returns false when no
   * port is available or it could not be opened, so a page load can silently
   * fall back to showing the Connect button.
   */
  async connectSaved(port?: SerialPort): Promise<boolean> {
    const target = port ?? (await getGrantedPorts())[0];
    if (!target) return false;
    try {
      await this.openAndRead(target);
      return true;
    } catch {
      return false;
    }
  }

  private async openAndRead(port: SerialPort): Promise<void> {
    // No flowControl: 'hardware' — see the DTR/RTS note at the top of the file.
    await port.open({ baudRate: BAUD_RATE });
    this.port = port;
    this.intentionalClose = false;
    this.retryAttempt = 0;
    this.reconnecting = false;
    this.startReadLoop();
  }

  /**
   * Serialize and write a command line (appends '\n', UTF-8 encoded). Silently
   * no-ops while the link is down: callers are periodic (pings, resyncs) and a
   * missed command during a reconnect is expected, not an error.
   */
  async send(line: string): Promise<void> {
    if (!this.port?.writable) return;
    try {
      if (!this.writer) {
        this.writer = this.port.writable.getWriter();
      }
      await this.writer.write(this.encoder.encode(line + '\n'));
    } catch {
      // Write failed — the read loop will observe the same drop and retry.
      this.writer = null;
    }
  }

  /** Fully close at the user's request; suppresses automatic reconnection. */
  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.cancelRetry();
    await this.releaseLocks();
    if (this.port) {
      try {
        await this.port.close();
      } catch {
        // Already closed / device unplugged.
      }
      this.port = null;
    }
    this.buffer = '';
  }

  /** Release reader/writer locks and close the port, keeping the reference for resume. */
  async pauseForFlash(): Promise<void> {
    // esptool takes over the port; a drop here is expected, not a failure.
    this.flashing = true;
    this.cancelRetry();
    await this.releaseLocks();
    if (this.port) {
      try {
        await this.port.close();
      } catch {
        // ignore
      }
    }
    this.buffer = '';
  }

  /** Re-open the (already referenced) port and restart the JSON read loop. */
  async resumeAfterFlash(): Promise<void> {
    this.flashing = false;
    if (!this.port) throw new Error('No port to resume.');
    await this.port.open({ baudRate: BAUD_RATE });
    this.startReadLoop();
  }

  private async releaseLocks(): Promise<void> {
    this.readLoopRunning = false;
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // ignore
      }
      try {
        this.reader.releaseLock();
      } catch {
        // ignore
      }
      this.reader = null;
    }
    if (this.writer) {
      try {
        await this.writer.close();
      } catch {
        // ignore
      }
      try {
        this.writer.releaseLock();
      } catch {
        // ignore
      }
      this.writer = null;
    }
  }

  private startReadLoop(): void {
    if (!this.port?.readable) return;
    this.readLoopRunning = true;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    while (this.readLoopRunning && this.port?.readable) {
      this.reader = this.port.readable.getReader();
      try {
        while (this.readLoopRunning) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this.ingest(value);
        }
      } catch {
        // Read error — typically a physical disconnect.
        if (this.readLoopRunning) {
          this.readLoopRunning = false;
          this.handleDrop();
        }
      } finally {
        try {
          this.reader.releaseLock();
        } catch {
          // ignore
        }
        this.reader = null;
      }
    }
  }

  /**
   * The link went away on its own. Notify, then start retrying unless this was
   * a user disconnect or a flash. Safe to call more than once per drop.
   */
  handleDrop(): void {
    if (this.intentionalClose || this.flashing) return;
    this.readLoopRunning = false;
    this.writer = null;
    this.buffer = '';
    if (this.reconnecting) return;
    this.reconnecting = true;
    this.handlers.onDisconnect(true);
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.intentionalClose || this.flashing) return;
    this.cancelRetry();
    this.retryAttempt += 1;
    const attempt = this.retryAttempt;
    this.handlers.onReconnecting?.(attempt);
    this.retryTimer = setTimeout(() => {
      void this.attemptReconnect();
    }, reconnectDelayMs(attempt));
  }

  private async attemptReconnect(): Promise<void> {
    if (this.intentionalClose || this.flashing) return;

    // Prefer the original port object; after a physical replug Chrome may hand
    // back a fresh one, so fall back to any port already granted to us.
    const candidates: SerialPort[] = [];
    if (this.port) candidates.push(this.port);
    for (const p of await getGrantedPorts()) {
      if (!candidates.includes(p)) candidates.push(p);
    }

    for (const port of candidates) {
      try {
        // A half-open port from the previous session must be closed first.
        try {
          await port.close();
        } catch {
          // Wasn't open — fine.
        }
        await this.openAndRead(port);
        this.handlers.onReconnected?.();
        return;
      } catch {
        // Try the next candidate.
      }
    }
    this.scheduleRetry();
  }

  /**
   * Retry immediately instead of waiting out the backoff. Called when the
   * browser reports a device appearing, which is the moment a replugged board
   * becomes openable. No-ops unless a reconnect is already pending.
   */
  retryNow(): void {
    if (!this.reconnecting || this.intentionalClose || this.flashing) return;
    this.cancelRetry();
    void this.attemptReconnect();
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private ingest(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const event = parseEvent(line);
      if (event) this.handlers.onEvent(event);
    }
  }
}
