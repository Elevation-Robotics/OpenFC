// Flash the V1_3 board's companion RP2350 through the ESP32's SWD bridge.
//
// Unlike lib/esptool-flash.ts this never takes the port away from the JSON
// read loop: every step is an ordinary bring-up command answered by a
// bu_* event, so it runs over the live SerialConnection. The sequence is
// the one proven from the bench CLI (firmware-bringup-v1_3/tools/
// bringup_cli.py, cmd_flash): release RUN, SWD probe, begin (halt + erase),
// base64 chunks of RP2350_FLASH_CHUNK bytes each acked before the next is
// sent, then end (flush the last page, re-enter XIP, pulse RUN so the new
// image boots).

import {
  BringupEvent,
  BringupFlashStatus,
  BringupSwdProbe,
  RP2350_FLASH_CHUNK,
  bringupCmd,
  isBringupEvent,
} from './openfc-bringup-protocol';
import type { FlashProgressFn } from './esptool-flash';

/** The two SerialProvider primitives this needs, so it can be driven by a fake in tests. */
export interface Rp2350FlashTransport {
  send: (line: string) => Promise<void>;
  subscribe: (fn: (event: { evt: string }) => void) => () => void;
}

const PROBE_TIMEOUT_MS = 5000;
const BEGIN_TIMEOUT_MS = 30000;
const DATA_TIMEOUT_MS = 10000;
const END_TIMEOUT_MS = 30000;
const RUN_SETTLE_MS = 200;

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send one command and resolve with the first bring-up event matching
 * `pred`. Subscribes before sending so a fast reply cannot be missed.
 */
function request<E extends BringupEvent>(
  t: Rp2350FlashTransport,
  line: string,
  pred: (evt: BringupEvent) => evt is E,
  timeoutMs: number,
  what: string,
): Promise<E> {
  return new Promise<E>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`Timed out waiting for ${what}.`));
    }, timeoutMs);
    const unsub = t.subscribe((raw) => {
      if (!isBringupEvent(raw)) return;
      const evt = raw as unknown as BringupEvent;
      if (!pred(evt)) return;
      clearTimeout(timer);
      unsub();
      resolve(evt);
    });
    t.send(line).catch((e) => {
      clearTimeout(timer);
      unsub();
      reject(e);
    });
  });
}

const isProbe = (e: BringupEvent): e is BringupSwdProbe => e.evt === 'bu_swd_probe';
const isStage =
  (stage: BringupFlashStatus['stage']) =>
  (e: BringupEvent): e is BringupFlashStatus =>
    e.evt === 'bu_flash_status' && e.stage === stage;

export async function flashRp2350(
  t: Rp2350FlashTransport,
  image: ArrayBuffer,
  onProgress: FlashProgressFn,
): Promise<void> {
  const bytes = new Uint8Array(image);
  if (bytes.length === 0) throw new Error('Firmware image is empty.');

  // After an ESP32 reflash the RP2350 sits in reset (RUN low) and SWD sees
  // no DPIDR. Releasing RUN is harmless if it is already running.
  onProgress(0, 'Releasing RP2350 from reset…');
  await t.send(bringupCmd.rp2350Ctrl({ run: true }));
  await delay(RUN_SETTLE_MS);

  onProgress(2, 'Probing SWD…');
  let probe = await request(t, bringupCmd.rp2350SwdProbe(), isProbe, PROBE_TIMEOUT_MS, 'SWD probe');
  if (!probe.ok) {
    await delay(500);
    probe = await request(t, bringupCmd.rp2350SwdProbe(), isProbe, PROBE_TIMEOUT_MS, 'SWD probe');
  }
  if (!probe.ok) {
    throw new Error(`SWD probe failed (${probe.fail ?? 'no DPIDR'}). Is the RP2350 powered and out of reset?`);
  }
  onProgress(4, `RP2350 found: DPIDR ${probe.dpidr}, bootrom ${probe.bootrom_magic}`);

  onProgress(5, `Erasing ${bytes.length.toLocaleString()} bytes…`);
  const begin = await request(
    t,
    bringupCmd.rp2350FlashBegin(bytes.length),
    isStage('begin'),
    BEGIN_TIMEOUT_MS,
    'flash begin',
  );
  if (!begin.ok) throw new Error(`Erase failed (${begin.fail ?? 'unknown'}).`);

  onProgress(8, 'Writing…');
  for (let off = 0; off < bytes.length; off += RP2350_FLASH_CHUNK) {
    const chunk = bytes.subarray(off, Math.min(off + RP2350_FLASH_CHUNK, bytes.length));
    const status = await request(
      t,
      bringupCmd.rp2350FlashData(bytesToBase64(chunk)),
      isStage('data'),
      DATA_TIMEOUT_MS,
      `flash data at ${off}`,
    );
    if (!status.ok) {
      throw new Error(`Write failed at offset ${off} (${status.fail ?? 'unknown'}).`);
    }
    const written = status.received ?? off + chunk.length;
    // 8–96% band for the write; begin/end take the rest.
    const pct = 8 + Math.round((written / bytes.length) * 88);
    onProgress(
      Math.min(pct, 96),
      `Writing ${written.toLocaleString()} / ${bytes.length.toLocaleString()} bytes`,
    );
  }

  onProgress(97, 'Flushing and booting…');
  const end = await request(t, bringupCmd.rp2350FlashEnd(), isStage('end'), END_TIMEOUT_MS, 'flash end');
  if (!end.ok) throw new Error(`Flash end failed (${end.fail ?? 'unknown'}).`);
  if (end.received !== undefined && end.received !== bytes.length) {
    throw new Error(`Length mismatch: board received ${end.received} of ${bytes.length} bytes.`);
  }
  onProgress(100, 'RP2350 flash complete; new image is running.');
}
