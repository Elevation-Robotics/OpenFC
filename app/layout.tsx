import type { Metadata, Viewport } from 'next';
import './globals.css';
import { SerialProvider } from '@/components/SerialProvider';
import { SITE_URL } from '@/lib/site';

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
