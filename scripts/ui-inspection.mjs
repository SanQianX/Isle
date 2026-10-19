/**
 * ISLE — UI inspection.
 *
 * Seeds a realistic dataset, then walks every page at every breakpoint and
 * captures what a visitor actually sees.
 *
 * The automated checks elsewhere assert that a thing exists. This one is for
 * looking: it produces the images a human reviews to decide whether the design
 * still reads the way it is supposed to.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';

const repoRoot = process.cwd();
const sandbox = path.join(os.tmpdir(), `isle-ui-${process.pid}`);
const dbDir = path.join(sandbox, 'db');
const mediaRoot = path.join(sandbox, 'media');
const tmpDir = path.join(sandbox, 'tmp');
const shots = path.join(repoRoot, '.ui-shots');
const databaseUrl = `file:${path.join(dbDir, 'ui.db').replace(/\\/g, '/')}`;

for (const dir of [dbDir, mediaRoot, tmpDir, shots]) await fs.mkdir(dir, { recursive: true });

process.env.DATABASE_URL = databaseUrl;
process.env.MEDIA_ROOT = mediaRoot;
process.env.UPLOAD_TMP_DIR = tmpDir;
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3085';
process.env.ISLE_E2E = '1';
process.env.NODE_ENV = 'production';

const prismaCli = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');
execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  stdio: 'pipe',
  env: process.env,
});

const { ingestPhotoBytes } = await import('../src/server/services/photo.ts');
const { seedDefaultPlace, createPlace } = await import('../src/server/services/place.ts');
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

const fixtures = path.join(repoRoot, 'tests', 'fixtures');
const load = async (name) => new Uint8Array(await fs.readFile(path.join(fixtures, name)));

const author = await prisma.visitor.create({
  data: { tokenHash: `ui-author-${Date.now()}`, displayCode: 'ui001' },
});

await seedDefaultPlace();
const guishan = await prisma.place.findFirst({ where: { slug: 'guishan-island' } });

// A spread of shapes, so the wall has to do real work: wide, tall, square,
// small, and one with EXIF orientation.
const plan = [
  ['landscape.jpg', '从云端经过桂山岛'],
  ['portrait.jpg', '灯塔亮起的时候'],
  ['square.png', '码头上的午后'],
  ['extreme-wide.webp', '还没靠岸'],
  ['extreme-tall.jpg', '渔船归港'],
  ['landscape-2.jpg', '雨后的礁石'],
  ['gps-exif.jpg', '带着坐标的那一张'],
  ['small.jpeg', '一只小螺'],
  ['exif-rotate.jpg', '转了九十度的海'],
  ['landscape.jpg', '第二次经过'],
  ['portrait.jpg', '傍晚的栈桥'],
  ['square.png', '正午'],
];

for (const [file, title] of plan) {
  await ingestPhotoBytes({
    placeId: guishan.id,
    visitorId: author.id,
    bytes: await load(file),
    fileName: file,
    mime: file.endsWith('.png')
      ? 'image/png'
      : file.endsWith('.webp')
        ? 'image/webp'
        : 'image/jpeg',
    title,
    description: 'UI 检查用的照片',
    idempotencyKey: `ui-${file}-${title}-${Date.now()}`,
  });
}

// A few more places, some with photographs and some without, so the list shows
// both the covered and the empty state.
for (let i = 0; i < 4; i += 1) {
  const place = await createPlace({
    name: ['外伶仃岛', '海陵岛', '担杆岛', '东澳岛'][i],
    region: '广东 · 珠海 · 万山群岛',
    description: 'UI 检查用的地点',
  });
  if (i % 2 === 0) {
    await ingestPhotoBytes({
      placeId: place.id,
      visitorId: author.id,
      bytes: await load('landscape.jpg'),
      fileName: 'landscape.jpg',
      mime: 'image/jpeg',
      title: `${place.name}的一张照片`,
      description: '',
      idempotencyKey: `ui-place-${place.id}`,
    });
  }
}

// Give the leaderboard a spread of scores so the ordering is meaningful.
const photos = await prisma.photo.findMany({
  where: { placeId: guishan.id },
  select: { id: true },
});
const voters = [];
for (let v = 0; v < 8; v += 1) {
  voters.push(
    (
      await prisma.visitor.create({
        data: {
          tokenHash: `ui-voter-${v}-${Date.now()}`,
          displayCode: `uv${String(v).padStart(3, '0')}`,
        },
      })
    ).id,
  );
}
for (const [index, photo] of photos.entries()) {
  for (const voter of voters.slice(0, Math.max(0, 6 - index))) {
    await prisma.vote.upsert({
      where: { photoId_visitorId: { photoId: photo.id, visitorId: voter } },
      create: { photoId: photo.id, visitorId: voter, value: 1 },
      update: {},
    });
  }
}

console.log(`[ui] ${photos.length} 张照片、6 个地点已就绪`);

const { spawn } = await import('node:child_process');
const server = spawn(process.execPath, [path.join(repoRoot, '.next', 'standalone', 'server.js')], {
  cwd: path.join(repoRoot, '.next', 'standalone'),
  env: { ...process.env, PORT: '3085', HOSTNAME: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (c) => (serverLog += c));
server.stderr.on('data', (c) => (serverLog += c));
let serverUp = false;
for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    if ((await fetch('http://127.0.0.1:3085/api/health')).ok) {
      serverUp = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}
if (!serverUp) {
  // Fail loudly rather than letting the browser report a connection error that
  // says nothing about the cause.
  console.error('[ui] the server never became healthy: ' + serverLog);
  server.kill('SIGTERM');
  process.exit(1);
}

const browser = await chromium.launch();
const PAGES = [
  ['home', '/'],
  ['places', '/places'],
  ['place', '/places/guishan-island'],
  ['ranking', '/places/guishan-island/ranking'],
  ['upload', '/places/guishan-island/upload'],
  ['new-place', '/places/new'],
];

const findings = [];

for (const [width, height, label] of [
  [1440, 900, 'desktop'],
  [768, 1024, 'tablet'],
  [390, 844, 'mobile'],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR ${e.message}`));

  for (const [name, route] of PAGES) {
    await page.goto(`http://127.0.0.1:3085${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.screenshot({
      path: path.join(shots, `${label}-${name}.png`),
      fullPage: label === 'desktop',
    });

    // Structural checks a screenshot alone would not make.
    const report = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth;
      const overflowing = [...document.querySelectorAll('body *')]
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.right > limit + 1;
        })
        .map((node) => `${node.tagName}.${String(node.className).slice(0, 30)}`);

      const brokenImages = [...document.images]
        .filter((image) => image.complete && image.naturalWidth === 0)
        .map((image) => image.src.slice(-60));

      const tinyTargets = [...document.querySelectorAll('button, a[href]')]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return {
            label: (node.textContent ?? '').trim().slice(0, 16),
            w: rect.width,
            h: rect.height,
          };
        })
        .filter((target) => target.w > 0 && (target.w < 24 || target.h < 24));

      return {
        overflow: [...new Set(overflowing)].slice(0, 5),
        brokenImages: brokenImages.slice(0, 5),
        tinyTargets: tinyTargets.slice(0, 5),
        images: document.images.length,
        nodes: document.querySelectorAll('*').length,
      };
    });

    if (report.overflow.length > 0)
      findings.push(`${label}/${name}: 溢出 ${report.overflow.join(', ')}`);
    if (report.brokenImages.length > 0)
      findings.push(`${label}/${name}: 坏图 ${report.brokenImages.join(', ')}`);
    if (report.tinyTargets.length > 0) {
      findings.push(
        `${label}/${name}: 触控目标过小 ${report.tinyTargets.map((t) => `${t.label}(${t.w.toFixed(0)}x${t.h.toFixed(0)})`).join(', ')}`,
      );
    }
    if (consoleErrors.length > 0) {
      findings.push(
        `${label}/${name}: 控制台错误 ${[...new Set(consoleErrors)].slice(0, 3).join(' | ')}`,
      );
    }
  }
  await page.close();
}

await browser.close();

console.log('\n=== UI 检查结论 ===');
if (findings.length === 0) {
  console.log('  没有发现溢出、坏图、触控目标过小或控制台错误');
} else {
  for (const finding of findings) console.log(`  ${finding}`);
}
console.log(`\n  截图目录 ${shots}`);

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
