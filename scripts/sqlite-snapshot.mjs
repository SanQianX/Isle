#!/usr/bin/env node
/**
 * Take a consistent snapshot of a SQLite database, without the sqlite3 CLI.
 *
 * `sqlite3 isle.db ".backup 'dest'"` is the canonical way to copy a live
 * database, but sqlite3 is an optional package on most hosts and the backup
 * then has to fall back to stopping the service -- which turns a two-minute
 * window into a visible outage.
 *
 * SQLite's `VACUUM INTO 'dest'` does the same thing: it reads the database
 * under a read transaction and writes a complete, consistent copy to a new
 * file, while other connections carry on writing. Node is guaranteed to be on
 * the host -- the application itself runs on it -- so this path has no
 * dependency that the deployment does not already have.
 *
 * The destination must not exist; VACUUM INTO refuses to overwrite.
 *
 * Usage:
 *   scripts/sqlite-snapshot.mjs --source <isle.db> --dest <copy.db>
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i]?.replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

/** Escape a path for use as a single-quoted SQL string literal. */
function sqlLiteral(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

const args = parseArgs(process.argv.slice(2));
const source = args.source;
const dest = args.dest;

if (!source || !dest) {
  console.error('usage: sqlite-snapshot.mjs --source <isle.db> --dest <copy.db>');
  process.exit(1);
}

if (!existsSync(source)) {
  console.error(`[snapshot] source database not found: ${source}`);
  process.exit(1);
}

if (existsSync(dest)) {
  // VACUUM INTO refuses to overwrite, and silently replacing the destination
  // would mean a failed run leaves a half-written "backup" that later
  // verifies as a real one.
  console.error(`[snapshot] destination already exists: ${dest}`);
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: { db: { url: `file:${source.replace(/\\/g, '/')}` } },
});

try {
  // VACUUM cannot run inside a transaction, and Prisma's client-level
  // $executeRawUnsafe runs in autocommit mode.
  await prisma.$executeRawUnsafe(`VACUUM INTO ${sqlLiteral(path.resolve(dest))}`);
  console.log(`[snapshot] wrote ${dest}`);
} catch (error) {
  console.error(`[snapshot] failed: ${error?.message ?? String(error)}`);
  process.exit(1);
} finally {
  await prisma.$disconnect().catch(() => undefined);
}
