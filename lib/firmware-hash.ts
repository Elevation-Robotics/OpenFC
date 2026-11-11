// Firmware integrity & official verification. See spec §8.
// SHA-256 via the Web Crypto API + checking against the published manifest.

export interface OfficialRelease {
  version: string;
  released: string;
  description: string;
  /** SHA-256 of the merged binary file (what the flasher hashes). */
  binary_sha256: string;
  /**
   * SHA-256 of the application partition image — the value the firmware
   * self-reports as `fw_hash` in its hello event (spec §8.3). Lets a connected
   * board be verified even though its reported hash differs from the merged
   * file's hash. Optional for backward compatibility with older manifests.
   */
  app_sha256?: string;
  download_url: string;
  certified_for_competition: boolean;
  min_hw_version: string;
  changelog: string;
}

/** One MCU's image within a V1.3 release. */
export interface V13Image {
  download_url: string;
  /** SHA-256 of the file as served, checked after download. */
  sha256: string;
  size: number;
}

/**
 * A release for the V1.3 dual-MCU board: a merged ESP32-S3 image (flashed
 * with esptool at 0x0, like `official_releases`) plus a raw RP2350 image the
 * ESP32 writes over its SWD bridge. Kept apart from `official_releases` so
 * the one-click certified path can never pick up a V1.3 image, and so that
 * `checkAgainstManifest` (which verifies a production board's `fw_hash`)
 * ignores it.
 */
export interface V13Release {
  version: string;
  released: string;
  description: string;
  changelog: string;
  /** Optional for manifests published before V1.3 releases were certified. */
  certified_for_competition?: boolean;
  esp32: V13Image;
  rp2350: V13Image;
}

export interface FirmwareManifest {
  official_releases: OfficialRelease[];
  /** Optional: absent from manifests published before the V1.3 board. */
  v13_releases?: V13Release[];
}

export type VerificationStatus =
  | { kind: 'official'; release: OfficialRelease }
  | { kind: 'known'; release: OfficialRelease } // matches a non-certified release
  | { kind: 'unverified' };

/** Compute the lowercase hex SHA-256 of a binary buffer. */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bufferToHex(digest);
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/** Fetch the official firmware manifest from /firmware/manifest.json. */
export async function fetchManifest(): Promise<FirmwareManifest> {
  const res = await fetch('/firmware/manifest.json', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Failed to load firmware manifest (${res.status}).`);
  }
  return (await res.json()) as FirmwareManifest;
}

/**
 * Compare a firmware hash against the manifest.
 * Matches either the merged-binary hash (`binary_sha256`, used by the file
 * uploader) or the app-partition hash (`app_sha256`, self-reported by a
 * connected board as `fw_hash`), so both verification paths share this function.
 * A certified match → 'official'; a non-certified match → 'known'; else 'unverified'.
 * Comparison is case-insensitive on the hex string.
 */
export function checkAgainstManifest(
  hash: string | null | undefined,
  manifest: FirmwareManifest,
): VerificationStatus {
  if (!hash) return { kind: 'unverified' };
  const normalized = hash.trim().toLowerCase();
  const match = manifest.official_releases.find(
    (r) =>
      r.binary_sha256.trim().toLowerCase() === normalized ||
      r.app_sha256?.trim().toLowerCase() === normalized,
  );
  if (!match) return { kind: 'unverified' };
  return match.certified_for_competition
    ? { kind: 'official', release: match }
    : { kind: 'known', release: match };
}

/** The latest certified-for-competition release, if any. */
export function latestCertifiedRelease(
  manifest: FirmwareManifest,
): OfficialRelease | null {
  const certified = manifest.official_releases.filter(
    (r) => r.certified_for_competition,
  );
  if (certified.length === 0) return null;
  // Assume the manifest lists newest first; otherwise sort by release date.
  return certified
    .slice()
    .sort((a, b) => (a.released < b.released ? 1 : -1))[0];
}

export interface OfficialFirmware {
  release: OfficialRelease;
  data: ArrayBuffer;
}

/**
 * Download the latest certified release and verify the bytes against the
 * manifest before handing them to the flasher. The download is same-origin, but
 * hashing it anyway means a corrupted or swapped file is caught here rather
 * than becoming a bricked board — the one-click path has no human in the loop
 * to notice a wrong hash.
 */
export async function fetchOfficialFirmware(): Promise<OfficialFirmware> {
  const manifest = await fetchManifest();
  const release = latestCertifiedRelease(manifest);
  if (!release) throw new Error('No certified firmware is published.');

  const res = await fetch(release.download_url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Firmware download failed (${res.status}).`);
  const data = await res.arrayBuffer();

  const actual = await sha256Hex(data);
  if (actual !== release.binary_sha256.trim().toLowerCase()) {
    throw new Error(
      'Downloaded firmware failed its integrity check. Refusing to flash.',
    );
  }
  return { release, data };
}

/**
 * The V1.3 release the flasher offers: the newest certified one, or the
 * newest of all when none is certified. Null when the manifest has none.
 */
export function latestV13Release(manifest: FirmwareManifest): V13Release | null {
  const list = (manifest.v13_releases ?? [])
    .slice()
    .sort((a, b) => (a.released < b.released ? 1 : -1));
  if (list.length === 0) return null;
  return list.find((r) => r.certified_for_competition) ?? list[0];
}

/**
 * Download one V1.3 image and verify it against the manifest hash before it
 * is handed to either flasher. Same rationale as fetchOfficialFirmware: the
 * RP2350 path in particular has a verify-on-board step, but a wrong file that
 * verifies fine is still a wrong file.
 */
export async function fetchV13Image(image: V13Image): Promise<ArrayBuffer> {
  const res = await fetch(image.download_url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Firmware download failed (${res.status}).`);
  const data = await res.arrayBuffer();
  const actual = await sha256Hex(data);
  if (actual !== image.sha256.trim().toLowerCase()) {
    throw new Error(
      'Downloaded firmware failed its integrity check. Refusing to flash.',
    );
  }
  return data;
}

/** True when the board already reports this exact release. */
export function isRunningRelease(
  fwHash: string | null | undefined,
  release: OfficialRelease,
): boolean {
  if (!fwHash) return false;
  const normalized = fwHash.trim().toLowerCase();
  return (
    normalized === release.app_sha256?.trim().toLowerCase() ||
    normalized === release.binary_sha256.trim().toLowerCase()
  );
}
