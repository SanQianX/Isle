import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { areWritesPaused, isLoopbackRequest, setWritesPaused } from '@/server/http/maintenance';

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
      writesPaused: areWritesPaused(),
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

/**
 * POST /api/health?pause-writes=1|0 — pause or resume writes.
 *
 * The operator tool the backup script uses. DEPLOY_RUNBOOK §8 backs up by
 * pausing writes while the database and the media directory are copied, and
 * this is the endpoint that makes that pause real.
 *
 * It was missing: the backup script has always called a URL that did not
 * exist, with a method the route did not implement, and swallowed the
 * failure. The backup therefore ran with writes still flowing, which is the
 * one thing it must not do -- a photograph uploaded during the window leaves
 * the snapshot with a row and no file.
 *
 * Reads keep working. The point is to make the data stable, not to take the
 * site down for the duration of the backup.
 *
 * Only the host itself may call it: the Node process listens on the loopback
 * interface and nginx always adds X-Forwarded-For, so a request from the
 * network fails the check.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (!isLoopbackRequest(request)) {
    return NextResponse.json(
      { error: { code: 'FORBIDDEN', message: '只有本机可以切换维护模式' } },
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  const raw = url.searchParams.get('pause-writes');

  if (raw !== '0' && raw !== '1') {
    return NextResponse.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'pause-writes 必须是 0 或 1',
        },
      },
      { status: 400 },
    );
  }

  const paused = raw === '1';
  const previous = setWritesPaused(paused);

  return NextResponse.json(
    {
      status: paused ? 'writes-paused' : 'writes-resumed',
      writesPaused: areWritesPaused(),
      // The state before the change, so a caller can tell whether it was the
      // one that actually paused the site.
      previouslyPaused: previous,
    },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
