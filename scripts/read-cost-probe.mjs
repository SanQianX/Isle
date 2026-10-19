/**
 * ISLE — read-path cost at scale.
 *
 * Measures the two read paths that a visitor feels, in isolation: the ranking
 * page's data load and the places list. Images are not generated here, because
 * the question is what the *queries* cost, not what sharp costs.
 *
 * The rows fetched are reported alongside the time, because a query that gets
 * slower usually gets slower by fetching more than it needs to.
 */
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const sandbox = path.join(os.tmpdir(), `isle-read-${process.pid}`);
const dbDir = path.join(sandbox, 'db');
await fs.mkdir(dbDir, { recursive: true });
const databaseUrl = `file:${path.join(dbDir, 'r.db').replace(/\\/g, '/')}`;

process.env.DATABASE_URL = databaseUrl;
process.env.MEDIA_ROOT = path.join(sandbox, 'media');
process.env.UPLOAD_TMP_DIR = path.join(sandbox, 'tmp');
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3084';
process.env.ISLE_E2E = '1';
process.env.NODE_ENV = 'production';

const prismaCli = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');
execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  stdio: 'pipe',
  env: process.env,
});

const { loadRankedPhotos } = await import('../src/server/services/photo-query.ts');
const { listPlaces } = await import('../src/server/services/place.ts');

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

const author = await prisma.visitor.create({
  data: { tokenHash: 'r-author', displayCode: 'ra001' },
});
const voters = [];
for (let v = 0; v < 20; v += 1) {
  voters.push(
    (
      await prisma.visitor.create({
        data: { tokenHash: `r-v${v}`, displayCode: `rv${String(v).padStart(3, '0')}` },
      })
    ).id,
  );
}

const big = await prisma.place.create({
  data: { name: '读岛', slug: 'read-island', normalizedName: '读岛', region: '测试' },
});
for (let i = 0; i < 40; i += 1) {
  await prisma.place.create({
    data: { name: `旁岛 ${i}`, slug: `side-${i}`, normalizedName: `旁岛 ${i}`, region: '测试' },
  });
}

const time = async (label, fn) => {
  const start = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`  ${label.padEnd(44)} ${ms.toFixed(1).padStart(8)} ms`);
  return value;
};

console.log('\n=== 读路径随照片数的增长 ===');
console.log('照片数   loadRankedPhotos（榜单页）      listPlaces（地点列表）');

for (const count of [25, 100, 250, 500]) {
  const existing = await prisma.photo.count({ where: { placeId: big.id } });
  for (let i = existing; i < count; i += 1) {
    await prisma.photo.create({
      data: {
        placeId: big.id,
        visitorId: author.id,
        title: `照片 ${i}`,
        originalKey: `original/aa/${String(i).padStart(64, '0')}.jpg`,
        originalFileName: 'p.jpg',
        originalMime: 'image/jpeg',
        originalByteLength: 1000,
        originalSha256: String(i).padStart(64, '0'),
        width: 1600,
        height: 900,
        status: 'READY',
        uploadIdempotencyKey: `r-${i}`,
      },
    });
  }
  const photos = await prisma.photo.findMany({ where: { placeId: big.id }, select: { id: true } });
  for (const photo of photos) {
    for (const voter of voters.slice(0, 3)) {
      await prisma.vote.upsert({
        where: { photoId_visitorId: { photoId: photo.id, visitorId: voter } },
        create: { photoId: photo.id, visitorId: voter, value: 1 },
        update: {},
      });
    }
  }

  await time(`${String(count).padEnd(8)}`, async () => loadRankedPhotos(big.id, author.id));
  await time('  (同批)', async () => listPlaces());
}

const votes = await prisma.vote.count();
const photos = await prisma.photo.count();
console.log(`\n  结束时：${photos} 张照片，${votes} 票`);

await prisma.$disconnect();
// Windows keeps the database file locked for a moment after the client
// disconnects, so a plain rm races it and fails with EBUSY.
for (let attempt = 0; attempt < 6; attempt += 1) {
  try {
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 800));
  }
}
