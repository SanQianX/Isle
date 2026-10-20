import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeLimits, loadConfig, PREVIEW_SIZES } from '@/lib/config';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'file:/tmp/isle-unit/db/isle.db',
  MEDIA_ROOT: '/tmp/isle-unit/media',
  UPLOAD_TMP_DIR: '/tmp/isle-unit/tmp',
  PUBLIC_BASE_URL: 'http://127.0.0.1:3017',
} as const;

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...baseEnv };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

describe('config validation', () => {
  it('applies documented defaults from DEPLOY_RUNBOOK §3', () => {
    const config = loadConfig(env());

    expect(config.maxUploadBytes).toBe(26_214_400); // 25 MiB
    expect(config.maxUploadFiles).toBe(30);
    expect(config.maxConcurrentUploads).toBe(2);
    expect(config.maxImagePixels).toBe(100_000_000);
    expect(config.accessMode).toBe('friends-only');
    expect(config.mediaDiskHighWatermark).toBeCloseTo(0.9);
  });

  it('derives original/preview/tmp directories under MEDIA_ROOT', () => {
    const config = loadConfig(env());
    expect(config.originalDir).toBe(path.join(path.resolve('/tmp/isle-unit/media'), 'original'));
    expect(config.previewRoot).toBe(path.join(path.resolve('/tmp/isle-unit/media'), 'preview'));
  });

  it('aborts when DATABASE_URL is missing rather than defaulting to a local dev.db', () => {
    expect(() => loadConfig(env({ DATABASE_URL: undefined }))).toThrowError(
      /DATABASE_URL is required/,
    );
  });

  it('aborts when MEDIA_ROOT or UPLOAD_TMP_DIR is missing', () => {
    expect(() => loadConfig(env({ MEDIA_ROOT: undefined }))).toThrowError(/MEDIA_ROOT is required/);
    expect(() => loadConfig(env({ UPLOAD_TMP_DIR: undefined }))).toThrowError(
      /UPLOAD_TMP_DIR is required/,
    );
  });

  it('rejects a relative DATABASE_URL so a release cannot write inside its own bundle', () => {
    expect(() => loadConfig(env({ DATABASE_URL: 'file:./prisma/dev.db' }))).toThrowError(
      /absolute SQLite path/,
    );
  });

  it('rejects a non-file DATABASE_URL', () => {
    expect(() => loadConfig(env({ DATABASE_URL: 'postgres://user@host/db' }))).toThrowError(
      /must be a file: URL/,
    );
  });

  it('accepts an absolute sqlite path', () => {
    // The spelling that is absolute is the spelling of the machine that will
    // use it. "file:D:/..." is absolute on Windows and *relative* on Linux,
    // where it would put the database inside the release directory -- and the
    // check uses the host's own rules (path.isAbsolute), so the product is
    // right to refuse it there. Asserting the Windows form on every platform
    // asserted a path the product is right to reject, which is why this case
    // failed on CI while passing on the developer's machine.
    const absolute =
      process.platform === 'win32' ? 'file:D:/isle/db/isle.db' : 'file:/var/lib/isle/db/isle.db';
    const config = loadConfig(env({ DATABASE_URL: absolute }));
    expect(path.isAbsolute(config.databaseFile)).toBe(true);
    expect(config.databaseFile).toMatch(/isle[\\/]db[\\/]isle\.db$/);
  });

  it('strips sqlite query parameters such as connection limits', () => {
    const config = loadConfig(
      env({ DATABASE_URL: 'file:/tmp/isle-unit/db/isle.db?connection_limit=1' }),
    );
    expect(config.databaseFile).toBe(path.normalize('/tmp/isle-unit/db/isle.db'));
  });

  it('rejects a relative UPLOAD_TMP_DIR', () => {
    expect(() => loadConfig(env({ UPLOAD_TMP_DIR: 'tmp/uploads' }))).toThrowError(
      /UPLOAD_TMP_DIR must be an absolute path/,
    );
  });
});

describe('visitor cookie naming (ADR-003)', () => {
  it('uses the __Host- prefix only on a secure origin', () => {
    const secure = loadConfig(env({ PUBLIC_BASE_URL: 'https://photos.example.com' }));
    expect(secure.isSecureOrigin).toBe(true);
    expect(secure.visitorCookieName).toBe('__Host-isle_visitor');

    const insecure = loadConfig(env());
    expect(insecure.isSecureOrigin).toBe(false);
    expect(insecure.visitorCookieName).toBe('isle_visitor');
  });

  it('normalises a trailing slash off PUBLIC_BASE_URL', () => {
    expect(loadConfig(env({ PUBLIC_BASE_URL: 'http://127.0.0.1:3017/' })).publicBaseUrl).toBe(
      'http://127.0.0.1:3017',
    );
  });
});

describe('E2E guard flag', () => {
  it('parses the booleanish ISLE_E2E forms', () => {
    for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(loadConfig(env({ ISLE_E2E: truthy })).isE2E).toBe(true);
    }
    for (const falsy of ['0', 'false', 'no', 'off']) {
      expect(loadConfig(env({ ISLE_E2E: falsy })).isE2E).toBe(false);
    }
    expect(loadConfig(env()).isE2E).toBe(false);
  });
});

describe('upload limits shared with the UI', () => {
  it('exposes the same numbers the API enforces', () => {
    const config = loadConfig(env({ MAX_UPLOAD_BYTES: '1048576', MAX_UPLOAD_FILES: '7' }));
    const limits = describeLimits(config);
    expect(limits.maxUploadBytes).toBe(1_048_576);
    expect(limits.maxUploadMiB).toBe(1);
    expect(limits.maxUploadFiles).toBe(7);
    expect(limits.acceptedTypes).toBe('image/jpeg, image/png, image/webp');
  });

  it('pins the two derivative widths required by DATA_API_STORAGE §3', () => {
    expect([...PREVIEW_SIZES]).toEqual([400, 1200]);
  });

  it('rejects nonsensical limits instead of coercing them', () => {
    expect(() => loadConfig(env({ MAX_UPLOAD_BYTES: '0' }))).toThrow();
    expect(() => loadConfig(env({ MAX_UPLOAD_FILES: '9999' }))).toThrow();
    expect(() => loadConfig(env({ MAX_IMAGE_PIXELS: 'lots' }))).toThrow();
  });
});
