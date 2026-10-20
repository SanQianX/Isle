import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Integration-test harness.
 *
 * Every case gets its own temporary directory and its own SQLite file, and the
 * suite refuses to run if that would land anywhere near a production path
 * (TEST_STRATEGY §2, MASTER_PLAN §D). Nothing here touches the development or
 * production database.
 */

const FORBIDDEN_PREFIXES = [
  path.resolve('/var/lib/isle'),
  path.resolve('/opt/isle'),
  path.resolve('/srv/isle'),
  path.resolve(process.cwd(), 'var'),
];

export type TestContext = {
  root: string;
  databaseFile: string;
  mediaRoot: string;
  uploadTmpDir: string;
  client: PrismaClient;
  /** Point process.env at this context so app code under test sees it. */
  applyEnv: () => void;
  cleanup: () => Promise<void>;
};

function assertSafe(target: string): string {
  const resolved = path.resolve(target);
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (resolved.startsWith(prefix)) {
      throw new Error(`Refusing to create a test environment at a production path: ${resolved}`);
    }
  }
  return resolved;
}

let counter = 0;

/**
 * Build an isolated environment. `applyEnv` must be called before importing any
 * module that reads configuration, because `src/lib/config` memoises on first use.
 */
export function createTestContext(label = 'isle-it'): TestContext {
  counter += 1;
  // The random component matters. Process ids are recycled, and the counter
  // restarts with every process, so without it a new run can land in the
  // directory a previous run left behind -- and inherit its database, which
  // shows up later as a unique-constraint failure on data nobody wrote in
  // this run.
  const root = assertSafe(
    path.join(os.tmpdir(), `${label}-${process.pid}-${randomBytes(4).toString('hex')}-${counter}`),
  );
  const dbDir = path.join(root, 'db');
  const mediaRoot = path.join(root, 'media');
  const uploadTmpDir = path.join(root, 'tmp');

  for (const dir of [dbDir, mediaRoot, uploadTmpDir]) fs.mkdirSync(dir, { recursive: true });

  const databaseFile = path.join(dbDir, 'test.db');
  const client = new PrismaClient({
    datasources: { db: { url: `file:${databaseFile.replace(/\\/g, '/')}?connection_limit=1` } },
  });

  const previousEnv = { ...process.env };

  return {
    root,
    databaseFile,
    mediaRoot,
    uploadTmpDir,
    client,
    applyEnv: () => {
      // Next declares NODE_ENV as a readonly literal on ProcessEnv, so the
      // whole env bag is widened before assignment rather than cast per key.
      const env = process.env as Record<string, string | undefined>;
      env['NODE_ENV'] = 'test';
      env['ISLE_E2E'] = '1';
      process.env.DATABASE_URL = `file:${databaseFile.replace(/\\/g, '/')}`;
      process.env.MEDIA_ROOT = mediaRoot;
      process.env.UPLOAD_TMP_DIR = uploadTmpDir;
      process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3099';
      process.env.NEXT_TELEMETRY_DISABLED = '1';
    },
    cleanup: async () => {
      await client.$disconnect().catch(() => undefined);
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnv)) delete process.env[key];
      }
      Object.assign(process.env, previousEnv);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Apply the migration set to a fresh SQLite file.
 *
 * Runs the real committed migration.sql files, statement by statement, so the
 * test exercises the shipped migrations rather than a hand-maintained copy that
 * could drift from them.
 */
export async function migrateTestDatabase(client: PrismaClient): Promise<void> {
  const migrationsDir = path.join(process.cwd(), 'prisma', 'migrations');
  const dirs = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const dir of dirs) {
    const sql = fs.readFileSync(path.join(migrationsDir, dir, 'migration.sql'), 'utf8');
    const body = sql
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('--'))
      .join('\n');

    // Prisma's SQLite engine rejects a multi-statement execute, so split on the
    // statement terminator. The committed migrations contain no semicolons
    // inside string literals, which makes this safe.
    for (const statement of body.split(';')) {
      const trimmed = statement.trim();
      if (trimmed === '') continue;
      await client.$executeRawUnsafe(trimmed);
    }
  }
}

/** A syntactically valid visitor token; never a real identity. */
export function makeVisitorToken(): string {
  return randomBytes(32).toString('base64url');
}

export function visitorCookieHeader(name: string, token: string): string {
  return `${name}=${encodeURIComponent(token)}`;
}
