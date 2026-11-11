// Generates the static /api/v1 JSON endpoints from public/firmware/manifest.json.
//
// Runs before `next build` (see package.json). The site is a static export with
// no server, so the "API" is a set of flat files under public/api — real URLs
// that any HTTP client can fetch. Generating them from the same manifest the
// flasher reads is what keeps the published hashes and the shipped binaries in
// agreement.
//
// Also verifies that every binary referenced by the manifest exists on disk and
// hashes to its declared binary_sha256 (V1.3: sha256 and size), so a mismatched
// or truncated artifact fails the build instead of shipping as "official".
//
// V1.1 releases keep the original v1 shapes (`releases`, `latest`); V1.3
// releases are additive fields (`v13_releases`, `latest_v13`), so existing
// clients are unaffected. Every hash entry names its `board`.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(root, 'public', 'firmware', 'manifest.json');
const outDir = join(root, 'public', 'api', 'v1', 'firmware');

// Absolute URLs make the API usable from another origin without a base URL.
// Overridable so a fork or a preview deploy emits its own links.
const BASE_URL = (process.env.OPENFC_BASE_URL ?? 'https://openfc.dev').replace(/\/$/, '');
const API_VERSION = 'v1';
// Kept in step with REPO_URL in lib/site.ts; this script is plain node and
// cannot import the TypeScript module.
const SOURCE_URL = 'https://github.com/Elevation-Robotics/OpenFC';

const lower = (s) => String(s ?? '').trim().toLowerCase();
const absolute = (url) => (url.startsWith('http') ? url : `${BASE_URL}${url}`);
const V13_IMAGES = ['esp32', 'rp2350'];

function toApiRelease(r) {
  return {
    version: r.version,
    released: r.released,
    description: r.description,
    changelog: r.changelog,
    binary_sha256: lower(r.binary_sha256),
    ...(r.app_sha256 ? { app_sha256: lower(r.app_sha256) } : {}),
    download_url: absolute(r.download_url),
    certified_for_competition: r.certified_for_competition === true,
    min_hw_version: r.min_hw_version,
    board: 'v1_1',
  };
}

function toApiV13Release(r) {
  const images = {};
  for (const name of V13_IMAGES) {
    images[name] = {
      sha256: lower(r[name].sha256),
      size: r[name].size,
      download_url: absolute(r[name].download_url),
    };
  }
  return {
    version: r.version,
    released: r.released,
    description: r.description,
    changelog: r.changelog,
    certified_for_competition: r.certified_for_competition === true,
    board: 'v1_3',
    images,
  };
}

const byNewest = (a, b) => (a.released < b.released ? 1 : a.released > b.released ? -1 : 0);

/**
 * Fail the build if a manifest entry does not match the bytes on disk. Without
 * this, a bad artifact would be published as certified and only be caught by
 * the browser's integrity check at flash time.
 */
async function verifyFile(label, url, sha256, size) {
  if (url.startsWith('http')) return; // externally hosted
  let bytes;
  try {
    bytes = await readFile(join(root, 'public', url.replace(/^\//, '')));
  } catch {
    throw new Error(`manifest lists ${label} but ${url} is missing`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== lower(sha256)) {
    throw new Error(
      `sha256 mismatch for ${label}\n  manifest: ${lower(sha256)}\n  on disk:  ${actual}`,
    );
  }
  if (size !== undefined && bytes.length !== size) {
    throw new Error(`size mismatch for ${label}: manifest ${size}, on disk ${bytes.length}`);
  }
}

async function verifyBinaries(manifest) {
  for (const r of manifest.official_releases) {
    await verifyFile(r.version, r.download_url, r.binary_sha256);
  }
  for (const r of manifest.v13_releases ?? []) {
    for (const name of V13_IMAGES) {
      await verifyFile(`V1.3 ${r.version} ${name}`, r[name].download_url, r[name].sha256, r[name].size);
    }
  }
}

async function writeJson(name, data) {
  await writeFile(join(outDir, name), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return name;
}

async function main() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.official_releases)) {
    throw new Error('manifest.json has no official_releases array');
  }

  await verifyBinaries(manifest);
  await mkdir(outDir, { recursive: true });

  const generated_at = new Date().toISOString();
  const releases = manifest.official_releases.map(toApiRelease).sort(byNewest);
  const certified = releases.filter((r) => r.certified_for_competition);
  const v13Releases = (manifest.v13_releases ?? []).map(toApiV13Release).sort(byNewest);
  const v13Certified = v13Releases.filter((r) => r.certified_for_competition);

  const hashes = {};
  for (const r of releases) {
    const entry = {
      version: r.version,
      certified_for_competition: r.certified_for_competition,
      board: r.board,
    };
    if (r.app_sha256) hashes[r.app_sha256] = { ...entry, kind: 'app' };
    hashes[r.binary_sha256] = { ...entry, kind: 'binary' };
  }
  // Newest first, so an image carried unchanged into a later release (the
  // RP2350 image is identical in 0.1.5 and 0.1.6) resolves to that release.
  for (const r of v13Releases) {
    for (const name of V13_IMAGES) {
      const sha = r.images[name].sha256;
      if (hashes[sha]) continue;
      hashes[sha] = {
        version: r.version,
        certified_for_competition: r.certified_for_competition,
        board: r.board,
        kind: 'binary',
        image: name,
      };
    }
  }

  await writeJson('releases.json', {
    api_version: API_VERSION,
    generated_at,
    count: releases.length,
    releases,
    v13_count: v13Releases.length,
    v13_releases: v13Releases,
  });
  await writeJson('latest.json', {
    api_version: API_VERSION,
    generated_at,
    latest: certified[0] ?? null,
    latest_v13: v13Certified[0] ?? null,
  });
  await writeJson('hashes.json', {
    api_version: API_VERSION,
    generated_at,
    hashes,
  });

  await mkdir(join(root, 'public', 'api', API_VERSION), { recursive: true });
  await writeFile(
    join(root, 'public', 'api', API_VERSION, 'index.json'),
    `${JSON.stringify(
      {
        api_version: API_VERSION,
        name: 'OpenFC Firmware API',
        description:
          'Published firmware releases for the OpenFC VEX V5 field controller, V1.1 and V1.3 ' +
          'boards. Compare a board-reported fw_hash (V1.1) or a firmware file\'s SHA-256 ' +
          'against these values to confirm it is an official, competition-certified build.',
        documentation_url: `${BASE_URL}/docs/api/`,
        source_url: SOURCE_URL,
        license: { software: 'Apache-2.0', hardware: 'CERN-OHL-P-2.0' },
        license_url: `${BASE_URL}/docs/license/`,
        trademark_notice:
          'VEX, VEX Robotics and V5 are trademarks of Innovation First, Inc. (IFI). OpenFC is an ' +
          'independent project of Elevation Robotics and is not affiliated with, manufactured, ' +
          'endorsed, approved or sponsored by Innovation First, Inc., VEX Robotics or the Robotics ' +
          'Education & Competition Foundation (RECF). These names are used only to describe ' +
          'hardware compatibility.',
        generated_at,
        endpoints: [
          { path: `/api/${API_VERSION}/firmware/latest.json`, description: 'Newest competition-certified release for each board.' },
          { path: `/api/${API_VERSION}/firmware/releases.json`, description: 'Every published release for each board, newest first.' },
          { path: `/api/${API_VERSION}/firmware/hashes.json`, description: 'SHA-256 → release lookup, for verifying a connected board or a firmware file.' },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(
    `api: ${releases.length} V1.1 + ${v13Releases.length} V1.3 release(s), ${Object.keys(hashes).length} hash(es), ` +
      `latest ${certified[0]?.version ?? 'none'} / V1.3 ${v13Certified[0]?.version ?? 'none'}`,
  );
}

main().catch((err) => {
  console.error(`generate-api failed: ${err.message}`);
  process.exit(1);
});
