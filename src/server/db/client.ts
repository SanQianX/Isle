import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { getConfig } from '@/lib/config';

/**
 * Prisma singleton with SQLite configured for a single-node deployment.
 *
 * Three pragmas matter (DATA_API_STORAGE §1):
 *
 *   journal_mode=WAL    persistent, stored in the database file — readers stop
 *                       blocking the single writer.
 *   busy_timeout>=5000  per connection — a concurrent writer waits instead of
 *                       failing with SQLITE_BUSY.
 *   foreign_keys=ON     per connection — SQLite disables FK enforcement by
 *                       default, which would silently ignore the cascades the
 *                       schema declares.
 *
 * The last two are *per connection*, not persisted. Prisma has no per-connection
 * PRAGMA hook, so they are only reliable if the pool has exactly one connection.
 * We therefore force `connection_limit=1`, which also makes write serialisation
 * explicit instead of racy (ADR-014). At the scale this app targets — a handful
 * of friends — a single connection is not a throughput concern.
 */

function withConnectionLimit(databaseUrl: string): string {
  const separator = databaseUrl.includes('?') ? '&' : '?';
  return `${databaseUrl}${separator}connection_limit=1`;
}

function buildClient(): PrismaClient {
  const config = getConfig();

  // SQLite creates the file lazily, but the parent directory must exist.
  fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });

  const client = new PrismaClient({
    datasources: { db: { url: withConnectionLimit(config.databaseUrl) } },
    log: process.env.ISLE_DEBUG_SQL === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

  return client;
}

type ClientGlobal = typeof globalThis & {
  __islePrisma?: PrismaClient;
  __islePrismaReady?: Promise<void>;
};

/**
 * Apply the per-connection pragmas. Runs exactly once per process; with
 * connection_limit=1 this configures the only connection the client will ever
 * open.
 */
async function applyPragmas(client: PrismaClient): Promise<void> {
  // SQLite PRAGMA statements return their resulting value, so they must go
  // through $queryRawUnsafe — $executeRawUnsafe rejects a statement that
  // produces rows.
  //
  // WAL is persistent but is cheap to assert, and this also fails loudly if the
  // database file lives on a filesystem that cannot do WAL (some network mounts).
  await client.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  await client.$queryRawUnsafe('PRAGMA busy_timeout = 5000;');
  await client.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
  await client.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
}

/**
 * Returns a ready-to-use client. Awaiting this guarantees the pragmas have been
 * applied, so the first request cannot race ahead of foreign-key enforcement.
 */
export async function getPrisma(): Promise<PrismaClient> {
  const globalRef = globalThis as ClientGlobal;
  globalRef.__islePrisma ??= buildClient();
  globalRef.__islePrismaReady ??= applyPragmas(globalRef.__islePrisma);
  await globalRef.__islePrismaReady;
  return globalRef.__islePrisma;
}

/** Read the live pragma values. Used by the integration test that proves they took. */
export async function readPragmas(): Promise<{
  journalMode: string;
  busyTimeoutMs: number;
  foreignKeys: number;
}> {
  const client = await getPrisma();
  // SQLite integer columns come back from Prisma as BigInt.
  const [journal] =
    await client.$queryRawUnsafe<Array<{ journal_mode: string }>>('PRAGMA journal_mode;');
  const [busy] =
    await client.$queryRawUnsafe<Array<{ timeout: bigint | number }>>('PRAGMA busy_timeout;');
  const [fk] =
    await client.$queryRawUnsafe<Array<{ foreign_keys: bigint | number }>>('PRAGMA foreign_keys;');
  return {
    journalMode: journal?.journal_mode ?? 'unknown',
    busyTimeoutMs: Number(busy?.timeout ?? -1),
    foreignKeys: Number(fk?.foreign_keys ?? -1),
  };
}

/** Pool settings for interactive transactions; retries cover a contended write. */
export const TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 15_000,
} as const;

/**
 * Drop the memoised client and close it.
 *
 * Test-only: each integration case builds its own SQLite file, and the client is
 * cached on globalThis so a single process can only hold one connection. Without
 * this reset, case 2 would silently query case 1's database.
 */
export async function resetPrismaForTests(): Promise<void> {
  const globalRef = globalThis as ClientGlobal;
  const existing = globalRef.__islePrisma;
  globalRef.__islePrisma = undefined;
  globalRef.__islePrismaReady = undefined;
  if (existing !== undefined) {
    await existing.$disconnect().catch(() => undefined);
  }
}
