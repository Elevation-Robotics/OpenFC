// Client for the public OpenFC firmware API (spec §13).
//
// The API is a set of static JSON files under /api/v1, generated at build time
// by scripts/generate-api.mjs from public/firmware/manifest.json. This module
// only *consumes* them — the generator is the single place that produces them,
// so the two cannot drift.
//
// Third-party applications can use this module directly, or just fetch the same
// URLs themselves; the endpoints are plain JSON over HTTP with no auth.

export const API_VERSION = 'v1';
export const API_BASE = `/api/${API_VERSION}`;

export interface ApiRelease {
  version: string;
  released: string;
  description: string;
  changelog: string;
  /** SHA-256 of the merged flashable image. */
  binary_sha256: string;
  /**
   * SHA-256 of the application partition — the value a board self-reports as
   * `fw_hash` in its hello event. This is the field to compare a connected
   * board against.
   */
  app_sha256?: string;
  download_url: string;
  certified_for_competition: boolean;
  min_hw_version: string;
}

export interface ApiLatest {
  api_version: string;
  generated_at: string;
  latest: ApiRelease | null;
}

export interface ApiReleaseList {
  api_version: string;
  generated_at: string;
  count: number;
  releases: ApiRelease[];
}

/** Which hash matched: what a board reports vs. what a file hashes to. */
export type HashKind = 'app' | 'binary';

export interface ApiHashEntry {
  version: string;
  certified_for_competition: boolean;
  kind: HashKind;
}

export interface ApiHashIndex {
  api_version: string;
  generated_at: string;
  hashes: Record<string, ApiHashEntry>;
}

/**
 * Result of checking a firmware hash against the published API.
 *
 * `certified` is the competition-legality answer: the bytes running on the
 * board are byte-for-byte a build we published AND that build is approved for
 * competition. Anything else is `false`, including a real-but-superseded
 * release, so callers cannot accidentally treat "recognised" as "legal".
 */
export interface FirmwareVerdict {
  certified: boolean;
  /** True when the hash matches any published release, certified or not. */
  recognised: boolean;
  version: string | null;
  kind: HashKind | null;
  /** True when a newer certified release exists than the one running. */
  outdated: boolean;
  latestVersion: string | null;
}

async function getJson<T>(url: string, baseUrl: string): Promise<T> {
  const res = await fetch(`${baseUrl}${url}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`OpenFC API request failed (${res.status}): ${url}`);
  return (await res.json()) as T;
}

/** The newest competition-certified release, or null if none is published. */
export function fetchLatestFirmware(baseUrl = ''): Promise<ApiLatest> {
  return getJson<ApiLatest>(`${API_BASE}/firmware/latest.json`, baseUrl);
}

/** Every published release, newest first. */
export function fetchReleases(baseUrl = ''): Promise<ApiReleaseList> {
  return getJson<ApiReleaseList>(`${API_BASE}/firmware/releases.json`, baseUrl);
}

/** The SHA-256 → release lookup table. */
export function fetchHashIndex(baseUrl = ''): Promise<ApiHashIndex> {
  return getJson<ApiHashIndex>(`${API_BASE}/firmware/hashes.json`, baseUrl);
}

/**
 * Decide whether a board-reported `fw_hash` is a certified official build.
 * Pure, so it can be unit-tested and reused offline against a cached index.
 */
export function verdictFor(
  fwHash: string | null | undefined,
  index: ApiHashIndex,
  latestVersion: string | null = null,
): FirmwareVerdict {
  const base: FirmwareVerdict = {
    certified: false,
    recognised: false,
    version: null,
    kind: null,
    outdated: false,
    latestVersion,
  };
  if (!fwHash) return base;

  const entry = index.hashes[fwHash.trim().toLowerCase()];
  if (!entry) return base;

  return {
    certified: entry.certified_for_competition,
    recognised: true,
    version: entry.version,
    kind: entry.kind,
    outdated: latestVersion !== null && entry.version !== latestVersion,
    latestVersion,
  };
}

/**
 * One-call competition check: fetch the index and the latest release, then
 * judge the board's hash. This is the entry point an event partner or a
 * third-party field-management app would use.
 */
export async function verifyFirmware(
  fwHash: string | null | undefined,
  baseUrl = '',
): Promise<FirmwareVerdict> {
  const [index, latest] = await Promise.all([
    fetchHashIndex(baseUrl),
    fetchLatestFirmware(baseUrl),
  ]);
  return verdictFor(fwHash, index, latest.latest?.version ?? null);
}
