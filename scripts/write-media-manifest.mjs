#!/usr/bin/env node
/**
 * Write the manifest that ties database rows to the bytes on disk.
 *
 * Every backup carries this. A restore that cannot reproduce these hashes has
 * restored something broken, and the operator needs to know at restore time
 * rather than a week later when someone opens a photo and finds a 0-byte file.
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PrismaClient } from '@prisma/client';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i]?.replace(/^--/, '')] = argv[i + 1];
  }
  return args;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const args = parseArgs(process.argv.slice(2));
const databaseFile = args.database;
const mediaRoot = args['media-root'];
const out = args.out;

if (!databaseFile || !mediaRoot || !out) {
  console.error('usage: write-media-manifest.mjs --database <db> --media-root <dir> --out <file>');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: `file:${databaseFile}` } } });

try {
  const photos = await prisma.photo.findMany({
    select: { id: true, originalKey: true, originalSha256: true, originalByteLength: true, status: true },
  });

  const entries = [];
  const problems = [];

  for (const photo of photos) {
    const relative = photo.originalKey.replace(/^original\//, '');
    const file = path.join(mediaRoot, 'original', relative);

    let actual = null;
    try {
      actual = { sha256: await sha256File(file), bytes: (await fs.stat(file)).size };
    } catch (error) {
      problems.push({ photoId: photo.id, reason: 'missing', detail: error.code ?? String(error) });
      continue;
    }

    // The row is the source of truth; the disk is what we are checking.
    const hashOk = actual.sha256 === photo.originalSha256;
    const sizeOk = actual.bytes === photo.originalByteLength;

    if (!hashOk) {
      problems.push({
        photoId: photo.id,
        reason: 'hash-mismatch',
        expected: photo.originalSha256,
        actual: actual.sha256,
      });
    }
    if (!sizeOk) {
      problems.push({
        photoId: photo.id,
        reason: 'size-mismatch',
        expected: photo.originalByteLength,
        actual: actual.bytes,
      });
    }

    // Only clean rows count as verified, so `verifiedCount` never overstates
    // what the backup actually proved.
    if (!hashOk || !sizeOk) continue;

    entries.push({
      photoId: photo.id,
      key: photo.originalKey,
      status: photo.status,
      bytes: actual.bytes,
      sha256: actual.sha256,
    });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    database: path.basename(databaseFile),
    photoCount: photos.length,
    verifiedCount: entries.length,
    problems,
    entries,
  };

  await fs.writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(
    `[manifest] ${entries.length}/${photos.length} originals verified, ${problems.length} problem(s)`,
  );
  if (problems.length > 0) {
    // A problem is worth failing the backup over: shipping a snapshot that is
    // already inconsistent is how corruption becomes permanent.
    process.exit(2);
  }
} finally {
  await prisma.$disconnect();
}
