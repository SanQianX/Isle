/**
 * ISLE — scaling probe.
 *
 * The stress baseline seeds a realistic dataset and finds nothing, because a
 * realistic dataset for five to fifteen friends is small. This probe answers a
 * different question: what happens as the data grows, and which query grows
 * with it?
 *
 * One place accumulates photos in steps, and the same endpoints are timed at
 * each step. A response time that tracks the photo count linearly is a query
 * that has to be fixed before a real trip accumulates a few hundred shots.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';

const ORIGIN = process.env.SCALE_ORIGIN ?? 'http://127.0.0.1:3082';
const STEPS = (process.env.SCALE_STEPS ?? '25,100,250,500').split(',').map(Number);
const PLACES = Number(process.env.SCALE_PLACES ?? 40);

const repoRoot = process.cwd();
const sandbox = path.join(os.tmpdir(), `isle-scale-${process.pid}`);
const dbDir = path.join(sandbox, 'db');
const mediaRoot = path.join(sandbox, 'media');
const tmpDir = path.join(sandbox, 'tmp');
const databaseUrl = `file:${path.join(dbDir, 'scale.db').replace(/\\/g, '/')}`;

for (const dir of [dbDir, mediaRoot, tmpDir]) await fs.mkdir(dir, { recursive: true });

process.env.DATABASE_URL = databaseUrl;
process.env.MEDIA_ROOT = mediaRoot;
process.env.UPLOAD_TMP_DIR = tmpDir;
process.env.PUBLIC_BASE_URL = ORIGIN;
process.env.ISLE_E2E = '1';
process.env.NODE_ENV = 'production';

const prismaCli = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');
execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { stdio: 'pipe', env: process.env });

const { ingestPhotoBytes } = await import('../src/server/services/photo.ts');
const { createPlace } = await import('../src/server/services/place.ts');
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

const fixture = new Uint8Array(
  await fs.readFile(path.join(repoRoot, 'tests', 'fixtures', 'landscape.jpg')),
);
const author = await prisma.visitor.create({
  data: { tokenHash: `scale-author-${Date.now()}`, displayCode: 'sc001' },
});

// The place under test grows; the others stay small so their effect on the
// list endpoint is visible but not dominant.
const big = await createPlace({
  name: `规模岛 ${Date.now()}`,
  region: '测试地区',
  description: '',
});
for (let i = 0; i < PLACES; i += 1) {
  await createPlace({
    name: `陪跑岛 ${i}-${Date.now()}`,
    region: '测试地区',
    description: '',
  });
}

const { spawn } = await import('node:child_process');
const server = spawn(process.execPath, [path.join(repoRoot, '.next', 'standalone', 'server.js')], {
  cwd: path.join(repoRoot, '.next', 'standalone'),
  env: { ...process.env, PORT: '3082', HOSTNAME: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => (serverLog += c));
server.stderr.on('data', (c) => (serverLog += c));

for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    if ((await fetch(`${ORIGIN}/api/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}

const time = async (url) => {
  const start = process.hrtime.bigint();
  const response = await fetch(url);
  const body = await response.text();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  return { ms, bytes: Buffer.byteLength(body), status: response.status };
};

console.log(`\n=== 规模曲线：单个地点的照片数增长，${PLACES} 个其他地点 ===`);
console.log('照片数   榜单API      地点页      地点列表    榜单载荷');

let added = 0;
for (const target of STEPS) {
  while (added < target) {
    await ingestPhotoBytes({
      placeId: big.id,
      visitorId: author.id,
      bytes: fixture,
      fileName: `p${added}.jpg`,
      mime: 'image/jpeg',
      title: `照片 ${added}`,
      description: '',
      idempotencyKey: `scale-${big.id}-${added}`,
    });
    added += 1;
  }

  const list = await time(`${ORIGIN}/api/places/${big.id}/photos?limit=40`);
  const placePage = await time(`${ORIGIN}/places/${big.slug}`);
  const placesPage = await time(`${ORIGIN}/places`);

  console.log(
    [
      String(added).padEnd(8),
      `${list.ms.toFixed(0).padStart(6)} ms`.padEnd(14),
      `${placePage.ms.toFixed(0).padStart(6)} ms`.padEnd(12),
      `${placesPage.ms.toFixed(0).padStart(6)} ms`.padEnd(12),
      `${(list.bytes / 1024).toFixed(0)} KB`,
    ].join(' '),
  );
}

// The ranking page is the one that renders every photo, so its cost is the
// one a visitor actually feels.
console.log('\n=== 排名页（渲染全部照片）===');
for (const target of STEPS) {
  const place = await time(`${ORIGIN}/places/${big.slug}/ranking`);
  console.log(`  ${String(target).padEnd(6)} 张 → ${place.ms.toFixed(0).padStart(6)} ms, ${(place.bytes / 1024).toFixed(0)} KB`);
}

const errors = serverLog.split('\n').filter((l) => /⨯|unhandled/.test(l)).slice(0, 5);
if (errors.length > 0) {
  console.log('\n服务端错误：');
  for (const e of errors) console.log(`  ${e}`);
}

await prisma.$disconnect();
server.kill('SIGTERM');
await new Promise((r) => {
  server.once('exit', r);
  setTimeout(r, 5000);
});
for (let attempt = 0; attempt < 6; attempt += 1) {
  try {
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 800));
  }
}
