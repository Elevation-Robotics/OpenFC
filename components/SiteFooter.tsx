// Shared site footer: navigation, licensing and the Elevation Robotics
// attribution. Used by the landing page and the docs pages so the project's
// origin and terms are stated on every page rather than only on the home page.

import Link from 'next/link';
import {
  LICENSE_HARDWARE,
  LICENSE_SOFTWARE,
  ORG_LOGO,
  ORG_NAME,
  ORG_URL,
  REPO_URL,
} from '@/lib/site';

export default function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-gray-800 pt-8 text-sm text-gray-500">
      <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col items-center gap-2 sm:items-start">
          <p className="flex flex-wrap justify-center gap-x-4 gap-y-1 sm:justify-start">
            <Link href="/docs" className="hover:text-gray-300">
              Documentation
            </Link>
            <Link href="/docs/license" className="hover:text-gray-300">
              License
            </Link>
            <a
              href={REPO_URL}
              className="hover:text-gray-300"
              target="_blank"
              rel="noreferrer"
            >
              Source
            </a>
          </p>
          <p className="text-xs text-gray-600">
            Open source — software under {LICENSE_SOFTWARE}, hardware under{' '}
            {LICENSE_HARDWARE}.
          </p>
        </div>

        <div className="flex flex-col items-center gap-2 sm:items-end">
          <p className="text-xs text-gray-600">A project of</p>
          <a
            href={ORG_URL}
            target="_blank"
            rel="noreferrer"
            className="opacity-80 transition hover:opacity-100"
          >
            {/* Plain <img>: the static export has no image optimizer, and an
                SVG gains nothing from one. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={ORG_LOGO}
              alt={ORG_NAME}
              width={220}
              height={50}
              className="h-9 w-auto"
            />
          </a>
        </div>
      </div>

      <p className="mt-6 text-center text-xs text-gray-600">
        VEX, VEX Robotics and V5 are trademarks of Innovation First, Inc. OpenFC
        is an independent project of Elevation Robotics and is not affiliated
        with, manufactured, endorsed, approved or sponsored by Innovation First,
        Inc., VEX Robotics or the REC Foundation. Those names are used only to
        describe what the board is compatible with.
      </p>
    </footer>
  );
}
