import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  createSandbox,
  findFreePort,
  FIXTURES,
  migrateSandbox,
  readJson,
  removeSandbox,
  sandboxEnv,
  seedDefaultPlaceOnly,
  startServer,
  stopServer,
  waitForHealthy,
  waitForPortReleased,
  type ServerHandle,
} from '../isolated-server';

/**
 * 重启后的持久化（MASTER_PLAN Phase 02「添加新地点后重启服务不丢失」与
 * Phase 03「测试夹具上传、重启后仍在」两条验收项）。
 *
 * 为什么必须由测试自己拉进程：Playwright 的 webServer 由 harness
 * （scripts/run-e2e-isolated.mjs）托管，测试代码拿不到它的进程句柄，也就无法
 * 真正重启它；退而求其次去重启 harness 的进程会连带掀翻同一次运行里的其它
 * 用例。而「重启后不丢」这件事，**只有杀掉真实进程、再用同一个数据库与媒体
 * 目录起一个全新进程**才能证明——复用同一个进程等于什么都没验证。
 *
 * 隔离：数据库、媒体、临时目录全部落在 os.tmpdir() 下由 mkdtemp 现建的目录里。
 * 绝不使用 var/local（用户自己的照片就在那里，测试没有任何理由碰它），也绝不
 * 复用 harness 的沙箱（否则重启验证会和并发跑其它用例的写操作互相干扰）。
 *
 * 起停隔离服务的工具在 e2e/isolated-server.ts 里，和「维护模式」那条用例共用。
 */

let sandbox: string | null = null;
let serverEnv: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
let server: ServerHandle | null = null;

type PlaceRef = { id: string; slug: string; name: string };
type PhotoRef = { id: string; sha256: string };

test.beforeAll(async () => {
  // 迁移 + 种子 + 冷启动都不该被默认的 90s 卡住，但也不能无限等。
  test.setTimeout(150_000);

  sandbox = await createSandbox('isle-restart-');
  const port = await findFreePort();
  serverEnv = sandboxEnv(sandbox, port);

  await migrateSandbox(serverEnv);
  // 只种默认地点，不加 --e2e：被上传的照片必须由本用例走真实 API 送上去，
  // 预先塞进库里的种子照片会让「上传后仍在」这件事变得无法证伪。
  await seedDefaultPlaceOnly(serverEnv);

  server = startServer(port, serverEnv);
  await waitForHealthy(server);
});

test.afterAll(async () => {
  // 清理绝不能因为前面的断言失败而被跳过：漏掉的就是一个还在监听端口的
  // 孤儿进程和一个留在磁盘上的沙箱目录。
  test.setTimeout(60_000);
  await stopServer(server);
  server = null;
  if (sandbox !== null) await removeSandbox(sandbox);
  sandbox = null;
});

test('照片、票数和新地点在服务重启后全部还在，原件字节仍然一致', async () => {
  // 两次冷启动 + 一次 25 MiB 以内的真实上传（sharp 出两张预览）都要时间。
  test.setTimeout(150_000);
  if (server === null || sandbox === null) throw new Error('测试服务未启动');

  const baseUrl = server.baseUrl;
  const cookie = await mintVisitorCookie(baseUrl);

  const seeded = (
    await readJson<{ places: PlaceRef[] }>(
      await fetch(`${baseUrl}/api/places`, { headers: { cookie } }),
      'GET /api/places',
    )
  ).places.find((place) => place.slug === 'guishan-island');
  if (seeded === undefined) throw new Error('种子地点 guishan-island 缺失');

  const fixturePath = path.join(FIXTURES, 'landscape.jpg');
  const fixtureBytes = await fs.readFile(fixturePath);
  const fixtureSha = createHash('sha256').update(fixtureBytes).digest('hex');

  const photo = await uploadPhoto(baseUrl, cookie, seeded.id, 'landscape.jpg', fixtureBytes);
  expect(photo.sha256).toBe(fixtureSha);

  // 「添加新地点」：第二个地点同样是重启后必须还在的东西。
  const created = await readJson<{ place: PlaceRef }>(
    await fetch(`${baseUrl}/api/places`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `重启测试岛 ${Date.now()}`, region: '测试地区' }),
    }),
    'POST /api/places',
  );
  const added = created.place;

  const vote = await readJson<{ upCount: number; score: number }>(
    await fetch(`${baseUrl}/api/photos/${photo.id}/vote`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 1 }),
    }),
    'PUT vote',
  );
  expect(vote.upCount).toBe(1);
  expect(vote.score).toBe(1);

  // ---- 真正重启 -------------------------------------------------------
  const first = server;
  await stopServer(first);
  expect(first.hasExited(), '第一个服务进程必须已经退出').toBe(true);
  await waitForPortReleased(Number(serverEnv.PORT));

  // 同一个数据库文件、同一个媒体目录，但必须是**另一个进程**：端口已经释放过，
  // 旧 PID 也已经退出，所以下面这些响应只可能来自新起的这一个进程。
  server = startServer(Number(serverEnv.PORT), serverEnv);
  await waitForHealthy(server);
  expect(server.pid, '重启后必须是一个全新的进程').not.toBe(first.pid);

  // ---- 重启后的断言 ---------------------------------------------------
  const places = (
    await readJson<{ places: PlaceRef[] }>(
      await fetch(`${server.baseUrl}/api/places`, { headers: { cookie } }),
      'GET /api/places (after restart)',
    )
  ).places;
  expect(places.map((place) => place.id)).toContain(seeded.id);
  expect(places.map((place) => place.id)).toContain(added.id);
  expect(places.map((place) => place.slug)).toContain(added.slug);

  const listed = await readJson<{
    items: Array<{
      id: string;
      title: string;
      upCount: number;
      downCount: number;
      score: number;
      currentVisitorVote: number;
    }>;
  }>(
    await fetch(`${server.baseUrl}/api/places/${seeded.id}/photos`, { headers: { cookie } }),
    'GET leaderboard (after restart)',
  );
  expect(listed.items).toHaveLength(1);

  const item = listed.items[0];
  if (item === undefined) throw new Error('重启后榜单为空');
  expect(item.id).toBe(photo.id);
  expect(item.title).toBe('重启前的照片');
  expect(item.upCount).toBe(1);
  expect(item.downCount).toBe(0);
  expect(item.score).toBe(1);
  // 复用的是同一个访客 cookie，所以这张票仍然记在我们头上。
  expect(item.currentVisitorVote).toBe(1);

  // 逐字节相等，而不只是「页面还能显示出点什么」。原件永不改写的意义，
  // 同样包括它在重启之后依然一字节不差。
  const original = await fetch(`${server.baseUrl}/api/photos/${photo.id}/original`, {
    headers: { cookie },
  });
  expect(original.status).toBe(200);
  const served = Buffer.from(await original.arrayBuffer());
  expect(createHash('sha256').update(served).digest('hex')).toBe(fixtureSha);
  expect(served.equals(fixtureBytes)).toBe(true);
});

/** 走真实 API 领取一个访客 cookie，和浏览器拿到的是同一种东西。 */
async function mintVisitorCookie(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/visitor`);
  const raw = response.headers.getSetCookie()[0] ?? '';
  const cookie = raw.split(';')[0] ?? '';
  if (cookie === '') throw new Error('服务端没有签发访客 cookie');
  return cookie;
}

async function uploadPhoto(
  baseUrl: string,
  cookie: string,
  placeId: string,
  fileName: string,
  bytes: Buffer,
): Promise<PhotoRef> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), fileName);
  form.append('title', '重启前的照片');
  form.append('description', '重启验证');
  form.append('idempotencyKey', `restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const body = await readJson<{ photo: PhotoRef }>(
    await fetch(`${baseUrl}/api/places/${placeId}/photos`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    }),
    'POST photos',
  );
  return body.photo;
}
