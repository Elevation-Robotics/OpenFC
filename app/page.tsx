import Link from 'next/link';
import SiteFooter from '@/components/SiteFooter';

// Product landing page for the OpenFC board. Server-rendered and deliberately
// serial-free: this is the first page a visitor sees, so it must render without
// a board attached and without prompting for a port. See spec §10.

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <section className="text-center">
        <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">OpenFC</h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-gray-300">
          An open-source VEX V5 field controller. One small board drives all four
          competition ports, so you can run real autonomous and driver periods at
          practice instead of shouting a countdown across the room.
        </p>
        <p className="mx-auto mt-3 max-w-2xl text-sm text-gray-500">
          Plug it in over USB and drive it straight from this page — nothing to
          install, no app, no account. Everything runs in your browser.
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href="/field"
            className="rounded-md bg-green-600 px-6 py-3 font-semibold text-white transition hover:bg-green-500"
          >
            Run a Practice Match ▶
          </Link>
          <Link
            href="/flash"
            className="rounded-md border border-gray-600 px-6 py-3 font-semibold text-gray-100 transition hover:bg-gray-800"
          >
            Flash Firmware
          </Link>
          <Link
            href="/docs"
            className="rounded-md border border-gray-600 px-6 py-3 font-semibold text-gray-100 transition hover:bg-gray-800"
          >
            Documentation
          </Link>
        </div>
      </section>

      <section className="mt-16 grid gap-5 sm:grid-cols-3">
        <Feature
          title="Four ports, driven together"
          body="Drives the ENABLE/DISABLE and DRIVER/AUT lines of four V5 Competition Switch ports in unison, optically isolated from the V5."
        />
        <Feature
          title="The board owns the clock"
          body="Once a period starts, the countdown runs on the board. Close the laptop lid or unplug the cable and the match still finishes on time."
        />
        <Feature
          title="Fails to disabled"
          body="It boots disabled, and outside a timed period it disables itself within 600 ms of losing contact with the host. Robots stop when things go wrong."
        />
      </section>

      <section className="mt-16">
        <h2 className="text-xl font-semibold">How it works</h2>
        <ol className="mt-4 space-y-3">
          <Step n={1} title="Flash the board">
            Pick your board revision, connect over USB, and install the latest
            firmware for it. On a V1.1 board the page hashes what is actually
            running and tells you whether it matches an official release.
          </Step>
          <Step n={2} title="Set your periods">
            Autonomous, driver, or a full match. Move between periods yourself or
            on a timed gap. Durations are yours to pick — 15/90 by default,
            anything up to 10 minutes.
          </Step>
          <Step n={3} title="Run the match">
            A full-screen countdown drives the field. Enter advances the period,
            space stops everything at once.
          </Step>
        </ol>
      </section>

      <section className="mt-16 grid gap-6 sm:grid-cols-2">
        <Panel title="Build it yourself">
          <p>
            The hardware, the firmware and this site are open source. An
            ESP32-S3, four optocouplers and four RJ11 jacks — the schematic and
            the build are public.
          </p>
          <p className="mt-2">
            <Link href="/docs/hardware" className="text-blue-400 hover:underline">
              Hardware reference →
            </Link>
          </p>
        </Panel>
        <Panel title="Drive it from your own code">
          <p>
            The board speaks newline-delimited JSON over USB serial at 115200
            baud. Any language that can open a serial port can start a period or
            trip an e-stop.
          </p>
          <p className="mt-2">
            <Link href="/docs/protocol" className="text-blue-400 hover:underline">
              Protocol reference →
            </Link>
          </p>
        </Panel>
      </section>

      <section className="mt-16 rounded-lg border border-yellow-800/60 bg-yellow-950/20 p-5 text-sm text-yellow-100/90">
        <strong className="font-semibold">Keep the field clear.</strong> OpenFC
        enables and disables real robots. Keep hands clear whenever the field is
        enabled, and confirm the board behaves as expected in your setup before
        relying on it.
      </section>

      <p className="mt-8 text-center text-sm text-gray-500">
        Requires Chrome, Edge, or Opera — the Web Serial API.
      </p>

      <SiteFooter />
    </main>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-5">
      <h3 className="font-semibold text-gray-100">{title}</h3>
      <p className="mt-2 text-sm text-gray-400">{body}</p>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-gray-700 text-sm font-semibold text-gray-300">
        {n}
      </span>
      <span>
        <span className="font-medium text-gray-100">{title}</span>
        <p className="mt-1 text-sm text-gray-400">{children}</p>
      </span>
    </li>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/40 p-5">
      <h3 className="font-semibold text-gray-100">{title}</h3>
      <div className="mt-2 text-sm text-gray-400">{children}</div>
    </div>
  );
}
