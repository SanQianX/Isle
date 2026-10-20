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
 *
 * `--adopt` is the other half of that sentence: it re-registers an orphaned
 * original as a real photograph. The bytes are already on disk and their
 * address *is* their SHA-256, so the row can be rebuilt exactly -- the hash
 * is recomputed and checked against the path it was found at, the dimensions
 * are read from the file, and the two previews are linked if they are there.
 * That is the recovery for "the database was lost but the photographs
 * survived", which is otherwise unrecoverable from the tool's point of view.
 */
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createReadStream } from 'node:fs';
import { PrismaClient } from '@prisma/client';

function parseArgs(argv) {
  const args = { prune: false, adopt: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--prune') args.prune = true;
    if (argv[i] === '--adopt') args.adopt = true;
    if (argv[i] === '--media-root') args.mediaRoot = argv[i + 1];
    if (argv[i] === '--place') args.place = argv[i + 1];
    if (argv[i] === '--title') args.title = argv[i + 1];
    if (argv[i] === '--dry-run') {
      args.prune = false;
      args.adopt = false;
    }
  }
  return args;
}

const MIME_BY_EXTENSION = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
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

    console.log(
      JSON.stringify(
        {
          photos: photos.length,
          filesOnDisk: onDisk.length,
          missingFile,
          previewless,
          orphanFile: orphanFile.slice(0, 50),
          orphanFileCount: orphanFile.length,
        },
        null,
        2,
      ),
    );

    if (args.prune && orphanFile.length > 0) {
      for (const file of orphanFile) {
        await fs.rm(path.join(mediaRoot, ...file.split('/')), { force: true });
      }
      console.log(`pruned ${orphanFile.length} orphan file(s)`);
    } else if (orphanFile.length > 0) {
      console.log('dry run: pass --prune to remove the orphan files listed above');
    }

    // --adopt: rebuild the rows for originals that survived a lost database.
    if (args.adopt) {
      const adopted = await adoptOrphans(prisma, mediaRoot, orphanFile, args);
      console.log(`adopted ${adopted.length} orphan original(s) as photographs`);
    }

    // A missing original is a data-loss condition, never something to fix by
    // deleting the row.
    if (missingFile.length > 0) {
      process.exitCode = 2;
      console.error(
        `${missingFile.length} photo(s) reference a missing original; restore from backup`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Rebuild the Photo rows for originals that outlived their database.
 *
 * The original's address is its SHA-256, so the row can be reconstructed
 * exactly rather than guessed: the hash is recomputed from the bytes and
 * checked against the path the file was found at. A file whose contents do
 * not match its own address is refused -- that is corruption, not an orphan,
 * and adopting it would publish a photograph whose recorded hash is a lie.
 */
async function adoptOrphans(prisma, mediaRoot, orphanFile, args) {
  const originals = orphanFile.filter((file) => file.startsWith('original/'));
  if (originals.length === 0) return [];

  const sharp = (await import('sharp')).default;

  const place = args.place
    ? ((await prisma.place.findFirst({
        where: { OR: [{ id: args.place }, { slug: args.place }] },
      })) ?? null)
    : ((await prisma.place.findFirst({ orderBy: { createdAt: 'asc' } })) ?? null);
  if (place === null) {
    console.error('--adopt needs a place: pass --place <id|slug>');
    process.exitCode = 1;
    return [];
  }

  // A photo needs an uploader. The place's own contributor is the closest
  // thing to the truth available when the database is gone.
  const visitor =
    (await prisma.visitor.findFirst({ orderBy: { createdAt: 'asc' } })) ??
    (await prisma.visitor.create({
      data: {
        tokenHash: `adopted-${randomBytes(12).toString('hex')}`,
        displayCode: 'ad01',
      },
    }));

  const adopted = [];
  for (const file of originals) {
    const relative = file.replace(/^original\//, '');
    const absolute = path.join(mediaRoot, 'original', relative);
    const digest = await sha256File(absolute);

    // The path is the hash: original/<first two>/<the rest>.<ext>
    const expected = `original/${digest.slice(0, 2)}/${digest.slice(2)}`;
    const actual = file.replace(/\.[^.]+$/, '');
    if (expected !== actual) {
      console.error(`refusing to adopt ${file}: its contents hash to ${expected}`);
      continue;
    }

    const extension = path.extname(relative).toLowerCase();
    const mime = MIME_BY_EXTENSION[extension];
    if (mime === undefined) {
      console.error(`refusing to adopt ${file}: unsupported extension ${extension}`);
      continue;
    }

    const metadata = await sharp(absolute).metadata();
    const stat = await fs.stat(absolute);

    // The previews are addressed the same way; link them only if they exist.
    const previewKey = (size) => `preview/${size}/${digest.slice(0, 2)}/${digest.slice(2)}.webp`;
    const has = async (key) => {
      try {
        await fs.access(path.join(mediaRoot, key));
        return true;
      } catch {
        return false;
      }
    };
    const preview400 = await has(previewKey(400));
    const preview1200 = await has(previewKey(1200));
    if (!preview400 || !preview1200) {
      console.error(`refusing to adopt ${file}: its previews are missing`);
      continue;
    }

    const title = args.title ?? path.basename(relative, extension);
    const created = await prisma.photo.create({
      data: {
        placeId: place.id,
        visitorId: visitor.id,
        title,
        description: '从孤儿文件恢复',
        status: 'READY',
        originalKey: file,
        originalSha256: digest,
        originalByteLength: stat.size,
        originalMime: mime,
        originalFileName: path.basename(relative),
        width: metadata.width ?? 0,
        height: metadata.height ?? 0,
        preview400Key: previewKey(400),
        preview1200Key: previewKey(1200),
      },
    });
    adopted.push(created.id);
  }
  return adopted;
}

main().catch((error) => {
  console.error('[reconcile] failed:', error);
  process.exit(1);
});
