/**
 * ISLE — stress baseline.
 *
 * Loads a realistic dataset (many places, many photos per place) and then
 * measures what happens under concurrency. The point is to find where the
 * implementation stops being merely correct and starts being slow.
 *
 * Everything runs against the real server, a real SQLite file and real image
 * files. Nothing is mocked.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';

const ORIGIN = process.env.STRESS_ORIGIN ?? 'http://127.0.0.1:3081';
const PLACES = Number(process.env.STRESS_PLACES ?? 12);
const PHOTOS_PER_PLACE = Number(process.env.STRESS_PHOTOS ?? 15);
const VOTERS = Number(process.env.STRESS_VOTERS ?? 20);

const repoRoot = process.cwd();
const sandbox = path.join(os.tmpdir(), `isle-stress-${process.pid}`);
const dbDir = path.join(sandbox, 'db');
const mediaRoot = path.join(sandbox, 'media');
const tmpDir = path.join(sandbox, 'tmp');
const databaseUrl = `file:${path.join(dbDir, 'stress.db').replace(/\\/g, '/')}`;

for (const dir of [dbDir, mediaRoot, tmpDir]) await fs.mkdir(dir, { recursive: true });

process.env.DATABASE_URL = databaseUrl;
process.env.MEDIA_ROOT = mediaRoot;
process.env.UPLOAD_TMP_DIR = tmpDir;
process.env.PUBLIC_BASE_URL = ORIGIN;
process.env.ISLE_E2E = '1';
process.env.NODE_ENV = 'production';

console.log(`[stress] 沙箱 ${sandbox}`);

// --- Prepare the data ---------------------------------------------------------
// Run the Prisma CLI through its JavaScript entry point rather than through
// `npx`. On Windows `npx` is a .cmd shim, which spawnSync cannot execute
// without a shell -- and a shell would re-split the arguments, which breaks on
// this repository's path (it contains a space).
const prismaCli = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');
execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  stdio: 'pipe',
  env: process.env,
});

const { ingestPhotoBytes } = await import('../src/server/services/photo.ts');
const { seedDefaultPlace, createPlace } = await import('../src/server/services/place.ts');
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

const fixture = new Uint8Array(
  await fs.readFile(path.join(repoRoot, 'tests', 'fixtures', 'landscape.jpg')),
);
const portrait = new Uint8Array(
  await fs.readFile(path.join(repoRoot, 'tests', 'fixtures', 'portrait.jpg')),
);

const author = await prisma.visitor.create({
  data: { tokenHash: `stress-author-${Date.now()}`, displayCode: 'st001' },
});

let seeded = 0;
const placeIds = [];
await seedDefaultPlace();
placeIds.push((await prisma.place.findFirst({ where: { slug: 'guishan-island' } })).id);

for (let p = 0; p < PLACES; p += 1) {
  const place = await createPlace({
    name: `压测岛 ${p}-${Date.now()}`,
    region: '广东 · 珠海 · 万山群岛',
    description: '压测用地点',
  });
  placeIds.push(place.id);

  for (let i = 0; i < PHOTOS_PER_PLACE; i += 1) {
    await ingestPhotoBytes({
      placeId: place.id,
      visitorId: author.id,
      bytes: i % 2 === 0 ? fixture : portrait,
      fileName: `photo-${i}.jpg`,
      mime: 'image/jpeg',
      title: `照片 ${i}`,
      description: '',
      idempotencyKey: `stress-${place.id}-${i}`,
    });
    seeded += 1;
  }
}

const voterIds = [];
for (let v = 0; v < VOTERS; v += 1) {
  const voter = await prisma.visitor.create({
    data: {
      tokenHash: `stress-voter-${v}-${Date.now()}`,
      displayCode: `sv${String(v).padStart(3, '0')}`,
    },
  });
  voterIds.push(voter.id);
}

const photoRows = await prisma.photo.findMany({ select: { id: true } });
console.log(`[stress] ${placeIds.length} 个地点、${seeded} 张照片、${VOTERS} 个访客已就绪`);

// --- Start the server ---------------------------------------------------------
// Next's standalone output deliberately omits .next/static, and the health
// check now refuses to call a deployment healthy without it -- which is the
// point. Copy it in, exactly as scripts/start-test-server.mjs does.
await fs.mkdir(path.join(repoRoot, '.next', 'standalone', '.next'), { recursive: true });
await fs.cp(
  path.join(repoRoot, '.next', 'static'),
  path.join(repoRoot, '.next', 'standalone', '.next', 'static'),
  {
    recursive: true,
  },
);

const { spawn } = await import('node:child_process');
const server = spawn(process.execPath, [path.join(repoRoot, '.next', 'standalone', 'server.js')], {
  cwd: path.join(repoRoot, '.next', 'standalone'),
  env: { ...process.env, PORT: '3081', HOSTNAME: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));

const waitForHealth = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}/api/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the server never became healthy:\n${serverLog}`);
};
await waitForHealth();

// --- Measure ------------------------------------------------------------------
const timed = async (label, fn) => {
  const start = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`  ${label.padEnd(42)} ${ms.toFixed(0).padStart(6)} ms`);
  return { ms, result };
};

console.log('\n=== 读路径 ===');
const targetPlace = placeIds[0];

await timed('GET /（首页）', async () => {
  const r = await fetch(`${ORIGIN}/`);
  return r.status;
});
await timed('GET /places（12 个地点）', async () => {
  const r = await fetch(`${ORIGIN}/places`);
  return r.status;
});
await timed('GET /places/:id/photos（15 张带票）', async () => {
  const r = await fetch(`${ORIGIN}/api/places/${targetPlace}/photos`);
  return r.status;
});
await timed('GET /places/:id/photos?limit=40', async () => {
  const r = await fetch(`${ORIGIN}/api/places/${targetPlace}/photos?limit=40`);
  return r.status;
});
await timed('GET /places/:id（详情）', async () => {
  const r = await fetch(`${ORIGIN}/api/places/${targetPlace}`);
  return r.status;
});
await timed('GET /api/places（列表）', async () => {
  const r = await fetch(`${ORIGIN}/api/places`);
  return r.status;
});

console.log('\n=== 写路径 ===');
const photoId = photoRows[0].id;
const voterCookie = (index) => `isle_visitor=stress-voter-${index}-${Date.now()}`;

await timed('20 个访客并发投票（不同照片）', async () => {
  const votes = voterIds.slice(0, 20).map((_, index) =>
    fetch(`${ORIGIN}/api/photos/${photoRows[index % photoRows.length].id}/vote`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: voterCookie(index) },
      body: JSON.stringify({ value: 1 }),
    }),
  );
  const responses = await Promise.all(votes);
  return responses.map((r) => r.status);
});

await timed('50 个访客并发投票（同一张照片）', async () => {
  const votes = Array.from({ length: 50 }, (_, index) =>
    fetch(`${ORIGIN}/api/photos/${photoId}/vote`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: voterCookie(index) },
      body: JSON.stringify({ value: index % 3 === 0 ? -1 : 1 }),
    }),
  );
  const responses = await Promise.all(votes);
  return responses.map((r) => r.status);
});

await timed('30 个访客并发建地点', async () => {
  const posts = Array.from({ length: 30 }, (_, index) =>
    fetch(`${ORIGIN}/api/places`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `并发岛 ${index}-${Date.now()}-${Math.random()}`,
        region: '测试',
      }),
    }),
  );
  const responses = await Promise.all(posts);
  return responses.map((r) => r.status);
});

await timed('20 个访客并发上传同一张图（内容寻址复用）', async () => {
  const form = () => {
    const fd = new FormData();
    fd.append('file', new Blob([fixture], { type: 'image/jpeg' }), 'same.jpg');
    fd.append('idempotencyKey', `same-${Math.random()}`);
    return fd;
  };
  const posts = Array.from({ length: 20 }, () =>
    fetch(`${ORIGIN}/api/places/${targetPlace}/photos`, { method: 'POST', body: form() }),
  );
  const responses = await Promise.all(posts);
  return responses.map((r) => r.status);
});

// A burst of *different* photographs, which is the real case: every upload
// needs a full decode and two preview renders, so this is where the server
// does the most work at once.
await timed('10 个访客并发上传不同照片', async () => {
  const posts = Array.from({ length: 10 }, (_, index) => {
    const fd = new FormData();
    fd.append(
      'file',
      new Blob([index % 2 === 0 ? fixture : portrait], { type: 'image/jpeg' }),
      `p${index}.jpg`,
    );
    fd.append('idempotencyKey', `burst-${index}-${Math.random()}`);
    return fetch(`${ORIGIN}/api/places/${targetPlace}/photos`, { method: 'POST', body: fd });
  });
  const responses = await Promise.all(posts);
  const statuses = responses.map((r) => r.status);
  const failures = statuses.filter((s) => s >= 400);
  if (failures.length > 0) {
    console.log(`  !! ${failures.length} 个上传失败：${JSON.stringify(statuses)}`);
  }
  return statuses;
});

await timed('50 个并发读（榜单）', async () => {
  const reads = Array.from({ length: 50 }, () =>
    fetch(`${ORIGIN}/api/places/${targetPlace}/photos?limit=40`),
  );
  const responses = await Promise.all(reads);
  return responses.map((r) => r.status);
});

// --- Integrity ---------------------------------------------------------------
const votes = await prisma.vote.count();
const photos = await prisma.photo.count();
const places = await prisma.place.count();
console.log(`
[stress] 结束时：${places} 地点 / ${photos} 照片 / ${votes} 票`);

// Every photograph must have both previews. A missing one means the ranking
// page would show a broken tile, and that is the failure the contract forbids.
const incomplete = await prisma.photo.findMany({
  where: { OR: [{ preview400Key: null }, { preview1200Key: null }] },
  select: { id: true, title: true },
});
if (incomplete.length > 0) {
  console.log(`
[stress] !! ${incomplete.length} 张照片缺少预览：${JSON.stringify(incomplete)}`);
} else {
  console.log('[stress] 每张照片都有 400 与 1200 两档预览');
}

// Content-addressed storage: the same bytes legitimately share one original.
const keyCounts = new Map();
for (const photo of await prisma.photo.findMany({ select: { originalKey: true } })) {
  keyCounts.set(photo.originalKey, (keyCounts.get(photo.originalKey) ?? 0) + 1);
}
const shared = [...keyCounts.values()].filter((count) => count > 1);
console.log(`[stress] 共享同一原件的照片：${shared.length} 组（内容寻址存储的正常现象）`);

const errors = serverLog
  .split('\n')
  .filter((line) => /⨯|unhandled|Error:/.test(line))
  .slice(0, 10);
if (errors.length > 0) {
  console.log('\n[stress] 服务端错误：');
  for (const error of errors) console.log(`  ${error}`);
}

await prisma.$disconnect();
server.kill('SIGTERM');
// Wait for the server to actually release the database file. On Windows the
// file stays locked for a moment after the process exits, and an unlink that
// races it fails with EBUSY.
await new Promise((resolve) => {
  server.once('exit', resolve);
  setTimeout(resolve, 5000);
});
for (let attempt = 0; attempt < 6; attempt += 1) {
  try {
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
}
console.log('\n[stress] sandbox cleaned');
