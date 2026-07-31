// Wrapper around esptool-js for flashing a merged OpenFC binary. See spec §7.2.
//
// IMPORTANT (port ownership): the caller MUST release the JSON read loop and all
// reader/writer locks AND close the port before calling flashFirmware — esptool-js
// opens its own Transport on the port (SerialConnection.pauseForFlash does this).
// After flashing, the port is left closed; the caller re-opens it
// (SerialConnection.resumeAfterFlash) to restart the JSON read loop.

import { ESPLoader, Transport, IEspLoaderTerminal } from 'esptool-js';
import { BAUD_RATE } from './serial';

export type FlashProgressFn = (pct: number, message: string) => void;

/** esptool-js wants the image as a Latin-1 "binary string", not an ArrayBuffer. */
function arrayBufferToBinaryString(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let result = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    result += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunk)),
    );
  }
  return result;
}

/**
 * Flash a merged binary (bootloader + partition table + app) at address 0x0.
 * Reports coarse progress through onProgress.
 */
export async function flashFirmware(
  port: SerialPort,
  binaryData: ArrayBuffer,
  onProgress: FlashProgressFn,
): Promise<void> {
  const terminal: IEspLoaderTerminal = {
    clean: () => {},
    write: (data: string) => onProgress(-1, data),
    writeLine: (data: string) => onProgress(-1, data),
  };

  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport,
    baudrate: BAUD_RATE,
    romBaudrate: BAUD_RATE,
    terminal,
  });

  try {
    onProgress(0, 'Connecting to bootloader…');
    // main() enters the bootloader via RTS/DTR auto-reset and detects the chip.
    const chip = await loader.main();
    onProgress(5, `Detected ${chip}`);

    const fileData = arrayBufferToBinaryString(binaryData);
    const totalBytes = fileData.length;

    onProgress(8, 'Writing flash at 0x0…');
    await loader.writeFlash({
      fileArray: [{ data: fileData, address: 0x0 }],
      flashSize: 'keep',
      flashMode: 'keep',
      flashFreq: 'keep',
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex: number, written: number, total: number) => {
        const denom = total || totalBytes || 1;
        // Map write progress into the 8–98% band; 0–8% is connect/detect.
        const pct = 8 + Math.round((written / denom) * 90);
        onProgress(
          Math.min(pct, 98),
          `Writing ${written.toLocaleString()} / ${denom.toLocaleString()} bytes`,
        );
      },
    });

    onProgress(99, 'Resetting board…');
    await loader.after('hard_reset');
    onProgress(100, 'Flash complete.');
  } finally {
    // Release esptool's locks and close the port; caller re-opens for JSON loop.
    try {
      await transport.disconnect();
    } catch {
      // ignore
    }
  }
}
