import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, migrateTestDatabase, type TestContext } from '../factories';

/**
 * 地点与照片的边界（MASTER_PLAN Phase 04 验收项：「非图片和跨地点 photo ID 无不当
 * 泄露」，对应 E2E_SCENARIOS SEC-07「原图 URL 穿越/非法 ID → 404/400，不泄露服务器
 * 绝对路径」与 SEC-10「隐藏违规照片后榜单和原件访问依据策略失效」）。
 *
 * 三条必须钉死的边界：
 *
 *   1. **地点隔离** —— 榜单是按 placeId 过滤的，A 的照片在任何情况下都不该出现在
 *      B 的榜单里，包括「拿 B 的 placeId 但带着 A 上传者的身份」这种混淆请求。
 *   2. **不确认存在性** —— 对一个不存在的 id、对一个畸形 id、对一个被下架（HIDDEN）
 *      的 id，响应必须**完全一样**：都是 404、同样的 JSON 体、不带 ETag、不带
 *      Content-Length、不带磁盘路径。403/404 的区别本身就是信息泄露。
 *   3. **不泄露内部结构** —— 404 的响应体里不能出现磁盘路径、盘符、SQL 片段或
 *      存储 key，否则等于把部署布局和表结构送出去。
 *
 * 注意第 2 条里「对 HIDDEN 也返回 404」不是实现细节而是被 ADR-010 明确要求的：
 * 下架一张照片的原因是隐私或侵权，如果访问它会得到一个「它存在但被下架」的答复，
 * 那么下架这个动作本身就成了信息。
 */

type PhotoHandler = (
  request: Request,
  context: { params: Promise<{ photoId: string }> },
) => Promise<Response>;
type PreviewHandler = (
  request: Request,
  context: { params: Promise<{ photoId: string; size: string }> },
) => Promise<Response>;
type PlaceHandler = (
  request: Request,
  context: { params: Promise<{ placeId: string }> },
) => Promise<Response>;

let context: TestContext;

let originalRoute: { GET: PhotoHandler; HEAD: PhotoHandler };
let downloadRoute: { GET: PhotoHandler };
let previewRoute: { GET: PreviewHandler };
let photosRoute: { GET: PlaceHandler };
let placesRoute: { GET: PlaceHandler };

const BASE = 'http://127.0.0.1:3099';

/** 地点 A：默认种子地点，照片是 landscape.jpg。 */
let placeA: { id: string; slug: string };
let photoA: { id: string; sha: string; bytes: Uint8Array };

/** 地点 B：新建的另一个地点，照片是 portrait.jpg（与 A 字节完全不同）。 */
let placeB: { id: string; slug: string };
let photoB: { id: string; sha: string; bytes: Uint8Array };

/** 上传 A 的那张照片的访客（用于构造「身份混淆」请求）。 */
let uploaderACookie: string;

type Leaderboard = {
  placeId: string;
  total: number;
  items: Array<{ id: string; rank: number; score: number; title: string }>;
};

beforeAll(async () => {
  context = createTestContext('isle-place-scoping');
  context.applyEnv();
  await migrateTestDatabase(context.client);

  const { resetConfigCache } = await import('@/lib/config');
  const { resetPrismaForTests } = await import('@/server/db/client');
  resetConfigCache();
  await resetPrismaForTests();

  originalRoute = await import('@/app/api/photos/[photoId]/original/route');
  downloadRoute = await import('@/app/api/photos/[photoId]/download/route');
  previewRoute = await import('@/app/api/photos/[photoId]/preview/[size]/route');
  photosRoute = await import('@/app/api/places/[placeId]/photos/route');
  placesRoute = await import('@/app/api/places/route');

  const { seedDefaultPlace, createPlace } = await import('@/server/services/place');
  const { ingestPhotoBytes } = await import('@/server/services/photo');

  const seeded = await seedDefaultPlace();
  placeA = { id: seeded.id, slug: seeded.slug };

  // 地点名要每次运行都不一样：集成测试用的是独立库，但同名会让重跑时的
  // slug 冲突逻辑走到另一条分支，掩盖真实断言。
  const other = await createPlace({
    name: `别处 ${randomBytes(4).toString('hex')}`,
    region: '测试地区',
    description: '用于验证地点隔离的对照地点。',
  });
  placeB = { id: other.id, slug: other.slug };

  const landscape = await fixture('landscape.jpg');
  const portrait = await fixture('portrait.jpg');

  const visitorA = await makeVisitor();
  uploaderACookie = visitorA.cookie;
  const a = await ingestPhotoBytes({
    placeId: placeA.id,
    visitorId: visitorA.id,
    bytes: landscape,
    fileName: 'landscape.jpg',
    mime: 'image/jpeg',
    title: '地点 A 的照片',
    idempotencyKey: `scope-a-${process.pid}`,
  });

  const visitorB = await makeVisitor();
  const b = await ingestPhotoBytes({
    placeId: placeB.id,
    visitorId: visitorB.id,
    bytes: portrait,
    fileName: 'portrait.jpg',
    mime: 'image/jpeg',
    title: '地点 B 的照片',
    idempotencyKey: `scope-b-${process.pid}`,
  });

  photoA = { id: a.id, sha: a.sha256, bytes: landscape };
  photoB = { id: b.id, sha: b.sha256, bytes: portrait };
});

afterAll(async () => {
  const { resetPrismaForTests } = await import('@/server/db/client');
  await resetPrismaForTests();
  await context.cleanup();
});

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(path.join(process.cwd(), 'tests', 'fixtures', name)));
}

let visitorCounter = 0;
async function makeVisitor(): Promise<{ id: string; cookie: string }> {
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();
  visitorCounter += 1;
  const token = createHash('sha256')
    .update(`scope-visitor-${process.pid}-${visitorCounter}`)
    .digest('hex');
  const visitor = await prisma.visitor.create({
    data: {
      tokenHash: createHash('sha256').update(`hash-${token}`).digest('hex'),
      displayCode: createHash('md5').update(token).digest('hex').slice(0, 6),
    },
  });
  return { id: visitor.id, cookie: `isle_visitor=${token}` };
}

async function leaderboardOf(placeIdOrSlug: string, cookie?: string): Promise<Leaderboard> {
  const response = await photosRoute.GET(
    new Request(`${BASE}/api/places/${placeIdOrSlug}/photos`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
    { params: Promise.resolve({ placeId: placeIdOrSlug }) },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Leaderboard;
}

async function mediaBytes(
  route: { GET: PhotoHandler },
  photoId: string,
  kind: 'original' | 'download',
): Promise<Buffer> {
  const response = await route.GET(new Request(`${BASE}/api/photos/${photoId}/${kind}`), {
    params: Promise.resolve({ photoId }),
  });
  expect(response.status, `${kind} ${photoId}`).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

async function previewBytes(photoId: string, size: string): Promise<Buffer> {
  const response = await previewRoute.GET(
    new Request(`${BASE}/api/photos/${photoId}/preview/${size}`),
    { params: Promise.resolve({ photoId, size }) },
  );
  expect(response.status, `preview/${size} ${photoId}`).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

/** 响应体里绝不能出现的东西：部署路径、表结构、存储 key。 */
function expectNoInternals(body: string, what: string): void {
  for (const secret of [
    context.mediaRoot,
    context.uploadTmpDir,
    context.databaseFile,
    'original/',
    'preview/400',
    'SELECT',
    'sqlite',
    'Prisma',
    'isle_visitor',
    process.cwd(),
  ]) {
    expect(body, `${what} 的响应体泄露了 ${secret}`).not.toContain(secret);
  }
}

describe('地点隔离', () => {
  it('地点 A 的照片绝不会出现在地点 B 的榜单里', async () => {
    const a = await leaderboardOf(placeA.id);
    const b = await leaderboardOf(placeB.id);

    expect(a.items.map((item) => item.id)).toEqual([photoA.id]);
    expect(b.items.map((item) => item.id)).toEqual([photoB.id]);

    // 反向也要成立：不能只保证 A 不在 B 里，B 也不该出现在 A 里。
    expect(a.items.some((item) => item.id === photoB.id)).toBe(false);
    expect(b.items.some((item) => item.id === photoA.id)).toBe(false);

    // 两个榜单连对方的 id 文本都不该出现。
    expect(JSON.stringify(b)).not.toContain(photoA.id);
    expect(JSON.stringify(a)).not.toContain(photoB.id);
  });

  it('用地点 B 的 id 或 slug 访问榜单，都不会返回地点 A 的照片', async () => {
    const byId = await leaderboardOf(placeB.id);
    const bySlug = await leaderboardOf(placeB.slug);

    expect(bySlug.placeId).toBe(placeB.id);
    for (const board of [byId, bySlug]) {
      expect(board.items.map((item) => item.id)).not.toContain(photoA.id);
      expect(board.items.map((item) => item.id)).toEqual([photoB.id]);
      expect(board.total).toBe(1);
    }
  });

  it('用地点 B 的身份和地点 A 的上传者身份混着请求，仍然只拿到各自地点的照片', async () => {
    // 访客身份是全局的，地点归属不是。这里刻意用「上传了 A 的照片的那个访客」
    // 去读 B 的榜单：服务端绝不能因为「你是 A 的上传者」而放宽 B 的过滤。
    const asUploaderOfA = await leaderboardOf(placeB.id, uploaderACookie);
    const asAnonymous = await leaderboardOf(placeB.id);

    expect(asUploaderOfA.items.map((item) => item.id)).toEqual([photoB.id]);
    expect(asUploaderOfA.items.some((item) => item.id === photoA.id)).toBe(false);
    // 没有 cookie 与带 cookie 结果必须一致：身份不影响地点隔离。
    expect(asUploaderOfA.items.map((item) => item.id)).toEqual(
      asAnonymous.items.map((item) => item.id),
    );

    // 反向：A 的上传者读 A 的榜单，看到的也只是 A 自己那张。
    const aAsUploader = await leaderboardOf(placeA.id, uploaderACookie);
    expect(aAsUploader.items.map((item) => item.id)).toEqual([photoA.id]);
  });

  it('地点列表里的 photoCount 各自统计，互不串味', async () => {
    const response = await placesRoute.GET(new Request(`${BASE}/api/places`), {
      params: Promise.resolve({ placeId: placeA.id }),
    });
    const body = (await response.json()) as {
      places: Array<{ id: string; photoCount: number; contributorCount: number }>;
    };

    const listedA = body.places.find((place) => place.id === placeA.id);
    const listedB = body.places.find((place) => place.id === placeB.id);
    expect(listedA?.photoCount).toBe(1);
    expect(listedB?.photoCount).toBe(1);
  });
});

describe('照片 id 只解析到自己那一份字节', () => {
  it('original / download 返回的字节就是该照片自己的原件', async () => {
    for (const [kind, route] of [
      ['original', originalRoute],
      ['download', downloadRoute],
    ] as const) {
      const aBytes = await mediaBytes(route, photoA.id, kind);
      const bBytes = await mediaBytes(route, photoB.id, kind);

      expect(aBytes.equals(Buffer.from(photoA.bytes)), `${kind}: A 的字节不对`).toBe(true);
      expect(bBytes.equals(Buffer.from(photoB.bytes)), `${kind}: B 的字节不对`).toBe(true);
      // 交叉：拿 A 的 id 绝不能返回 B 的文件。两张 fixture 字节不同，所以这个
      // 断言不是恒真的。
      expect(aBytes.equals(bBytes)).toBe(false);
      expect(createHash('sha256').update(aBytes).digest('hex')).toBe(photoA.sha);
      expect(createHash('sha256').update(bBytes).digest('hex')).toBe(photoB.sha);
    }
  });

  it('preview/400 与 preview/1200 各是各的派生图，不是对方的', async () => {
    for (const size of ['400', '1200']) {
      const aBytes = await previewBytes(photoA.id, size);
      const bBytes = await previewBytes(photoB.id, size);

      expect(aBytes.equals(bBytes), `preview/${size}: 两张不同照片的预览不应相同`).toBe(false);

      // 预览是重新编码的 WebP，尺寸由各自原图决定：A 是横图、B 是竖图。
      const { default: sharp } = await import('sharp');
      const aMeta = await sharp(aBytes).metadata();
      const bMeta = await sharp(bBytes).metadata();
      expect(aMeta.format).toBe('webp');
      expect(bMeta.format).toBe('webp');
      expect(aMeta.width! > aMeta.height!).toBe(true);
      expect(bMeta.height! > bMeta.width!).toBe(true);
    }
  });

  it('download 用 attachment 且文件名不越界，original 用 inline', async () => {
    const original = await originalRoute.GET(
      new Request(`${BASE}/api/photos/${photoA.id}/original`),
      { params: Promise.resolve({ photoId: photoA.id }) },
    );
    const download = await downloadRoute.GET(
      new Request(`${BASE}/api/photos/${photoA.id}/download`),
      { params: Promise.resolve({ photoId: photoA.id }) },
    );

    expect(original.headers.get('content-disposition')).toContain('inline');
    expect(download.headers.get('content-disposition')).toContain('attachment');
    // 用户提供的文件名永远不能变成路径片段。
    expect(download.headers.get('content-disposition')).not.toContain('..');
    expect(download.headers.get('content-disposition')).not.toContain('/');
    expect(original.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('未知 / 畸形 id 一律 404，且不泄露内部结构', () => {
  const malformed = [
    '../../etc/passwd',
    '..%2f..%2fetc%2fpasswd',
    '/etc/passwd',
    'C:\\Windows\\System32\\config\\SAM',
    'preview/400/ab/original.jpg',
    "1' OR '1'='1",
    'a'.repeat(65),
    'a'.repeat(4096),
    '',
    ' ',
    'null',
    'undefined',
    '0',
    '../../../../../../../../../../etc/shadow',
  ];

  it.each(malformed)('media 路由对 %j 返回 404 且响应体干净', async (photoId) => {
    const label = `photoId=${JSON.stringify(photoId).slice(0, 40)}`;

    const responses: Array<[string, Response]> = [
      [
        'original',
        await originalRoute.GET(new Request(`${BASE}/x`), {
          params: Promise.resolve({ photoId }),
        }),
      ],
      [
        'HEAD original',
        await originalRoute.HEAD(new Request(`${BASE}/x`), {
          params: Promise.resolve({ photoId }),
        }),
      ],
      [
        'download',
        await downloadRoute.GET(new Request(`${BASE}/x`), {
          params: Promise.resolve({ photoId }),
        }),
      ],
      [
        'preview/400',
        await previewRoute.GET(new Request(`${BASE}/x`), {
          params: Promise.resolve({ photoId, size: '400' }),
        }),
      ],
      [
        'preview/1200',
        await previewRoute.GET(new Request(`${BASE}/x`), {
          params: Promise.resolve({ photoId, size: '1200' }),
        }),
      ],
    ];

    for (const [route, response] of responses) {
      expect(response.status, `${route} ${label}`).toBe(404);
      // 404 的响应里连 Content-Length 都不该有：它本来就没有正文可描述。
      expect(response.headers.get('content-length')).toBeNull();
      expect(response.headers.get('etag')).toBeNull();
      expect(response.headers.get('content-disposition')).toBeNull();
    }

    const body = await responses[0]![1].text();
    expect((JSON.parse(body) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expectNoInternals(body, label);
  });

  it.each(['800', '2048', '0', 'abc', '400x', '../400', '400/400', '%34%30%30'])(
    'preview/%s 返回 404 而不是按需缩放',
    async (size) => {
      const response = await previewRoute.GET(new Request(`${BASE}/x`), {
        params: Promise.resolve({ photoId: photoA.id, size }),
      });
      expect(response.status).toBe(404);
      expectNoInternals(await response.text(), `preview/${size}`);
    },
  );

  it.each(['../../etc/passwd', 'no-such-place', 'a'.repeat(500), '', ' ', "' OR 1=1"])(
    '榜单路由对未知地点 %j 返回 404 且响应体干净',
    async (placeId) => {
      const response = await photosRoute.GET(new Request(`${BASE}/api/places/${placeId}/photos`), {
        params: Promise.resolve({ placeId }),
      });
      expect(response.status).toBe(404);
      const body = await response.text();
      expect((JSON.parse(body) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
      expectNoInternals(body, `placeId=${JSON.stringify(placeId).slice(0, 40)}`);
    },
  );

  it('一个真实存在但不属于任何地点的 id 也不会被猜出来', async () => {
    // 先确认 A、B 两张确实存在，防止上面几条全绿是因为「什么都没建」。
    expect((await leaderboardOf(placeA.id)).items).toHaveLength(1);
    expect((await leaderboardOf(placeB.id)).items).toHaveLength(1);

    const missing = 'definitely-not-a-real-photo-id';
    const missingResponse = await originalRoute.GET(new Request(`${BASE}/x`), {
      params: Promise.resolve({ photoId: missing }),
    });
    expect(missingResponse.status).toBe(404);
    expectNoInternals(await missingResponse.text(), missing);
  });
});

describe('一张照片被两个地点引用时，各榜单只显示自己那条', () => {
  it('两个 Photo 行共享同一个 originalKey，磁盘上只有一份原件', async () => {
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    const rowA = await prisma.photo.findUniqueOrThrow({ where: { id: photoA.id } });

    // 手动造数据：ADR-015 明确 originalKey 不唯一，两位访客传同一张照片会
    // 各有一条 Photo 行、共用同一个内容寻址 blob。
    const siblingVisitor = await makeVisitor();
    const sibling = await prisma.photo.create({
      data: {
        placeId: placeB.id,
        visitorId: siblingVisitor.id,
        title: '地点 B 引用的同一份原件',
        description: '',
        originalKey: rowA.originalKey,
        preview400Key: rowA.preview400Key,
        preview1200Key: rowA.preview1200Key,
        originalFileName: 'landscape.jpg',
        originalMime: 'image/jpeg',
        originalByteLength: rowA.originalByteLength,
        originalSha256: rowA.originalSha256,
        width: rowA.width,
        height: rowA.height,
        status: 'READY',
        uploadIdempotencyKey: `scope-sibling-${process.pid}`,
      },
    });

    // 两边榜单各自只多出自己那条，彼此不可见。
    const a = await leaderboardOf(placeA.id);
    const b = await leaderboardOf(placeB.id);
    expect(a.items.map((item) => item.id).sort()).toEqual([photoA.id].sort());
    expect(b.items.map((item) => item.id).sort()).toEqual([photoB.id, sibling.id].sort());
    expect(a.items.some((item) => item.id === sibling.id)).toBe(false);

    // 磁盘上原件仍然只有一份：内容寻址，key 相同就是同一个文件。
    const { DiskStorage } = await import('@/server/storage/DiskStorage');
    const storage = DiskStorage.fromConfig();
    const shared = await fs.readFile(storage.absolutePath(rowA.originalKey));
    expect(shared.equals(Buffer.from(photoA.bytes))).toBe(true);

    const rows = await prisma.photo.findMany({
      where: { originalKey: rowA.originalKey },
      select: { id: true, originalKey: true },
    });
    expect(rows.map((row) => row.id).sort()).toEqual([photoA.id, sibling.id].sort());
    expect(new Set(rows.map((row) => row.originalKey)).size).toBe(1);

    // 两个 id 返回同一份字节（这正是共享原件的预期行为，不是越权）。
    const viaA = await mediaBytes(originalRoute, photoA.id, 'original');
    const viaSibling = await mediaBytes(originalRoute, sibling.id, 'original');
    expect(viaA.equals(viaSibling)).toBe(true);

    // rank 在合并了 B 的两条之后仍然连续，榜单不会因为共享而错位。
    expect(b.items.map((item) => item.rank)).toEqual([1, 2]);
  });
});

describe('HIDDEN 照片对外完全不存在（ADR-010）', () => {
  it('original / download / preview / HEAD 一律 404，且与「从未存在过」无法区分', async () => {
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();

    const victim = await ingestForHiddenCheck(prisma);

    // 下架后必须 404。
    const hiddenResponses: Array<[string, Response]> = [
      [
        'original',
        await originalRoute.GET(new Request(`${BASE}/x`), {
          params: Promise.resolve({ photoId: victim.id }),
        }),
      ],
      [
        'HEAD original',
        await originalRoute.HEAD(new Request(`${BASE}/x`), {
          params: Promise.resolve({ photoId: victim.id }),
        }),
      ],
      [
        'download',
        await downloadRoute.GET(new Request(`${BASE}/x`), {
          params: Promise.resolve({ photoId: victim.id }),
        }),
      ],
      [
        'preview/400',
        await previewRoute.GET(new Request(`${BASE}/x`), {
          params: Promise.resolve({ photoId: victim.id, size: '400' }),
        }),
      ],
      [
        'preview/1200',
        await previewRoute.GET(new Request(`${BASE}/x`), {
          params: Promise.resolve({ photoId: victim.id, size: '1200' }),
        }),
      ],
    ];
    for (const [route, response] of hiddenResponses) {
      expect(response.status, `${route} 对 HIDDEN 照片必须 404`).toBe(404);
      expect(response.headers.get('etag')).toBeNull();
      expect(response.headers.get('content-length')).toBeNull();
      expect(response.headers.get('content-disposition')).toBeNull();
      expect(response.headers.get('cache-control')).toBeNull();
    }
    const hiddenBody = await hiddenResponses[0]![1].text();

    // 关键断言：下架照片的 404 与一个从未存在过的 id 的 404 **逐字节相同**。
    // 如果实现里用了 403、或者消息里带上「已下架」之类字样，这里就会不同 ——
    // 而那个差别正好确认了「这张照片存在过、还被处理过」，对隐私/侵权下架是致命的。
    const missingId = 'this-photo-was-never-created';
    const missing = await originalRoute.GET(new Request(`${BASE}/x`), {
      params: Promise.resolve({ photoId: missingId }),
    });
    const missingBody = await missing.text();
    expect(hiddenBody).toBe(missingBody);
    expect(hiddenBody).not.toContain(victim.sha);

    expectNoInternals(hiddenBody, 'HIDDEN 照片的 404 响应体');

    // 榜单里也不出现它。
    const board = await leaderboardOf(placeA.id);
    expect(board.items.some((item) => item.id === victim.id)).toBe(false);
    expect(JSON.stringify(board)).not.toContain(victim.title);
  });

  it('被下架的照片在磁盘上仍然保留（原件永久归档，不是删除）', async () => {
    const { getPrisma } = await import('@/server/db/client');
    const { DiskStorage } = await import('@/server/storage/DiskStorage');
    const prisma = await getPrisma();

    const victim = await ingestForHiddenCheck(prisma);
    const row = await prisma.photo.findUniqueOrThrow({ where: { id: victim.id } });

    // ADR-010：下架不是删除。文件留着是为了「不能拿永久归档当拒绝删除的借口」，
    // 也就是随时可能被恢复或依法删除。
    const stored = await fs.readFile(DiskStorage.fromConfig().absolutePath(row.originalKey));
    expect(stored.equals(Buffer.from(victim.bytes))).toBe(true);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(victim.sha);
  });
});

/** 造一张属于地点 A 的照片，然后按 scripts/moderate-photo.mjs 的方式把它下架。 */
async function ingestForHiddenCheck(
  prisma: PrismaClient,
): Promise<{ id: string; sha: string; title: string; bytes: Uint8Array }> {
  const { ingestPhotoBytes } = await import('@/server/services/photo');
  const bytes = await fixture('extreme-wide.webp');
  const title = `待下架的照片 ${randomBytes(3).toString('hex')}`;
  const visitor = await makeVisitor();
  const photo = await ingestPhotoBytes({
    placeId: placeA.id,
    visitorId: visitor.id,
    bytes,
    fileName: 'extreme-wide.webp',
    mime: 'image/webp',
    title,
    idempotencyKey: `scope-hidden-${process.pid}-${randomBytes(6).toString('hex')}`,
  });

  // 与 scripts/moderate-photo.mjs `hide` 完全一致：只改 status，别的都不动。
  await prisma.photo.update({ where: { id: photo.id }, data: { status: 'HIDDEN' } });
  return { id: photo.id, sha: photo.sha256, title, bytes };
}
