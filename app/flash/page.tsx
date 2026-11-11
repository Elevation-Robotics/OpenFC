import Link from 'next/link';
import SiteFooter from '@/components/SiteFooter';

// Firmware flasher entry point. The two board revisions take different images
// and different flash procedures, so the board is chosen before anything is
// written: /flash/v1_1 for the single-MCU board, /flash/v1_3 for the dual-MCU
// board. Each flasher offers the latest published release for its board.

const BOARDS = [
  {
    href: '/flash/v1_1',
    name: 'V1.1',
    summary: 'Single ESP32-S3. Four competition ports.',
    steps: 'One step, about 30 seconds.',
  },
  {
    href: '/flash/v1_3',
    name: 'V1.3',
    summary:
      'ESP32-S3 plus RP2350. Four competition ports and four Smart ports.',
    steps:
      'Two steps: the ESP32-S3, then unplug and replug the board, then the RP2350.',
  },
];

export default function FlashChooser() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <div className="mb-6">
        <Link href="/" className="text-sm text-gray-500 hover:text-gray-300">
          ← OpenFC
        </Link>
        <h1 className="text-2xl font-bold">Flash Firmware</h1>
        <p className="mt-1 text-sm text-gray-400">
          Which board do you have? The two revisions take different firmware,
          so pick yours before connecting. The firmware version number is
          unrelated to the board revision.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {BOARDS.map((b) => (
          <Link
            key={b.href}
            href={b.href}
            className="rounded-xl border border-gray-700 bg-gray-900/50 p-5 transition hover:border-blue-500 hover:bg-gray-900"
          >
            <h2 className="text-lg font-semibold">{b.name} board</h2>
            <p className="mt-2 text-sm text-gray-400">{b.summary}</p>
            <p className="mt-3 text-xs text-gray-500">{b.steps}</p>
            <p className="mt-4 text-sm font-semibold text-blue-400">
              Flash the {b.name} board →
            </p>
          </Link>
        ))}
      </div>

      <p className="mt-6 text-sm text-gray-500">
        Not sure? Count the jacks. A V1.1 board has four. A V1.3 board has
        eight, four on each side, and <em>OPEN FC V1_3</em> on the silkscreen.
        See{' '}
        <Link href="/docs/hardware" className="text-blue-400 hover:underline">
          Hardware
        </Link>{' '}
        for photos and design files.
      </p>

      <SiteFooter />
    </main>
  );
}
