'use client';

// Field controller setup page. See spec §9.1.

import Link from 'next/link';
import BrowserGate from '@/components/BrowserGate';
import ConnectButton from '@/components/ConnectButton';
import SiteFooter from '@/components/SiteFooter';
import MatchSetup from '@/components/field/MatchSetup';

export default function FieldPage() {
  return (
    <main className="mx-auto max-w-xl px-6 py-8">
      <BrowserGate />
      <div className="mb-6 flex items-center justify-between">
        <div>
          <Link href="/" className="text-sm text-gray-500 hover:text-gray-300">
            ← OpenFC
          </Link>
          <h1 className="text-2xl font-bold">Practice Match</h1>
        </div>
        <ConnectButton />
      </div>
      <MatchSetup />
      <SiteFooter />
    </main>
  );
}
