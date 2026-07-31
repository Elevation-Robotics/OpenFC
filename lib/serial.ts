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

/**
 * Upper bound on any teardown step (cancel / abort / close). On a port whose
 * device has physically gone away these can hang indefinitely rather than
 * reject, and a hung teardown stalls the whole reconnect loop.
 */
const TEARDOWN_TIMEOUT_MS = 750;

/** Backoff before reconnect attempt N (1-based), capped so a match resyncs fast. */
export function reconnectDelayMs(attempt: number): number {
  const schedule = [250, 500, 1000, 2000];
  const i = Math.min(Math.max(attempt, 1), schedule.length) - 1;
  return schedule[i];
}

/**
 * Run a teardown step that must not be trusted to settle. Resolves on success,
 * on rejection, on a synchronous throw, or when `ms` elapses — whichever comes
 * first. Nothing downstream cares which of those happened.
 */
function settle(fn: () => Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      void fn().then(done, done);
    } catch {
      done();
    }
  });
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
  /** Guards against a native `connect` event racing a backoff tick. */
  private attemptInFlight = false;
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
    // Never take a fresh writer lock while a reconnect is in progress: the
    // match keepalive keeps calling this, and a re-locked stream blocks the
    // port.close() the reconnect depends on.
    if (this.reconnecting || !this.port?.writable) return;
    try {
      if (!this.writer) {
        this.writer = this.port.writable.getWriter();
      }
      await this.writer.write(this.encoder.encode(line + '\n'));
    } catch {
      // Write failed — the device is gone. The writer is deliberately kept so
      // releaseLocks() can abort it and free the lock; dropping the reference
      // here would leave port.writable locked forever.
      this.handleDrop();
    }
  }

  /** Fully close at the user's request; suppresses automatic reconnection. */
  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.reconnecting = false;
    this.cancelRetry();
    await this.releaseLocks();
    if (this.port) {
      // Bounded: closing a port whose device is gone can hang, and the caller
      // is a UI handler ("Cancel" during a reconnect) that must not wedge.
      await settle(() => this.port!.close(), TEARDOWN_TIMEOUT_MS);
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
      await settle(() => this.port!.close(), TEARDOWN_TIMEOUT_MS);
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

  /**
   * Drop the reader/writer locks. port.close() blocks until both streams are
   * unlocked, so anything skipped here strands every later reconnect attempt.
   * The writer is aborted rather than closed: close() waits to flush bytes to
   * a device that, on a cable pull, is already gone.
   */
  private async releaseLocks(): Promise<void> {
    this.readLoopRunning = false;
    const reader = this.reader;
    const writer = this.writer;
    this.reader = null;
    this.writer = null;
    if (reader) {
      await settle(() => reader.cancel(), TEARDOWN_TIMEOUT_MS);
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
    if (writer) {
      await settle(() => writer.abort(), TEARDOWN_TIMEOUT_MS);
      try {
        writer.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  private startReadLoop(): void {
    if (!this.port?.readable) return;
    this.readLoopRunning = true;
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    while (this.readLoopRunning && this.port?.readable) {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      try {
        while (this.readLoopRunning) {
          const { value, done } = await reader.read();
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
          reader.releaseLock();
        } catch {
          // ignore
        }
        if (this.reader === reader) this.reader = null;
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
    if (this.intentionalClose || this.flashing || this.attemptInFlight) return;
    this.attemptInFlight = true;
    try {
      // The dropped port still holds reader/writer locks from the dead session.
      // port.close() blocks until both are released, so this must happen before
      // any open is tried — otherwise every attempt hangs and never reschedules.
      await this.releaseLocks();

      // Prefer the original port object; after a physical replug Chrome may hand
      // back a fresh one, so fall back to any port already granted to us.
      const candidates: SerialPort[] = [];
      if (this.port) candidates.push(this.port);
      for (const p of await getGrantedPorts()) {
        if (!candidates.includes(p)) candidates.push(p);
      }

      for (const port of candidates) {
        if (this.intentionalClose || this.flashing) return;
        // A half-open port from the previous session must be closed first. This
        // is bounded: on an unplugged device close() can hang rather than reject.
        await settle(() => port.close(), TEARDOWN_TIMEOUT_MS);
        try {
          await this.openAndRead(port);
        } catch {
          continue; // Try the next candidate.
        }
        this.handlers.onReconnected?.();
        return;
      }
      this.scheduleRetry();
    } catch {
      // Anything unexpected (e.g. getPorts() throwing) must still leave a retry
      // armed; a swallowed failure here is what strands the UI on "reconnecting".
      this.scheduleRetry();
    } finally {
      this.attemptInFlight = false;
    }
  }

  /**
   * Retry immediately instead of waiting out the backoff. Called when the
   * browser reports a device appearing, which is the moment a replugged board
   * becomes openable. No-ops unless a reconnect is already pending.
   */
  retryNow(): void {
    if (!this.reconnecting || this.intentionalClose || this.flashing) return;
    if (this.attemptInFlight) return;
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
