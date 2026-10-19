import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ApiError } from '@/lib/errors';
import { createTestContext, migrateTestDatabase, type TestContext } from '../factories';

/**
 * 磁盘写失败的恢复能力（MASTER_PLAN Phase 03 验收项：「缺磁盘权限/写盘中断可恢复」，
 * 对应 E2E_SCENARIOS SEC-09「模拟磁盘已满/不可写 → 服务端 503 或可恢复失败，
 * UI 有反馈，原件不损坏」）。
 *
 * 与 photo-ingest.test.ts 里已有的「removes every written key when the database
 * insert fails」互补：那一条让**数据库**在写盘之后失败，验证回滚逻辑本身；这里
 * 反过来，让**磁盘**真的写不进去。三件事必须同时成立：
 *
 *   1. 失败被识别成「可重试的存储故障」（STORAGE_UNAVAILABLE / 503），而不是
 *      分类不明的 500 —— 磁盘满、权限被改、目录被占位都是运维能处理的瞬时状况，
 *      用户应该看到「稍后再试」，不该看到「服务器开小差了」。
 *   2. 失败不留下半成品：没有 Photo 行、上传临时目录不残留、媒体目录不出现
 *      孤儿文件（尤其是 `*.part` 中间文件）。
 *   3. 恢复（权限/路径修好后）下一次上传能成功 —— 这才是「可恢复」的含义：
 *      一次故障不能把进程或存储状态搞成不可用的状态。
 *
 * 平台说明（已在本机 Windows 10 + Node 24.13.0 上实测）：
 * `fs.chmod(dir, 0o500)` 在 Windows 上**不会**让目录不可写。NTFS 只对文件使用
 * 只读属性，目录上的只读位不做拦截，实测 chmod 之后 writeFile / mkdir /
 * open('wx') 全部照常成功。因此 Windows 分支改用「把目录换成同名普通文件」：
 * 任何需要 descend 进这个目录的写路径都会拿到 ENOTDIR，效果与 POSIX 上的
 * EACCES 等价，而且都是真实的文件系统失败，不是 mock。
 * 每个用例在使用前都会用 `probeWritable()` 证明封堵确实生效 —— 如果某个平台上
 * 这套手法不成立，用例会明确失败，而不是因为「写成功了、后面的断言碰巧没跑到」。
 */

let context: TestContext;
let placeId: string;

let mediaRoot: string;
let uploadTmpDir: string;

beforeAll(async () => {
  context = createTestContext('isle-storage-failure');
  context.applyEnv();
  await migrateTestDatabase(context.client);

  const { resetConfigCache } = await import('@/lib/config');
  const { resetPrismaForTests } = await import('@/server/db/client');
  resetConfigCache();
  await resetPrismaForTests();

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

  // 每个用例一套全新的媒体目录与上传临时目录：这样「媒体目录里没有孤儿文件」
  // 才能断言成空数组，而不是「和某个快照一样」——后者会漏掉跨用例互相干扰。
  const suffix = randomBytes(6).toString('hex');
  mediaRoot = path.join(context.root, `media-${suffix}`);
  uploadTmpDir = path.join(context.root, `tmp-${suffix}`);
  await fs.mkdir(mediaRoot, { recursive: true });
  await fs.mkdir(uploadTmpDir, { recursive: true });
  await pointConfigAt(mediaRoot, uploadTmpDir);
});

afterEach(async () => {
  // 无论如何都把配置指回本用例的合法目录，别让故障残留污染下一个用例。
  await pointConfigAt(mediaRoot, uploadTmpDir);
});

/** getConfig() 是记忆化的，不清缓存的话改 env 不会生效。 */
async function pointConfigAt(root: string, tmp: string): Promise<void> {
  const env = process.env as Record<string, string | undefined>;
  env['MEDIA_ROOT'] = root;
  env['UPLOAD_TMP_DIR'] = tmp;
  const { resetConfigCache } = await import('@/lib/config');
  resetConfigCache();
}

// --- 封堵与探针 ---------------------------------------------------------------

type Block = { restore: () => Promise<void>; blocker: string };

/** 让 `dir` 这个位置接受不到任何写入，返回封堵物自身的路径与恢复动作。 */
async function blockDirectoryWrites(dir: string): Promise<Block> {
  if (process.platform === 'win32') {
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.rm(dir, { recursive: true, force: true });
    await fs.writeFile(dir, 'blocked by storage-failure.test.ts');
    return {
      blocker: dir,
      restore: async () => {
        await fs.rm(dir, { force: true });
        await fs.mkdir(dir, { recursive: true });
      },
    };
  }
  const previous = (await fs.stat(dir)).mode & 0o777;
  await fs.chmod(dir, 0o500);
  return {
    blocker: dir,
    restore: async () => {
      await fs.chmod(dir, previous);
    },
  };
}

/** 这个位置现在还能不能写入。用来证明封堵手法在本平台上真的生效。 */
async function probeWritable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.write-probe-${randomBytes(6).toString('hex')}`);
  try {
    await fs.mkdir(probe, { recursive: true });
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probe, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function expectBlocked(dir: string, what: string): Promise<void> {
  expect(await probeWritable(dir), `${what}：封堵必须真的生效，否则本用例没有测到东西`).toBe(false);
}

// --- 断言工具 -----------------------------------------------------------------

async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else out.push(full);
  }
  return out;
}

/** 媒体目录下的全部文件，排除本用例自己造的封堵物。 */
async function orphanFiles(exclude: string[] = []): Promise<string[]> {
  const files = await listFilesRecursive(mediaRoot);
  return files.filter((file) => !exclude.includes(file)).sort();
}

async function temporaryLeftovers(): Promise<string[]> {
  return (await fs.readdir(uploadTmpDir)).sort();
}

/** 每个用例生成一张全新的图，避免内容寻址复用上一条用例留下的 blob。 */
async function uniqueJpeg(): Promise<Uint8Array> {
  const seed = randomBytes(4).readUInt32BE(0);
  return new Uint8Array(
    await sharp({
      create: {
        width: 64,
        height: 48,
        channels: 3,
        background: { r: seed % 256, g: (seed >> 8) % 256, b: (seed >> 16) % 256 },
      },
    })
      .jpeg()
      .toBuffer(),
  );
}

async function makeVisitor(): Promise<string> {
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();
  const tag = `storage-failure-${process.pid}-${randomBytes(6).toString('hex')}`;
  const visitor = await prisma.visitor.create({
    data: {
      tokenHash: createHash('sha256').update(tag).digest('hex'),
      displayCode: createHash('md5').update(tag).digest('hex').slice(0, 6),
    },
  });
  return visitor.id;
}

type Attempt = { ok: boolean; photoId: string | undefined; error: unknown };

async function attemptUpload(
  bytes: Uint8Array,
  visitorId: string,
  label: string,
): Promise<Attempt> {
  const { ingestPhotoBytes } = await import('@/server/services/photo');
  try {
    const photo = await ingestPhotoBytes({
      placeId,
      visitorId,
      bytes,
      fileName: `${label}.jpg`,
      mime: 'image/jpeg',
      idempotencyKey: `${label}-${process.pid}-${randomBytes(6).toString('hex')}`,
    });
    return { ok: true, photoId: photo.id, error: undefined };
  } catch (error) {
    return { ok: false, photoId: undefined, error };
  }
}

/**
 * 磁盘写失败必须是可重试的存储故障，而不是分类不明的 500（SEC-09）。
 *
 * 用 soft 断言：即使分类本身是错的，也要让后面「没有留下半成品 / 能恢复」那几条
 * 硬断言继续跑完，这样一次运行就能给出完整缺陷清单，而不是只暴露第一个症状。
 */
function expectRetryableStorageError(error: unknown): void {
  expect.soft(error, '磁盘写失败必须被识别为存储故障').toBeInstanceOf(ApiError);
  const apiError = error as ApiError;
  expect.soft(apiError?.code).toBe('STORAGE_UNAVAILABLE');
  expect.soft(apiError?.status).toBe(503);
}

/** 一次写入失败之后，这套系统必须没有留下任何半成品。 */
async function expectNoHalfProduct(
  visitorId: string,
  sha: string,
  blockers: string[],
): Promise<void> {
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();
  const { DiskStorage } = await import('@/server/storage/DiskStorage');
  const storage = DiskStorage.fromConfig();

  // 1. 数据库里没有 Photo 行。
  expect(await prisma.photo.count({ where: { visitorId } })).toBe(0);

  // 2. 上传临时目录没有残留。
  expect(await temporaryLeftovers()).toEqual([]);

  // 3. 本该写入的原件与两张预览都不存在。
  await expect(
    fs.stat(storage.absolutePath(DiskStorage.buildOriginalKey(sha, 'image/jpeg'))),
  ).rejects.toThrow();
  for (const size of [400, 1200]) {
    await expect(
      fs.stat(storage.absolutePath(DiskStorage.buildPreviewKey(sha, size))),
    ).rejects.toThrow();
  }

  // 4. 媒体目录里没有任何孤儿文件（封堵物本身除外）——尤其没有 `*.part`。
  expect(await orphanFiles(blockers)).toEqual([]);
}

/** 恢复之后同一次内容再传一遍必须成功，且原件与两张预览真的落盘。 */
async function expectUploadRecovered(photoId: string, bytes: Uint8Array): Promise<void> {
  const { getPrisma } = await import('@/server/db/client');
  const { DiskStorage } = await import('@/server/storage/DiskStorage');
  const prisma = await getPrisma();
  const row = await prisma.photo.findUnique({ where: { id: photoId } });
  const storage = DiskStorage.fromConfig();

  expect(row?.status).toBe('READY');
  expect(row?.originalSha256).toBe(createHash('sha256').update(bytes).digest('hex'));

  const stored = await fs.readFile(storage.absolutePath(row!.originalKey));
  expect(stored.equals(Buffer.from(bytes)), '原件字节必须与上传的完全一致').toBe(true);

  for (const key of [row!.preview400Key, row!.preview1200Key]) {
    expect(key, '恢复后的照片必须同时拥有 400 与 1200 两张预览').toBeTruthy();
    await expect(fs.stat(storage.absolutePath(key!))).resolves.toBeDefined();
  }
}

// --- 用例 ---------------------------------------------------------------------

describe('磁盘写失败不会留下半成品，且可恢复', () => {
  it('目录不可写时拒绝上传，权限恢复后可以再传', async () => {
    const bytes = await uniqueJpeg();
    const sha = createHash('sha256').update(bytes).digest('hex');
    const visitorId = await makeVisitor();

    const block = await blockDirectoryWrites(path.join(mediaRoot, 'original'));
    await expectBlocked(block.blocker, 'original 目录不可写');

    const attempt = await attemptUpload(bytes, visitorId, 'readonly-dir');
    expect(attempt.ok).toBe(false);
    expectRetryableStorageError(attempt.error);

    await expectNoHalfProduct(visitorId, sha, [block.blocker]);

    await block.restore();
    const retry = await attemptUpload(bytes, visitorId, 'readonly-dir-retry');
    expect(retry.ok, '恢复权限后必须能再次上传成功').toBe(true);
    await expectUploadRecovered(retry.photoId!, bytes);
  });

  it('MEDIA_ROOT 指向一个普通文件而不是目录时拒绝上传', async () => {
    const bytes = await uniqueJpeg();
    const visitorId = await makeVisitor();

    // 「路径指向非法位置」最真实的形态：配置里的 MEDIA_ROOT 是个文件。
    const blocker = path.join(context.root, `not-a-directory-${randomBytes(4).toString('hex')}`);
    await fs.writeFile(blocker, 'this is a file, not a media root');
    await pointConfigAt(blocker, uploadTmpDir);

    const attempt = await attemptUpload(bytes, visitorId, 'media-root-is-file');
    expect(attempt.ok).toBe(false);
    expectRetryableStorageError(attempt.error);

    const { getPrisma } = await import('@/server/db/client');
    expect(await (await getPrisma()).photo.count({ where: { visitorId } })).toBe(0);
    // 上传临时目录是好的，所以故障点在存储而不是接收；临时文件仍必须被清掉。
    expect(await temporaryLeftovers()).toEqual([]);
    // MEDIA_ROOT 确实是个文件，里面什么都列不出来 —— 一次字节都没写进去。
    expect((await fs.stat(blocker)).isFile()).toBe(true);
    expect(await listFilesRecursive(blocker)).toEqual([]);

    await pointConfigAt(mediaRoot, uploadTmpDir);
    const retry = await attemptUpload(bytes, visitorId, 'media-root-restored');
    expect(retry.ok, '把 MEDIA_ROOT 指回合法目录后必须能上传成功').toBe(true);
    await expectUploadRecovered(retry.photoId!, bytes);
    await fs.rm(blocker, { force: true });
  });

  it('MEDIA_ROOT 指向不存在的盘符时拒绝上传', async () => {
    const bytes = await uniqueJpeg();
    const visitorId = await makeVisitor();

    // 挂载点掉了 / 盘符没插上：连递归 mkdir 都建不出来。
    const absent =
      process.platform === 'win32' ? 'Q:\\isle-media-absent' : '/proc/isle-media-absent';
    await pointConfigAt(absent, uploadTmpDir);
    await expectBlocked(absent, '不存在的盘符');

    const attempt = await attemptUpload(bytes, visitorId, 'absent-volume');
    expect(attempt.ok).toBe(false);
    expectRetryableStorageError(attempt.error);

    const { getPrisma } = await import('@/server/db/client');
    expect(await (await getPrisma()).photo.count({ where: { visitorId } })).toBe(0);
    expect(await temporaryLeftovers()).toEqual([]);

    await pointConfigAt(mediaRoot, uploadTmpDir);
    const retry = await attemptUpload(bytes, visitorId, 'absent-volume-restored');
    expect(retry.ok).toBe(true);
    await expectUploadRecovered(retry.photoId!, bytes);
  });

  it('原件已落盘后预览写失败，必须把原件一起回滚（写盘中断）', async () => {
    const bytes = await uniqueJpeg();
    const sha = createHash('sha256').update(bytes).digest('hex');
    const visitorId = await makeVisitor();

    // 只封死 preview/400：原件写得进去，第一张预览写不进去。这条是「写盘中断」
    // 的真实形态 —— 故障发生在已经落盘一部分之后，最容易留下孤儿。
    const block = await blockDirectoryWrites(path.join(mediaRoot, 'preview', '400'));
    await expectBlocked(block.blocker, 'preview/400 目录不可写');

    const attempt = await attemptUpload(bytes, visitorId, 'interrupted-write');
    expect(attempt.ok).toBe(false);
    expectRetryableStorageError(attempt.error);

    await expectNoHalfProduct(visitorId, sha, [block.blocker]);

    await block.restore();
    const retry = await attemptUpload(bytes, visitorId, 'interrupted-write-retry');
    expect(retry.ok).toBe(true);
    await expectUploadRecovered(retry.photoId!, bytes);
  });

  it('写盘中断之后不会让下一次上传复用到一个半截的原件', async () => {
    const bytes = await uniqueJpeg();
    const sha = createHash('sha256').update(bytes).digest('hex');
    const visitorId = await makeVisitor();

    const block = await blockDirectoryWrites(path.join(mediaRoot, 'preview', '400'));
    await expectBlocked(block.blocker, 'preview/400 目录不可写');
    expect((await attemptUpload(bytes, visitorId, 'no-partial-reuse')).ok).toBe(false);
    await block.restore();

    // 内容寻址会在 key 已存在时复用 blob。若回滚没把原件删干净，这一次上传就会
    // 直接把那份残缺文件当成「已归档原件」交给用户 —— 灯箱里会是一张坏图。
    const retry = await attemptUpload(bytes, visitorId, 'no-partial-reuse-retry');
    expect(retry.ok).toBe(true);

    const { DiskStorage } = await import('@/server/storage/DiskStorage');
    const onDisk = await fs.readFile(
      DiskStorage.fromConfig().absolutePath(DiskStorage.buildOriginalKey(sha, 'image/jpeg')),
    );
    expect(onDisk.byteLength).toBe(bytes.byteLength);
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(sha);
  });

  it('连续两次故障之后系统仍然可用', async () => {
    const bytes = await uniqueJpeg();
    const visitorId = await makeVisitor();

    for (let round = 0; round < 2; round += 1) {
      const block = await blockDirectoryWrites(path.join(mediaRoot, 'original'));
      await expectBlocked(block.blocker, `第 ${round + 1} 次故障封堵`);
      const failed = await attemptUpload(bytes, visitorId, `double-fault-${round}`);
      expect(failed.ok).toBe(false);
      expectRetryableStorageError(failed.error);
      await block.restore();
    }

    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    expect(await prisma.photo.count({ where: { visitorId } })).toBe(0);
    expect(await temporaryLeftovers()).toEqual([]);
    expect(await orphanFiles()).toEqual([]);

    const ok = await attemptUpload(bytes, visitorId, 'double-fault-recovered');
    expect(ok.ok).toBe(true);
    await expectUploadRecovered(ok.photoId!, bytes);
  });
});
