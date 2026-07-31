// Shared chrome for the /docs pages: sidebar nav + prose column.
// Server-rendered and serial-free, so documentation is readable (and
// indexable) without a board attached.

import Link from 'next/link';

export const DOCS_NAV = [
  { href: '/docs', label: 'Overview' },
  { href: '/docs/protocol', label: 'Serial protocol' },
  { href: '/docs/api', label: 'Firmware API' },
  { href: '/docs/hardware', label: 'Hardware' },
];

export default function DocsLayout({
  title,
  intro,
  active,
  children,
}: {
  title: string;
  intro?: React.ReactNode;
  active: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <nav className="mb-8 text-sm">
        <Link href="/" className="text-gray-500 hover:text-gray-300">
          ← OpenFC
        </Link>
      </nav>

      <div className="gap-10 lg:flex">
        <aside className="mb-8 shrink-0 lg:mb-0 lg:w-48">
          <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Documentation
          </p>
          <ul className="space-y-1">
            {DOCS_NAV.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block rounded px-2 py-1 text-sm transition ${
                    item.href === active
                      ? 'bg-gray-800 font-medium text-gray-100'
                      : 'text-gray-400 hover:bg-gray-800/50 hover:text-gray-200'
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </aside>

        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
          {intro && <div className="mt-3 text-gray-400">{intro}</div>}
          {children}
        </div>
      </div>
    </main>
  );
}

export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="mt-12 scroll-mt-6">
      <h2 className="border-b border-gray-800 pb-2 text-xl font-semibold">
        {title}
      </h2>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-gray-300">
        {children}
      </div>
    </section>
  );
}

/** Fixed-width code block. `label` names the language or the file. */
export function Code({
  label,
  children,
}: {
  label?: string;
  children: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-950">
      {label && (
        <div className="border-b border-gray-800 px-3 py-1.5 font-mono text-xs text-gray-500">
          {label}
        </div>
      )}
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed text-gray-200">
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function Table({
  head,
  rows,
}: {
  head: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-800">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-gray-900/60">
          <tr>
            {head.map((h) => (
              <th
                key={h}
                className="whitespace-nowrap px-3 py-2 font-semibold text-gray-200"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-gray-800 align-top">
              {row.map((cell, j) => (
                <td key={j} className="px-3 py-2 text-gray-300">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline monospace token, for field names and literal values. */
export function T({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-gray-800/70 px-1 py-0.5 font-mono text-[0.85em] text-gray-200">
      {children}
    </code>
  );
}

export function Note({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'warn';
  children: React.ReactNode;
}) {
  const styles =
    kind === 'warn'
      ? 'border-yellow-800/60 bg-yellow-950/20 text-yellow-100/90'
      : 'border-blue-900/60 bg-blue-950/20 text-blue-100/90';
  return <div className={`rounded-lg border p-4 text-sm ${styles}`}>{children}</div>;
}
