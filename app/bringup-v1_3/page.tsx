'use client';

// Open FC V1_3 bring-up console — unlisted. Nothing links here. Exercises
// the new dual-MCU prototype board subsystem-by-subsystem before any
// production protocol work happens on it. See
// firmware-bringup-v1_3/{esp32,rp2350}/ for the firmware this talks to, and
// docs/plans/jolly-waddling-harbor.md-equivalent context in
// firmware-bringup-v1_3/esp32/include/openfc_pins_v13.h for what's verified
// vs. assumed on this hardware.

import Link from 'next/link';
import BrowserGate from '@/components/BrowserGate';
import ConnectButton from '@/components/ConnectButton';
import SiteFooter from '@/components/SiteFooter';
import BoardBanner from '@/components/bringup/BoardBanner';
import FieldControlPanel from '@/components/bringup/FieldControlPanel';
import LegacyPortsPanel from '@/components/bringup/LegacyPortsPanel';
import SmartPortPanel from '@/components/bringup/SmartPortPanel';
import RP2350LinkPanel from '@/components/bringup/RP2350LinkPanel';
import IOPanel from '@/components/bringup/IOPanel';
import EventLog from '@/components/bringup/EventLog';

export default function BringupV13Page() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <BrowserGate />
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Open FC V1_3 bring-up</h1>
          <p className="mt-1 text-sm text-gray-400">
            Diagnostic firmware for the new dual-MCU prototype. Not the
            production protocol — see the panels below for what each
            subsystem needs to pass before trusting it. Flash both MCUs from
            the{' '}
            <Link href="/flash/v1_3" className="text-blue-400 hover:underline">
              V1.3 flasher
            </Link>
            ; procedure and wire protocol in{' '}
            <Link href="/docs/v1_3" className="text-blue-400 hover:underline">
              the docs
            </Link>
            .
          </p>
        </div>
        <ConnectButton />
      </div>

      <BoardBanner />

      <div className="space-y-6">
        <FieldControlPanel />
        <LegacyPortsPanel />
        <SmartPortPanel port="A" />
        <SmartPortPanel port="B" />
        <RP2350LinkPanel />
        <SmartPortPanel port="C" />
        <SmartPortPanel port="D" />
        <IOPanel />
        <EventLog />
      </div>

      <p className="mt-8 text-xs text-gray-600">
        Unlisted diagnostic page for unreleased hardware. Everything here
        drives the board directly. Legacy-port polarity is confirmed against
        a live V5 (2026-09-01); the RS-485 Smart ports&apos; wire protocol is
        not — see the note on <code>rs485_linktest</code> in
        firmware-bringup-v1_3/esp32/src/main.cpp before assuming a failed
        link test means broken hardware.
      </p>
      <SiteFooter />
    </main>
  );
}
