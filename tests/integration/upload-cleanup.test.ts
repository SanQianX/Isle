import { promises as fs } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as PhotosRoute from '@/app/api/places/[placeId]/photos/route';
import { createTestContext, migrateTestDatabase, type TestContext } from '../factories';

/**
 * 上传失败后不留痕（MASTER_PLAN Phase 03「上传中断清理，不出脏 READY 记录」，
 * E2E_SCENARIOS SEC-09「失败不留半成品」）。
 *
 * 上传临时目录是每个请求的落脚点：请求进来时建一个随机名文件，流式写进去，
 * 成功后交给 ingest 删除，失败时必须删掉。**失败路径才是会漏的那一条**——
 * 成功路径有人记得写 `fs.rm`，被拒绝的路径往往忘了。
 *
 * 漏掉临时文件不是小事：那是磁盘上真实占着空间的文件。一次超限上传留一个
 * 25 MiB 的残骸，用户反复重试（换了张更大的图、或者网络抽风）就会把临时目录
 * 撑满；临时目录和媒体目录在同一个分区，撑满了以后连正常上传一起失败——
 * 于是「一次失败的尝试」变成了「整个站点的磁盘故障」。
 *
 * 另一个容易被忽略的细节：删文件之前，写文件的句柄必须已经关闭。在 Windows 上
 * 打开中的文件删不掉（EPERM），在 Linux 上能删但句柄还在（inode 直到最后一个
 * 引用消失才回收）。所以断言不能只看「目录里有没有文件」，还要看句柄有没有漏。
 */

let context: TestContext;
let photosRoute: typeof PhotosRoute;
let placeId: string;

const BASE = 'http://127.0.0.1:3099';
/** Small cap so the oversize case does not have to push 25 MiB through the wire. */
const MAX_BYTES = 64 * 1024;

beforeAll(async () => {
  context = createTestContext('isle-upload-cleanup');
  context.applyEnv();
  process.env.MAX_UPLOAD_BYTES = String(MAX_BYTES);
  await migrateTestDatabase(context.client);

  const { resetConfigCache } = await import('@/lib/config');
  const { resetPrismaForTests } = await import('@/server/db/client');
  resetConfigCache();
  await resetPrismaForTests();

  photosRoute = await import('@/app/api/places/[placeId]/photos/route');

  const { seedDefaultPlace } = await import('@/server/services/place');
  placeId = (await seedDefaultPlace()).id;
});

afterAll(async () => {
  const { resetPrismaForTests } = await import('@/server/db/client');
  await resetPrismaForTests();
  await context.cleanup();
});

beforeEach(async () => {
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();
  await prisma.vote.deleteMany();
  await prisma.photo.deleteMany();
});

/** Every file currently sitting in the upload temp directory. */
async function tempFiles(): Promise<string[]> {
  const names = await fs.readdir(context.uploadTmpDir);
  return names.sort();
}

/** A multipart body that exceeds the cap. */
function oversizeBody(): { body: BodyInit; boundary: string } {
  const boundary = '----islecleanup';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const payload = Buffer.alloc(MAX_BYTES * 3, 0x41);
  return {
    boundary,
    body: Buffer.concat([Buffer.from(head), payload, Buffer.from(tail)]),
  };
}

/** A multipart body whose stream dies half way through. */
function interruptedBody(): { body: BodyInit; boundary: string } {
  const boundary = '----islecleanup';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="half.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(head));
      controller.enqueue(new Uint8Array(1024));
      // The connection dies: the reader gets an error, not a clean end.
      controller.error(new Error('connection reset by peer'));
    },
  });

  return { boundary, body: stream };
}

describe('上传失败不留临时文件', () => {
  it('超出大小上限时返回 413，且临时目录不残留任何文件', async () => {
    const { body, boundary } = oversizeBody();

    const response = await photosRoute.POST(
      new Request(`${BASE}/api/places/${placeId}/photos`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: body as BodyInit,
      }),
      { params: Promise.resolve({ placeId }) },
    );

    expect(response.status).toBe(413);
    // The point of the test: not one byte of the rejected upload is still on disk.
    expect(await tempFiles()).toEqual([]);
  });

  it('上传流中途断开时返回 4xx，且临时目录不残留任何文件', async () => {
    const { body, boundary } = interruptedBody();

    const response = await photosRoute.POST(
      new Request(`${BASE}/api/places/${placeId}/photos`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: body as BodyInit,
        // A streaming body needs an explicit duplex hint, and the declared
        // length is a lie -- the parser must not trust it.
        ...({ 'content-length': String(MAX_BYTES), duplex: 'half' } as Record<string, string>),
      }),
      { params: Promise.resolve({ placeId }) },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(await tempFiles()).toEqual([]);
  });

  it('没有文件部分时返回 400，且临时目录不残留任何文件', async () => {
    const boundary = '----islecleanup';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nno file here\r\n--${boundary}--\r\n`;

    const response = await photosRoute.POST(
      new Request(`${BASE}/api/places/${placeId}/photos`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
      }),
      { params: Promise.resolve({ placeId }) },
    );

    expect(response.status).toBe(400);
    expect(await tempFiles()).toEqual([]);
  });

  it('连续 20 次超限上传后，临时目录仍然为空（不是「一次会漏」）', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { body, boundary } = oversizeBody();
      const response = await photosRoute.POST(
        new Request(`${BASE}/api/places/${placeId}/photos`, {
          method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
          body: body as BodyInit,
        }),
        { params: Promise.resolve({ placeId }) },
      );
      expect(response.status).toBe(413);
    }

    expect(await tempFiles()).toEqual([]);
  });

  it('失败的尝试不会留下 Photo 行', async () => {
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();

    const { body, boundary } = oversizeBody();
    await photosRoute.POST(
      new Request(`${BASE}/api/places/${placeId}/photos`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body: body as BodyInit,
      }),
      { params: Promise.resolve({ placeId }) },
    );

    expect(await prisma.photo.count()).toBe(0);
  });
});
