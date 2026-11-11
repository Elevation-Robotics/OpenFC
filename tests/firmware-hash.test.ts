import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FirmwareManifest,
  checkAgainstManifest,
  fetchOfficialFirmware,
  isRunningRelease,
  latestCertifiedRelease,
  latestV13Release,
  sha256Hex,
  V13Release,
} from '@/lib/firmware-hash';

function release(over: Partial<FirmwareManifest['official_releases'][0]>) {
  return {
    version: '1.0.0',
    released: '2026-01-01',
    description: '',
    binary_sha256: 'deadbeef',
    download_url: '/firmware/x.bin',
    certified_for_competition: true,
    min_hw_version: '1.1',
    changelog: '',
    ...over,
  };
}

describe('sha256Hex', () => {
  it('hashes the ASCII string "abc" to the known SHA-256', async () => {
    const data = new TextEncoder().encode('abc').buffer;
    expect(await sha256Hex(data)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes empty input to the known SHA-256', async () => {
    expect(await sha256Hex(new ArrayBuffer(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('checkAgainstManifest', () => {
  const manifest: FirmwareManifest = {
    official_releases: [
      release({
        version: '1.2.0',
        binary_sha256: 'AAA111',
        app_sha256: 'APP111',
        certified_for_competition: true,
      }),
      release({ version: '1.1.0', binary_sha256: 'BBB222', certified_for_competition: false }),
    ],
  };

  it('returns official for a certified merged-binary match (case-insensitive)', () => {
    const r = checkAgainstManifest('aaa111', manifest);
    expect(r.kind).toBe('official');
  });

  it('returns official for a certified app-partition (fw_hash) match', () => {
    const r = checkAgainstManifest('app111', manifest);
    expect(r.kind).toBe('official');
  });

  it('returns known for a non-certified match', () => {
    const r = checkAgainstManifest('bbb222', manifest);
    expect(r.kind).toBe('known');
  });

  it('returns unverified for no match', () => {
    expect(checkAgainstManifest('cccccc', manifest).kind).toBe('unverified');
  });

  it('returns unverified for null/empty hash', () => {
    expect(checkAgainstManifest(null, manifest).kind).toBe('unverified');
    expect(checkAgainstManifest(undefined, manifest).kind).toBe('unverified');
  });
});

describe('latestCertifiedRelease', () => {
  it('returns the newest certified release by date', () => {
    const manifest: FirmwareManifest = {
      official_releases: [
        release({ version: '1.1.0', released: '2026-01-01', certified_for_competition: true }),
        release({ version: '1.3.0', released: '2026-06-01', certified_for_competition: true }),
        release({ version: '1.9.0', released: '2026-09-01', certified_for_competition: false }),
      ],
    };
    expect(latestCertifiedRelease(manifest)?.version).toBe('1.3.0');
  });

  it('returns null when nothing is certified', () => {
    const manifest: FirmwareManifest = {
      official_releases: [release({ certified_for_competition: false })],
    };
    expect(latestCertifiedRelease(manifest)).toBeNull();
  });
});

describe('latestV13Release', () => {
  const image = { download_url: '/firmware/x.bin', sha256: 'aa', size: 1 };
  const v13 = (version: string, released: string, certified?: boolean): V13Release => ({
    version,
    released,
    description: '',
    changelog: '',
    certified_for_competition: certified,
    esp32: image,
    rp2350: image,
  });

  it('offers the newest certified release over a newer uncertified one', () => {
    const manifest: FirmwareManifest = {
      official_releases: [],
      v13_releases: [v13('0.1.6', '2026-11-10', true), v13('0.1.7', '2026-12-01', false)],
    };
    expect(latestV13Release(manifest)?.version).toBe('0.1.6');
  });

  it('falls back to the newest release when none is certified', () => {
    const manifest: FirmwareManifest = {
      official_releases: [],
      v13_releases: [v13('0.1.4', '2026-09-27'), v13('0.1.5', '2026-10-20')],
    };
    expect(latestV13Release(manifest)?.version).toBe('0.1.5');
  });

  it('returns null when there are no V1.3 releases', () => {
    expect(latestV13Release({ official_releases: [] })).toBeNull();
  });
});

describe('isRunningRelease', () => {
  const r = release({ binary_sha256: 'AAA111', app_sha256: 'APP111' });

  it('matches the board-reported app-partition hash', () => {
    expect(isRunningRelease('app111', r)).toBe(true);
  });

  it('matches the merged-binary hash', () => {
    expect(isRunningRelease('AAA111', r)).toBe(true);
  });

  it('is false for a different or missing hash', () => {
    expect(isRunningRelease('other', r)).toBe(false);
    expect(isRunningRelease(null, r)).toBe(false);
  });
});

describe('fetchOfficialFirmware', () => {
  const body = new TextEncoder().encode('abc');
  const ABC_SHA =
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

  function mockFetch(manifest: FirmwareManifest, payload: Uint8Array) {
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('manifest.json')
        ? { ok: true, json: async () => manifest }
        : { ok: true, arrayBuffer: async () => payload.buffer },
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it('returns the release and bytes when the hash matches', async () => {
    mockFetch(
      { official_releases: [release({ version: '2.0.0', binary_sha256: ABC_SHA })] },
      body,
    );
    const fw = await fetchOfficialFirmware();
    expect(fw.release.version).toBe('2.0.0');
    expect(fw.data.byteLength).toBe(3);
  });

  it('refuses to flash a payload that fails its integrity check', async () => {
    mockFetch(
      { official_releases: [release({ binary_sha256: 'not-the-real-hash' })] },
      body,
    );
    await expect(fetchOfficialFirmware()).rejects.toThrow(/integrity/i);
  });

  it('throws when nothing is certified', async () => {
    mockFetch(
      { official_releases: [release({ certified_for_competition: false })] },
      body,
    );
    await expect(fetchOfficialFirmware()).rejects.toThrow(/certified/i);
  });
});
