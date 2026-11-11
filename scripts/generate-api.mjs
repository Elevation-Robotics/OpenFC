// Generates the static /api/v1 JSON endpoints from public/firmware/manifest.json.
//
// Runs before `next build` (see package.json). The site is a static export with
// no server, so the "API" is a set of flat files under public/api — real URLs
// that any HTTP client can fetch. Generating them from the same manifest the
// flasher reads is what keeps the published hashes and the shipped binaries in
// agreement.
//
// Also verifies that every binary referenced by the manifest exists on disk and
// hashes to its declared binary_sha256, so a mismatched or truncated artifact
// fails the build instead of shipping as "official".

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

function toApiRelease(r) {
  return {
    version: r.version,
    released: r.released,
    description: r.description,
    changelog: r.changelog,
    binary_sha256: lower(r.binary_sha256),
    ...(r.app_sha256 ? { app_sha256: lower(r.app_sha256) } : {}),
    download_url: r.download_url.startsWith('http')
      ? r.download_url
      : `${BASE_URL}${r.download_url}`,
    certified_for_competition: r.certified_for_competition === true,
    min_hw_version: r.min_hw_version,
  };
}

const byNewest = (a, b) => (a.released < b.released ? 1 : a.released > b.released ? -1 : 0);

/**
 * Fail the build if a manifest entry does not match the bytes on disk. Without
 * this, a bad artifact would be published as certified and only be caught by
 * the browser's integrity check at flash time.
 */
async function verifyBinaries(manifest) {
  for (const r of manifest.official_releases) {
    if (r.download_url.startsWith('http')) continue; // externally hosted
    const file = join(root, 'public', r.download_url.replace(/^\//, ''));
    let bytes;
    try {
      bytes = await readFile(file);
    } catch {
      throw new Error(`manifest lists ${r.version} but ${r.download_url} is missing`);
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== lower(r.binary_sha256)) {
      throw new Error(
        `binary_sha256 mismatch for ${r.version}\n  manifest: ${lower(r.binary_sha256)}\n  on disk:  ${actual}`,
      );
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

  const hashes = {};
  for (const r of releases) {
    const entry = {
      version: r.version,
      certified_for_competition: r.certified_for_competition,
    };
    if (r.app_sha256) hashes[r.app_sha256] = { ...entry, kind: 'app' };
    hashes[r.binary_sha256] = { ...entry, kind: 'binary' };
  }

  await writeJson('releases.json', {
    api_version: API_VERSION,
    generated_at,
    count: releases.length,
    releases,
  });
  await writeJson('latest.json', {
    api_version: API_VERSION,
    generated_at,
    latest: certified[0] ?? null,
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
          'Published firmware releases for the OpenFC VEX V5 field controller. ' +
          'Compare a board-reported fw_hash against these values to confirm it is ' +
          'running an official, competition-certified build.',
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
          { path: `/api/${API_VERSION}/firmware/latest.json`, description: 'Newest competition-certified release.' },
          { path: `/api/${API_VERSION}/firmware/releases.json`, description: 'Every published release, newest first.' },
          { path: `/api/${API_VERSION}/firmware/hashes.json`, description: 'SHA-256 → release lookup for verifying a connected board.' },
        ],
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(
    `api: ${releases.length} release(s), ${Object.keys(hashes).length} hash(es), latest ${certified[0]?.version ?? 'none'}`,
  );
}

main().catch((err) => {
  console.error(`generate-api failed: ${err.message}`);
  process.exit(1);
});
