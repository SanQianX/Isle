#!/usr/bin/env node
/**
 * ISLE — moderation CLI (hide / show / purge).
 *
 * V1 deliberately ships no admin UI (MASTER_PLAN V1 scope). Hiding a photo for
 * infringement, illegality or a privacy request is an operational action, and
 * it has to remain possible without building a back door into the site.
 *
 * Every action is audited. `hide` takes effect immediately: the photo leaves
 * the leaderboard and its original, download and preview routes return 404.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PrismaClient } from '@prisma/client';

const AUDIT_LOG = process.env.MODERATION_LOG ?? '/var/lib/isle/tmp/moderation.log';

async function audit(entry) {
  await fs.mkdir(path.dirname(AUDIT_LOG), { recursive: true });
  await fs.appendFile(AUDIT_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  console.log(`[audit] ${AUDIT_LOG}`);
}

async function main() {
  const [action, photoId, ...rest] = process.argv.slice(2);
  if (!action || !photoId) {
    console.error('usage: moderate-photo.mjs <hide|show|purge> <photoId> [--reason "..."]');
    process.exit(1);
  }

  const reasonIndex = rest.indexOf('--reason');
  const reason = reasonIndex === -1 ? undefined : rest[reasonIndex + 1];

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  try {
    const photo = await prisma.photo.findUnique({ where: { id: photoId } });
    if (photo === null) {
      console.error(`no such photo: ${photoId}`);
      process.exit(1);
    }

    if (action === 'hide') {
      await prisma.photo.update({ where: { id: photoId }, data: { status: 'HIDDEN' } });
      await audit({ action: 'hide', photoId, reason: reason ?? null, by: process.env.SUDO_USER ?? 'unknown' });
      console.log(`hidden ${photoId}`);
      return;
    }

    if (action === 'show') {
      await prisma.photo.update({ where: { id: photoId }, data: { status: 'READY' } });
      await audit({ action: 'show', photoId, reason: reason ?? null, by: process.env.SUDO_USER ?? 'unknown' });
      console.log(`restored ${photoId}`);
      return;
    }

    if (action === 'purge') {
      // Originals are content-addressed, so two Photo rows can legitimately point
      // at one file. Deleting it while a sibling still references it would break
      // someone else's photograph (ADR-015).
      const siblings = await prisma.photo.findMany({
        where: { originalKey: photo.originalKey, id: { not: photoId } },
        select: { id: true },
      });

      if (siblings.length > 0) {
        console.error(
          `refusing to purge: ${siblings.length} other photo(s) share this original ` +
            `(${siblings.map((s) => s.id).join(', ')}). Hide it instead, or purge those too.`,
        );
        process.exit(2);
      }

      await prisma.photo.delete({ where: { id: photoId } });
      await audit({ action: 'purge', photoId, originalKey: photo.originalKey, by: process.env.SUDO_USER ?? 'unknown' });
      console.log(`purged ${photoId}; the file itself must be removed by scripts/reconcile-storage.mjs`);
      return;
    }

    console.error(`unknown action: ${action}`);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('[moderate] failed:', error);
  process.exit(1);
});
