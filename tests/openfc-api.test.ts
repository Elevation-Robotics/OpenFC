import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ApiHashIndex,
  verdictFor,
  verifyFirmware,
} from '@/lib/openfc-api';

const index: ApiHashIndex = {
  api_version: 'v1',
  generated_at: '2026-07-31T00:00:00.000Z',
  hashes: {
    aaa111: { version: '1.3.0', certified_for_competition: true, kind: 'app' },
    bbb222: { version: '1.3.0', certified_for_competition: true, kind: 'binary' },
    ccc333: { version: '0.9.0', certified_for_competition: false, kind: 'app' },
  },
};

describe('verdictFor', () => {
  it('certifies a board running a certified release', () => {
    const v = verdictFor('aaa111', index, '1.3.0');
    expect(v.certified).toBe(true);
    expect(v.recognised).toBe(true);
    expect(v.version).toBe('1.3.0');
    expect(v.kind).toBe('app');
    expect(v.outdated).toBe(false);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    expect(verdictFor('  AAA111 ', index).certified).toBe(true);
  });

  it('recognises a known-but-uncertified build without certifying it', () => {
    const v = verdictFor('ccc333', index, '1.3.0');
    expect(v.recognised).toBe(true);
    expect(v.certified).toBe(false);
    expect(v.version).toBe('0.9.0');
  });

  // A custom build is the case competition inspection actually cares about.
  it('rejects an unknown hash', () => {
    const v = verdictFor('deadbeef', index, '1.3.0');
    expect(v.recognised).toBe(false);
    expect(v.certified).toBe(false);
    expect(v.version).toBeNull();
  });

  it('rejects a missing hash (pre-1.2 firmware reports no fw_hash)', () => {
    expect(verdictFor(null, index).certified).toBe(false);
    expect(verdictFor(undefined, index).certified).toBe(false);
    expect(verdictFor('', index).certified).toBe(false);
  });

  it('flags a certified but superseded release as outdated', () => {
    const older: ApiHashIndex = {
      ...index,
      hashes: {
        old1: { version: '1.2.0', certified_for_competition: true, kind: 'app' },
      },
    };
    const v = verdictFor('old1', older, '1.3.0');
    expect(v.certified).toBe(true);
    expect(v.outdated).toBe(true);
    expect(v.latestVersion).toBe('1.3.0');
  });

  it('does not claim outdated when the latest version is unknown', () => {
    expect(verdictFor('aaa111', index).outdated).toBe(false);
  });

  it('identifies a merged-binary hash as kind "binary"', () => {
    expect(verdictFor('bbb222', index).kind).toBe('binary');
  });

  it('treats an entry without a board as V1.1', () => {
    expect(verdictFor('aaa111', index).board).toBe('v1_1');
  });
});

describe('verdictFor with V1.3 releases', () => {
  const both: ApiHashIndex = {
    ...index,
    hashes: {
      v11new: { version: '1.4.0', certified_for_competition: true, kind: 'app', board: 'v1_1' },
      esp016: { version: '0.1.6-bringup', certified_for_competition: true, kind: 'binary', board: 'v1_3', image: 'esp32' },
      esp014: { version: '0.1.4-bringup', certified_for_competition: false, kind: 'binary', board: 'v1_3', image: 'esp32' },
    },
  };
  const latest = { v1_1: '1.4.0', v1_3: '0.1.6-bringup' };

  it('judges a V1.3 image against the V1.3 latest, not the V1.1 one', () => {
    const v = verdictFor('esp016', both, latest);
    expect(v).toMatchObject({ certified: true, board: 'v1_3', outdated: false, latestVersion: '0.1.6-bringup' });
  });

  it('flags an older V1.3 image as outdated and uncertified', () => {
    const v = verdictFor('esp014', both, latest);
    expect(v).toMatchObject({ certified: false, recognised: true, outdated: true });
  });

  it('judges a V1.1 hash against the V1.1 latest', () => {
    expect(verdictFor('v11new', both, latest)).toMatchObject({ board: 'v1_1', outdated: false });
  });

  it('applies a plain version string to V1.1 only', () => {
    expect(verdictFor('esp016', both, '1.4.0').outdated).toBe(false);
  });
});

describe('verifyFirmware', () => {
  afterEach(() => vi.unstubAllGlobals());

  function mockApi(latestVersion: string | null) {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('hashes.json')) {
        return { ok: true, json: async () => index };
      }
      if (url.includes('latest.json')) {
        return {
          ok: true,
          json: async () => ({
            api_version: 'v1',
            generated_at: '',
            latest: latestVersion ? { version: latestVersion } : null,
          }),
        };
      }
      return { ok: false, status: 404 };
    });
  }

  it('resolves a full verdict from the published endpoints', async () => {
    mockApi('1.3.0');
    const v = await verifyFirmware('aaa111');
    expect(v).toMatchObject({ certified: true, version: '1.3.0', outdated: false });
  });

  it('reports outdated against the published latest', async () => {
    mockApi('2.0.0');
    const v = await verifyFirmware('aaa111');
    expect(v.certified).toBe(true);
    expect(v.outdated).toBe(true);
  });

  it('uses latest_v13 for a V1.3 image', async () => {
    const v13Index: ApiHashIndex = {
      ...index,
      hashes: {
        esp015: { version: '0.1.5-bringup', certified_for_competition: false, kind: 'binary', board: 'v1_3', image: 'esp32' },
      },
    };
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('hashes.json')
        ? { ok: true, json: async () => v13Index }
        : {
            ok: true,
            json: async () => ({
              api_version: 'v1',
              generated_at: '',
              latest: { version: '1.4.0' },
              latest_v13: { version: '0.1.6-bringup' },
            }),
          },
    );
    const v = await verifyFirmware('esp015');
    expect(v).toMatchObject({ board: 'v1_3', outdated: true, latestVersion: '0.1.6-bringup' });
  });

  it('throws a descriptive error when an endpoint is unavailable', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }));
    await expect(verifyFirmware('aaa111')).rejects.toThrow(/503/);
  });
});
