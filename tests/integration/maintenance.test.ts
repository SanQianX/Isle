import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as HealthRoute from '@/app/api/health/route';
import type * as PlacesRoute from '@/app/api/places/route';
import type * as PhotosRoute from '@/app/api/places/[placeId]/photos/route';
import type * as VoteRoute from '@/app/api/photos/[photoId]/vote/route';
import { createTestContext, migrateTestDatabase, type TestContext } from '../factories';

/**
 * 维护模式：暂停写入，读取照常
 * （DEPLOY_RUNBOOK §8「暂停写入后备份」，DEPLOY_RUNBOOK §9 的健康检查约定）。
 *
 * 这条能力以前根本不存在。备份脚本一直在调用一个并不存在的地址（POST 到只有
 * GET 的路由，还带一个没有实现的参数），并且用 `|| true` 吞掉了失败——于是备份
 * 脚本「暂停写入」这一步是彻头彻尾的摆设，写入照旧发生。而这正是备份最不能出
 * 的错：数据库快照用 SQLite 的在线备份 API 是原子的，可媒体目录的复制不是。
 * 备份期间新传的照片，会让快照里出现「有行无文件」（或反过来）的照片。
 *
 * 所以这里要钉住的是：
 *   1. 暂停真的会让写入失败，并且是 503 而不是 500；
 *   2. 读取不受影响——维护窗口只该让数据稳定，不该让整站打不开；
 *   3. 暂停只允许本机触发（生产里 nginx 一定会加 X-Forwarded-For）；
 *   4. 恢复之后写入立刻重新可用。
 */

let context: TestContext;
let healthRoute: typeof HealthRoute;
let placesRoute: typeof PlacesRoute;
let photosRoute: typeof PhotosRoute;
let voteRoute: typeof VoteRoute;

const BASE = 'http://127.0.0.1:3099';
let placeId: string;
let photoId: string;

beforeAll(async () => {
  context = createTestContext('isle-maintenance');
  context.applyEnv();
  await migrateTestDatabase(context.client);

  const { resetConfigCache } = await import('@/lib/config');
  const { resetPrismaForTests } = await import('@/server/db/client');
  resetConfigCache();
  await resetPrismaForTests();

  healthRoute = await import('@/app/api/health/route');
  placesRoute = await import('@/app/api/places/route');
  photosRoute = await import('@/app/api/places/[placeId]/photos/route');
  voteRoute = await import('@/app/api/photos/[photoId]/vote/route');

  const { seedDefaultPlace } = await import('@/server/services/place');
  placeId = (await seedDefaultPlace()).id;

  const { ingestPhotoBytes } = await import('@/server/services/photo');
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();

  const visitor = await prisma.visitor.create({
    data: { tokenHash: `maintenance-${Date.now()}`, displayCode: 'm001' },
  });
  const bytes = await readFile(path.join(process.cwd(), 'tests', 'fixtures', 'landscape.jpg'));
  const photo = await ingestPhotoBytes({
    placeId,
    visitorId: visitor.id,
    bytes: new Uint8Array(bytes),
    fileName: 'landscape.jpg',
    mime: 'image/jpeg',
    title: '维护岛',
    description: '',
    idempotencyKey: 'maintenance-fixture',
  });
  photoId = photo.id;
});

afterAll(async () => {
  const { resetPrismaForTests } = await import('@/server/db/client');
  await resetPrismaForTests();
  await context.cleanup();
});

afterEach(async () => {
  // The pause is process-wide state, so it has to be undone between cases.
  const { setWritesPaused } = await import('@/server/http/maintenance');
  setWritesPaused(false);
});

beforeEach(async () => {
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();
  await prisma.vote.deleteMany();
});

/** Pause or resume, as the backup script does. */
async function pause(writes: 0 | 1, headers: Record<string, string> = {}): Promise<Response> {
  return healthRoute.POST(
    new Request(`${BASE}/api/health?pause-writes=${writes}`, {
      method: 'POST',
      headers: { host: '127.0.0.1:3099', ...headers },
    }),
  );
}

describe('维护模式', () => {
  it('本机可以暂停写入，并且状态是可查询的', async () => {
    const response = await pause(1);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { writesPaused: boolean };
    expect(body.writesPaused).toBe(true);

    const { areWritesPaused } = await import('@/server/http/maintenance');
    expect(areWritesPaused()).toBe(true);
  });

  it('暂停期间投票返回 503，而不是 500', async () => {
    await pause(1);

    const response = await voteRoute.PUT(
      new Request(`${BASE}/api/photos/${photoId}/vote`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', host: '127.0.0.1:3099' },
        body: JSON.stringify({ value: 1 }),
      }),
      { params: Promise.resolve({ photoId }) },
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    // 人话，不是机器码。
    expect(body.error.message).toMatch(/[一-鿿]/);
  });

  it('暂停期间创建地点同样被拒', async () => {
    await pause(1);

    const response = await placesRoute.POST(
      new Request(`${BASE}/api/places`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: '127.0.0.1:3099' },
        body: JSON.stringify({ name: '维护岛', region: '测试地区' }),
      }),
    );

    expect(response.status).toBe(503);
  });

  it('暂停期间上传同样被拒', async () => {
    await pause(1);

    const boundary = '----maintenance';
    const response = await photosRoute.POST(
      new Request(`${BASE}/api/places/${placeId}/photos`, {
        method: 'POST',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          host: '127.0.0.1:3099',
        },
        body: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nxx\r\n--${boundary}--\r\n`,
      }),
      { params: Promise.resolve({ placeId }) },
    );

    expect(response.status).toBe(503);
  });

  it('暂停期间读取照常工作——维护窗口不该让整站打不开', async () => {
    await pause(1);

    const response = await photosRoute.GET(
      new Request(`${BASE}/api/places/${placeId}/photos`, { headers: { host: '127.0.0.1:3099' } }),
      { params: Promise.resolve({ placeId }) },
    );

    expect(response.status).toBe(200);
  });

  it('恢复之后写入立刻重新可用', async () => {
    await pause(1);
    const response = await pause(0);
    expect(response.status).toBe(200);

    const vote = await voteRoute.PUT(
      new Request(`${BASE}/api/photos/${photoId}/vote`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', host: '127.0.0.1:3099' },
        body: JSON.stringify({ value: 1 }),
      }),
      { params: Promise.resolve({ photoId }) },
    );

    expect(vote.status).toBe(200);
  });

  it('被暂停的站点不留下任何写入的痕迹', async () => {
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    const before = await prisma.photo.count();
    const placesBefore = await prisma.place.count();

    await pause(1);
    await voteRoute.PUT(
      new Request(`${BASE}/api/photos/${photoId}/vote`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', host: '127.0.0.1:3099' },
        body: JSON.stringify({ value: 1 }),
      }),
      { params: Promise.resolve({ photoId }) },
    );

    expect(await prisma.vote.count()).toBe(0);
    expect(await prisma.photo.count()).toBe(before);
    expect(await prisma.place.count()).toBe(placesBefore);
  });

  it('网络上的请求不能切换维护模式', async () => {
    // A request that came through nginx always carries X-Forwarded-For, and
    // nginx rewrites Host to the public name. Either one is enough to refuse.
    const viaProxy = await pause(1, { 'x-forwarded-for': '203.0.113.7' });
    expect(viaProxy.status).toBe(403);

    const publicHost = await healthRoute.POST(
      new Request(`${BASE}/api/health?pause-writes=1`, {
        method: 'POST',
        headers: { host: 'photos.example.com' },
      }),
    );
    expect(publicHost.status).toBe(403);

    const { areWritesPaused } = await import('@/server/http/maintenance');
    expect(areWritesPaused()).toBe(false);
  });

  it('伪造的 X-Forwarded-For 不能骗过检查', async () => {
    // The *last* entry is the one that counts, because that is the entry the
    // outermost proxy added -- and it appends it last. A client that sends
    // its own X-Forwarded-For ends up in front of that entry, so a forged
    // "127.0.0.1" at the front buys nothing.
    const forged = await pause(1, { 'x-forwarded-for': '127.0.0.1, 203.0.113.7' });
    expect(forged.status).toBe(403);

    const { areWritesPaused } = await import('@/server/http/maintenance');
    expect(areWritesPaused()).toBe(false);
  });

  it('参数不是 0 或 1 时拒绝，并且不改变状态', async () => {
    const response = await healthRoute.POST(
      new Request(`${BASE}/api/health?pause-writes=yes`, {
        method: 'POST',
        headers: { host: '127.0.0.1:3099' },
      }),
    );
    expect(response.status).toBe(400);

    const { areWritesPaused } = await import('@/server/http/maintenance');
    expect(areWritesPaused()).toBe(false);
  });

  it('健康检查会报告当前是否处于维护模式', async () => {
    await pause(1);
    const response = await healthRoute.GET(
      new Request(`${BASE}/api/health`, { headers: { host: '127.0.0.1:3099' } }),
    );
    const body = (await response.json()) as { writesPaused: boolean };
    expect(body.writesPaused).toBe(true);
  });
});
