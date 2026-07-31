'use client';

// Full-screen match timer page. Config travels via query params. See spec §9.1–§9.2.

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import MatchTimer from '@/components/field/MatchTimer';
import {
  GAP_MAX_S,
  MatchConfig,
  MatchSequence,
  MatchTransitions,
  PERIOD_MAX_S,
  PERIOD_MIN_S,
} from '@/lib/match-engine';

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (Number.isNaN(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function MatchView() {
  const params = useSearchParams();
  const seqParam = params.get('seq');
  const sequence: MatchSequence =
    seqParam === 'auto' || seqParam === 'driver' ? seqParam : 'both';
  // Manual is the default: practice rarely runs a competition-paced transition,
  // and an older bookmarked URL carries no `trans` param.
  const transitions: MatchTransitions =
    params.get('trans') === 'timed' ? 'timed' : 'manual';

  // The URL is user-editable and bookmarkable, so re-clamp rather than trust it.
  const config: MatchConfig = {
    autoDurationMs:
      clampInt(Number(params.get('auto')), PERIOD_MIN_S, PERIOD_MAX_S, 15) * 1000,
    driverDurationMs:
      clampInt(Number(params.get('driver')), PERIOD_MIN_S, PERIOD_MAX_S, 105) * 1000,
    gapDurationMs: clampInt(Number(params.get('gap')), 0, GAP_MAX_S, 5) * 1000,
    sequence,
    transitions,
  };

  return <MatchTimer config={config} />;
}

export default function MatchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center text-gray-500">
          Loading match…
        </div>
      }
    >
      <MatchView />
    </Suspense>
  );
}
