'use client';

// Shows a blocking warning banner when the Web Serial API is unavailable.
// Does not block navigation — the user can still read the page. See spec §11.

import { useEffect, useState } from 'react';
import { isWebSerialSupported } from '@/lib/serial';

export default function BrowserGate() {
  // Resolve support on the client only (avoids SSR/hydration mismatch).
  const [supported, setSupported] = useState<boolean | null>(null);

  useEffect(() => {
    setSupported(isWebSerialSupported());
  }, []);

  if (supported !== false) return null;

  return (
    <div className="w-full bg-red-900/90 border-b border-red-500 px-4 py-3 text-center text-sm text-red-100">
      <strong className="font-semibold">Web Serial not available.</strong> This
      feature needs a Chromium-based browser (Chrome, Edge, or Opera) served over
      HTTPS. Firefox and Safari are not supported.
    </div>
  );
}
