import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';

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
 * Verify the database is readable with the schema the app expects.
 * Reports the SQLite error code only — never the path or the SQL.
 */
async function probeDatabase(): Promise<StorageProbe> {
  try {
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    // A trivial read is enough: it proves the file opens, the connection works
    // and the schema is present without writing anything during a health check.
    await prisma.place.count();
    return { ok: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: typeof code === 'string' ? code : 'DB_UNAVAILABLE' };
  }
}

/**
 * The origin this request arrived on.
 *
 * Prefers the Host header, because that is the address a visitor used. Falls
 * back to the loopback address and the configured port for a request that
 * carries no host information.
 */
function originFor(request: Request): string {
  const host = request.headers.get('host');
  if (host !== null && host !== '') {
    const protocol = request.headers.get('x-forwarded-proto') ?? 'http';
    return `${protocol}://${host}`;
  }
  return `http://127.0.0.1:${process.env.PORT ?? '3000'}`;
}

/**
 * Verify that the built stylesheet is actually reachable.
 *
 * A release assembled without .next/static still answers every route with 200
 * and renders the site as unstyled HTML -- text overlapping, no layout. Nothing
 * in the logs says so. This check turns that into a visible failure.
 */
async function probeStaticAssets(baseUrl: string): Promise<StorageProbe> {
  try {
    const response = await fetch(`${baseUrl}/`, { redirect: 'manual' });
    const html = await response.text();
    const match = /\/_next\/static\/css\/([a-z0-9]+\.css)/.exec(html);
    if (match === null) {
      return { ok: false, reason: 'NO_CSS_REFERENCE' };
    }
    const css = await fetch(`${baseUrl}/_next/static/css/${match[1]}`);
    if (!css.ok) {
      return { ok: false, reason: `CSS_${css.status}` };
    }
    const body = await css.text();
    if (body.trim().length === 0) {
      return { ok: false, reason: 'CSS_EMPTY' };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: 'STATIC_UNREACHABLE' };
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
export async function GET(request: Request): Promise<NextResponse> {
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

  const [database, originalDir, previewRoot, tmpDir, staticAssets] = await Promise.all([
    probeDatabase(),
    probeWritableDir(config.originalDir),
    probeWritableDir(config.previewRoot),
    probeWritableDir(config.uploadTmpDir),
    // Probed against the origin the caller actually used. Reading PORT from the
    // environment was wrong: the process may listen on a port PORT does not
    // name -- a container behind a proxy, or a second instance on the same
    // host -- and the probe would then hit something else entirely and report
    // the deployment as broken when it was serving perfectly.
    probeStaticAssets(originFor(request)),
  ]);

  const checks = {
    config: { ok: true as const },
    database,
    originalDir,
    previewRoot,
    tmpDir,
    staticAssets,
  };

  const healthy = database.ok && originalDir.ok && previewRoot.ok && tmpDir.ok && staticAssets.ok;

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
