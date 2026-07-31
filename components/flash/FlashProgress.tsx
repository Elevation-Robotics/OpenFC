'use client';

// Progress bar + scrolling log during a flash. See spec §7.3.

import { useEffect, useRef } from 'react';

interface Props {
  active: boolean;
  pct: number;
  message: string;
  log: string[];
}

export default function FlashProgress({ active, pct, message, log }: Props) {
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  if (!active && log.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="h-3 w-full overflow-hidden rounded-full bg-gray-800">
        <div
          className="h-full bg-blue-500 transition-all"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
        />
      </div>
      <p className="mt-2 text-sm text-gray-300">
        {Math.max(0, Math.round(pct))}% — {message}
      </p>
      {log.length > 0 && (
        <pre
          ref={logRef}
          className="mt-3 max-h-40 overflow-auto rounded-md bg-black/60 p-3 text-xs leading-relaxed text-gray-400"
        >
          {log.join('\n')}
        </pre>
      )}
    </div>
  );
}
