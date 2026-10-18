import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getConfig, loadConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type StorageProbe = { ok: boolean; reason?: string };

/**
 * Verify a directory exists and is writable by this process.
 * Writes a real probe file then removes it — `access(W_OK)` alone lies on some
 * filesystems and under read-only mounts, and it misses the full disk case.
 */
async function probeWritableDir(dir: string): Promise<StorageProbe> {
  const probeName = `.health-${process.pid}-${Date.now()}`;
  const probePath = path.join(dir, probeName);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probePath, 'ok', { flag: 'wx' });
    await fs.rm(probePath, { force: true });
    return { ok: true };
  } catch (error) {
    await fs.rm(probePath, { force: true }).catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return { ok: false, reason: code };
  }
}

/**
 * GET /api/health — DEPLOY_RUNBOOK §9.
 *
 * Checks DB readability and storage writability. Returns 200 when healthy and
 * 503 when degraded, so systemd/nginx can act on it. Deliberately reports only
 * boolean-ish signals and error codes: never absolute paths, never the database
 * URL, never credentials.
 */
export async function GET(): Promise<NextResponse> {
  let config;
  try {
    // Re-read from the live environment rather than the module-level cache so a
    // health probe after a config change reflects reality.
    config = loadConfig();
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        checks: { config: { ok: false, reason: 'INVALID_CONFIG' } },
        message: error instanceof Error ? error.message.split('\n')[0] : 'invalid configuration',
      },
      { status: 503 },
    );
  }

  const [originalDir, previewRoot, tmpDir] = await Promise.all([
    probeWritableDir(config.originalDir),
    probeWritableDir(config.previewRoot),
    probeWritableDir(config.uploadTmpDir),
  ]);

  const checks = {
    config: { ok: true as const },
    originalDir,
    previewRoot,
    tmpDir,
  };

  const healthy = originalDir.ok && previewRoot.ok && tmpDir.ok;

  return NextResponse.json(
    {
      status: healthy ? 'ok' : 'degraded',
      checks,
      runtime: {
        node: process.version,
        platform: `${os.platform()}-${os.arch()}`,
        e2e: config.isE2E,
      },
    },
    {
      status: healthy ? 200 : 503,
      // Health output may change at any time; never cache it.
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

// Convenience re-export so Phase 02+ can extend without changing the route path.
export { getConfig };
