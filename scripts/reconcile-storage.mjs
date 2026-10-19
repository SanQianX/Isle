#!/usr/bin/env node
/**
 * ISLE — storage reconciler.
 *
 * Finds three kinds of disagreement between the database and the media tree:
 *
 *   orphan-file   a file on disk no Photo row references
 *   missing-file  a Photo row whose original is absent
 *   previewless   a READY photo missing one of its two previews
 *
 * Deleting anything is opt-in. The default is a report, because a media
 * directory that disagrees with the database is more often a half-finished
 * restore than an orphan worth reclaiming, and originals are archived
 * permanently (DEPLOY_RUNBOOK §9).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PrismaClient } from '@prisma/client';

function parseArgs(argv) {
  const args = { prune: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--prune') args.prune = true;
    if (argv[i] === '--media-root') args.mediaRoot = argv[i + 1];
    if (argv[i] === '--dry-run') args.prune = false;
  }
  return args;
}

async function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mediaRoot = args.mediaRoot ?? process.env.MEDIA_ROOT;
  const databaseUrl = process.env.DATABASE_URL;

  if (!mediaRoot || !databaseUrl) {
    console.error('MEDIA_ROOT and DATABASE_URL are required');
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const photos = await prisma.photo.findMany({
      select: {
        id: true,
        status: true,
        originalKey: true,
        preview400Key: true,
        preview1200Key: true,
      },
    });

    const referenced = new Set();
    const missingFile = [];
    const previewless = [];

    for (const photo of photos) {
      const relative = photo.originalKey.replace(/^original\//, '');
      referenced.add(`original/${relative}`);

      try {
        await fs.access(path.join(mediaRoot, 'original', relative));
      } catch {
        missingFile.push(photo.id);
      }

      if (photo.status === 'READY') {
        if (photo.preview400Key === null || photo.preview1200Key === null) {
          previewless.push(photo.id);
        } else {
          referenced.add(photo.preview400Key.replace(/^preview\//, '').replace(/^/, 'preview/'));
          referenced.add(photo.preview1200Key.replace(/^preview\//, '').replace(/^/, 'preview/'));
        }
      }
    }

    const onDisk = [
      ...(await walk(path.join(mediaRoot, 'original'))).map((f) => `original/${f}`),
      ...(await walk(path.join(mediaRoot, 'preview'))).map((f) => `preview/${f}`),
    ];
    const orphanFile = onDisk.filter((file) => !referenced.has(file));

    console.log(JSON.stringify({
      photos: photos.length,
      filesOnDisk: onDisk.length,
      missingFile,
      previewless,
      orphanFile: orphanFile.slice(0, 50),
      orphanFileCount: orphanFile.length,
    }, null, 2));

    if (args.prune && orphanFile.length > 0) {
      for (const file of orphanFile) {
        await fs.rm(path.join(mediaRoot, ...file.split('/')), { force: true });
      }
      console.log(`pruned ${orphanFile.length} orphan file(s)`);
    } else if (orphanFile.length > 0) {
      console.log('dry run: pass --prune to remove the orphan files listed above');
    }

    // A missing original is a data-loss condition, never something to fix by
    // deleting the row.
    if (missingFile.length > 0) {
      process.exitCode = 2;
      console.error(`${missingFile.length} photo(s) reference a missing original; restore from backup`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[reconcile] failed:', error);
  process.exit(1);
});
