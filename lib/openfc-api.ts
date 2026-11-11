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

/** Board revision a release or hash belongs to. */
export type Board = 'v1_1' | 'v1_3';

/** A V1.1 release. */
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
  board: 'v1_1';
}

/** One MCU's image within a V1.3 release. */
export interface ApiV13Image {
  /** SHA-256 of the file as served. */
  sha256: string;
  size: number;
  download_url: string;
}

/** A V1.3 release: one image per MCU, flashed ESP32-S3 first. */
export interface ApiV13Release {
  version: string;
  released: string;
  description: string;
  changelog: string;
  certified_for_competition: boolean;
  board: 'v1_3';
  images: { esp32: ApiV13Image; rp2350: ApiV13Image };
}

export interface ApiLatest {
  api_version: string;
  generated_at: string;
  /** Newest certified V1.1 release. */
  latest: ApiRelease | null;
  /** Newest certified V1.3 release. Absent from indexes generated before V1.3 was added. */
  latest_v13?: ApiV13Release | null;
}

export interface ApiReleaseList {
  api_version: string;
  generated_at: string;
  /** Number of V1.1 releases. */
  count: number;
  releases: ApiRelease[];
  v13_count?: number;
  v13_releases?: ApiV13Release[];
}

/** Which hash matched: what a board reports vs. what a file hashes to. */
export type HashKind = 'app' | 'binary';

export interface ApiHashEntry {
  version: string;
  certified_for_competition: boolean;
  kind: HashKind;
  /** Absent from indexes generated before V1.3 was added; those are all V1.1. */
  board?: Board;
  /** V1.3 only: which MCU's image this is. */
  image?: 'esp32' | 'rp2350';
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
  /** Board the matched release is for; null when nothing matched. */
  board: Board | null;
  /** True when a newer certified release exists for the same board. */
  outdated: boolean;
  /** Newest certified version for the matched board (V1.1 when nothing matched). */
  latestVersion: string | null;
}

/** Newest certified version per board, as passed to `verdictFor`. */
export interface LatestVersions {
  v1_1?: string | null;
  v1_3?: string | null;
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
 * Decide whether a board-reported `fw_hash` or a file's SHA-256 is a certified
 * official build. `latest` is the newest certified V1.1 version, or the newest
 * per board; "outdated" is judged against the matched release's own board.
 * Pure, so it can be unit-tested and reused offline against a cached index.
 */
export function verdictFor(
  fwHash: string | null | undefined,
  index: ApiHashIndex,
  latest: string | null | LatestVersions = null,
): FirmwareVerdict {
  const latestBy: LatestVersions =
    latest !== null && typeof latest === 'object' ? latest : { v1_1: latest };
  const base: FirmwareVerdict = {
    certified: false,
    recognised: false,
    version: null,
    kind: null,
    board: null,
    outdated: false,
    latestVersion: latestBy.v1_1 ?? null,
  };
  if (!fwHash) return base;

  const entry = index.hashes[fwHash.trim().toLowerCase()];
  if (!entry) return base;

  const board: Board = entry.board ?? 'v1_1';
  const latestVersion = latestBy[board] ?? null;
  return {
    certified: entry.certified_for_competition,
    recognised: true,
    version: entry.version,
    kind: entry.kind,
    board,
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
  return verdictFor(fwHash, index, {
    v1_1: latest.latest?.version ?? null,
    v1_3: latest.latest_v13?.version ?? null,
  });
}
