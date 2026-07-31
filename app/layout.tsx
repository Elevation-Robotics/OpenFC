import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SerialProvider } from '@/components/SerialProvider';

// The site answers on more than one hostname (openfc.dev and
// openfc.elevationrobotics.org). Both serve identical content, so pages declare
// one canonical origin — otherwise search engines treat them as duplicates and
// shared links resolve inconsistently. Must match OPENFC_BASE_URL, which is what
// the generated /api/v1 download links point at.
const SITE_URL = process.env.OPENFC_BASE_URL ?? 'https://openfc.dev';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'OpenFC — Open-source VEX V5 Field Controller',
  description:
    'An open-source VEX V5 field controller. Run real autonomous and driver periods at practice, flash the board, and drive it from your own code — all from the browser.',
  alternates: { canonical: '/' },
};

export const viewport: Viewport = {
  themeColor: '#0d1117',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#0d1117] text-[#e6edf3] antialiased">
        {/* SerialProvider at the root keeps the Web Serial connection alive
            across navigation between /flash, /field and /field/match. */}
        <SerialProvider>{children}</SerialProvider>
      </body>
    </html>
  );
}
