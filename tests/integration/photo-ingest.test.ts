import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createTestContext, migrateTestDatabase, type TestContext } from '../factories';

/**
 * Photo ingestion (DATA_API_STORAGE §4, §6).
 *
 * These tests assert the product's central promise directly: the bytes that were
 * uploaded are the bytes on disk. Not "the image looks the same" — the SHA-256
 * of the request body, the file under MEDIA_ROOT and the row in the database
 * must be the same value.
 */

let context: TestContext;
let fixturesDir: string;

beforeAll(async () => {
  fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');

  context = createTestContext('isle-photo');
  context.applyEnv();
  await migrateTestDatabase(context.client);

  const { resetConfigCache } = await import('@/lib/config');
  const { resetPrismaForTests } = await import('@/server/db/client');
  resetConfigCache();
  await resetPrismaForTests();

  const { seedDefaultPlace } = await import('@/server/services/place');
  await seedDefaultPlace();
});

afterAll(async () => {
  const { resetPrismaForTests } = await import('@/server/db/client');
  await resetPrismaForTests();
  await context.cleanup();
});

let counter = 0;
const key = (label: string) => `${label}-${process.pid}-${counter++}`;

async function makeVisitor(): Promise<{ id: string; displayCode: string }> {
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();
  return prisma.visitor.create({
    data: {
      tokenHash: createHash('sha256').update(key('visitor')).digest('hex'),
      displayCode: createHash('md5').update(key('code')).digest('hex').slice(0, 6),
    },
  });
}

async function fixture(name: string): Promise<Uint8Array> {
  return new Uint8Array(await fs.readFile(path.join(fixturesDir, name)));
}

async function firstPlaceId(): Promise<string> {
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();
  const place = await prisma.place.findUnique({ where: { slug: 'guishan-island' } });
  if (place === null) throw new Error('default place missing');
  return place.id;
}

beforeEach(async () => {
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();
  // Clear photos between cases; originals are removed explicitly in the tests
  // that assert on-disk cleanup.
  await prisma.vote.deleteMany();
  await prisma.photo.deleteMany();
});

describe('original bytes are preserved exactly', () => {
  it('stores an uploaded JPEG whose SHA-256 equals the input, the disk file and the database row', async () => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');
    const { getPrisma } = await import('@/server/db/client');
    const { DiskStorage } = await import('@/server/storage/DiskStorage');

    const bytes = await fixture('landscape.jpg');
    const inputSha = createHash('sha256').update(bytes).digest('hex');

    const visitor = await makeVisitor();
    const photo = await ingestPhotoBytes({
      placeId: await firstPlaceId(),
      visitorId: visitor.id,
      bytes,
      fileName: 'landscape.jpg',
      mime: 'image/jpeg',
      title: '海上的两座灯塔',
      idempotencyKey: key('sha'),
    });

    // 1. Ingestor reports the input hash.
    expect(photo.sha256).toBe(inputSha);

    // 2. The row agrees.
    const prisma = await getPrisma();
    const row = await prisma.photo.findUnique({ where: { id: photo.id } });
    expect(row?.originalSha256).toBe(inputSha);
    expect(row?.originalByteLength).toBe(bytes.byteLength);
    expect(row?.status).toBe('READY');

    // 3. The bytes on disk agree, byte for byte.
    const storage = DiskStorage.fromConfig();
    const onDisk = await fs.readFile(storage.absolutePath(row!.originalKey));
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(inputSha);
    expect(onDisk.byteLength).toBe(bytes.byteLength);
    expect(onDisk.equals(Buffer.from(bytes))).toBe(true);
  });

  it('preserves PNG as PNG and never silently re-encodes to WebP', async () => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');
    const { getPrisma } = await import('@/server/db/client');
    const { DiskStorage } = await import('@/server/storage/DiskStorage');

    const bytes = await fixture('square.png');
    const visitor = await makeVisitor();

    const photo = await ingestPhotoBytes({
      placeId: await firstPlaceId(),
      visitorId: visitor.id,
      bytes,
      fileName: 'square.png',
      mime: 'image/png',
      idempotencyKey: key('png'),
    });

    const prisma = await getPrisma();
    const row = await prisma.photo.findUnique({ where: { id: photo.id } });
    expect(row?.originalMime).toBe('image/png');

    const storage = DiskStorage.fromConfig();
    const onDisk = await fs.readFile(storage.absolutePath(row!.originalKey));
    expect(onDisk.equals(Buffer.from(bytes))).toBe(true);
    // RIFF/WEBP magic would mean it was converted.
    expect(onDisk.subarray(0, 4).toString('ascii')).not.toBe('RIFF');
    expect(onDisk.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('keeps EXIF, including GPS, in the original while previews drop it', async () => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');
    const { getPrisma } = await import('@/server/db/client');
    const { DiskStorage } = await import('@/server/storage/DiskStorage');

    const bytes = await fixture('gps-exif.jpg');
    const visitor = await makeVisitor();

    const photo = await ingestPhotoBytes({
      placeId: await firstPlaceId(),
      visitorId: visitor.id,
      bytes,
      fileName: 'gps-exif.jpg',
      mime: 'image/jpeg',
      idempotencyKey: key('gps'),
    });

    const prisma = await getPrisma();
    const row = await prisma.photo.findUnique({ where: { id: photo.id } });
    const storage = DiskStorage.fromConfig();

    // Original keeps its bytes, so its EXIF (and therefore its GPS) survives.
    const original = await fs.readFile(storage.absolutePath(row!.originalKey));
    expect(original.equals(Buffer.from(bytes))).toBe(true);
    const originalMeta = await sharp(original).metadata();
    expect(originalMeta.exif).toBeDefined();

    // Derivatives are re-encoded and carry no metadata at all.
    for (const keyPath of [row!.preview400Key, row!.preview1200Key]) {
      expect(keyPath).toBeTruthy();
      const preview = await fs.readFile(storage.absolutePath(keyPath!));
      const previewMeta = await sharp(preview).metadata();
      expect(previewMeta.format).toBe('webp');
      expect(previewMeta.exif).toBeUndefined();
    }
  });
});

describe('derivatives never crop or upscale', () => {
  it.each([
    ['landscape.jpg', 400, 225, 1200, 675],
    ['portrait.jpg', 225, 400, 675, 1200],
    ['square.png', 400, 400, 1000, 1000],
    ['extreme-wide.webp', 400, 80, 1200, 240],
  ])('%s produces contained previews at both widths', async (name, w400, h400, w1200, h1200) => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');
    const { getPrisma } = await import('@/server/db/client');
    const { DiskStorage } = await import('@/server/storage/DiskStorage');

    const bytes = await fixture(name);
    const visitor = await makeVisitor();
    const photo = await ingestPhotoBytes({
      placeId: await firstPlaceId(),
      visitorId: visitor.id,
      bytes,
      fileName: name,
      mime: name.endsWith('.png')
        ? 'image/png'
        : name.endsWith('.webp')
          ? 'image/webp'
          : 'image/jpeg',
      idempotencyKey: key('deriv'),
    });

    const prisma = await getPrisma();
    const row = await prisma.photo.findUnique({ where: { id: photo.id } });
    const storage = DiskStorage.fromConfig();

    const meta400 = await sharp(
      await fs.readFile(storage.absolutePath(row!.preview400Key!)),
    ).metadata();
    const meta1200 = await sharp(
      await fs.readFile(storage.absolutePath(row!.preview1200Key!)),
    ).metadata();

    expect([meta400.width, meta400.height]).toEqual([w400, h400]);
    expect([meta1200.width, meta1200.height]).toEqual([w1200, h1200]);

    // Aspect ratio is preserved: nothing was cropped.
    const source = await sharp(bytes).metadata();
    const sourceRatio = (source.width ?? 1) / (source.height ?? 1);
    expect(meta400.width! / meta400.height!).toBeCloseTo(sourceRatio, 1);
  });

  it('does not enlarge a photo smaller than the preview width', async () => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');
    const { getPrisma } = await import('@/server/db/client');
    const { DiskStorage } = await import('@/server/storage/DiskStorage');

    const bytes = await fixture('small.jpeg'); // 80x80
    const visitor = await makeVisitor();
    const photo = await ingestPhotoBytes({
      placeId: await firstPlaceId(),
      visitorId: visitor.id,
      bytes,
      fileName: 'small.jpeg',
      mime: 'image/jpeg',
      idempotencyKey: key('small'),
    });

    const prisma = await getPrisma();
    const row = await prisma.photo.findUnique({ where: { id: photo.id } });
    const storage = DiskStorage.fromConfig();

    for (const keyPath of [row!.preview400Key!, row!.preview1200Key!]) {
      const meta = await sharp(await fs.readFile(storage.absolutePath(keyPath))).metadata();
      expect(meta.width).toBe(80);
      expect(meta.height).toBe(80);
    }
  });

  it('records display dimensions after applying EXIF Orientation=6', async () => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');
    const { getPrisma } = await import('@/server/db/client');

    // Fixture is stored 1200x1600 with Orientation=6, which rotates it for display.
    const bytes = await fixture('exif-rotate.jpg');
    const visitor = await makeVisitor();
    const photo = await ingestPhotoBytes({
      placeId: await firstPlaceId(),
      visitorId: visitor.id,
      bytes,
      fileName: 'exif-rotate.jpg',
      mime: 'image/jpeg',
      idempotencyKey: key('exif'),
    });

    expect(photo.width).toBe(1600);
    expect(photo.height).toBe(1200);

    const prisma = await getPrisma();
    const row = await prisma.photo.findUnique({ where: { id: photo.id } });
    expect(row?.width).toBe(1600);
    expect(row?.height).toBe(1200);
  });
});

describe('rejections leave nothing behind', () => {
  it('refuses a text file with an image extension and stores nothing', async () => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');
    const { getPrisma } = await import('@/server/db/client');

    const bytes = await fixture('invalid-text.jpg');
    const visitor = await makeVisitor();

    await expect(
      ingestPhotoBytes({
        placeId: await firstPlaceId(),
        visitorId: visitor.id,
        bytes,
        fileName: 'evil.jpg',
        mime: 'image/jpeg',
        idempotencyKey: key('text'),
      }),
    ).rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });

    const prisma = await getPrisma();
    expect(await prisma.photo.count({ where: { visitorId: visitor.id } })).toBe(0);
  });

  it('refuses a corrupt JPEG whose header is valid but whose body is truncated', async () => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');
    const { getPrisma } = await import('@/server/db/client');

    const bytes = await fixture('corrupt.jpg');
    const visitor = await makeVisitor();

    await expect(
      ingestPhotoBytes({
        placeId: await firstPlaceId(),
        visitorId: visitor.id,
        bytes,
        fileName: 'corrupt.jpg',
        mime: 'image/jpeg',
        idempotencyKey: key('corrupt'),
      }),
    ).rejects.toThrow();

    const prisma = await getPrisma();
    expect(await prisma.photo.count({ where: { visitorId: visitor.id } })).toBe(0);
  });

  it('refuses an SVG carrying a script', async () => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');
    const { getPrisma } = await import('@/server/db/client');

    const bytes = await fixture('script.svg');
    const visitor = await makeVisitor();

    await expect(
      ingestPhotoBytes({
        placeId: await firstPlaceId(),
        visitorId: visitor.id,
        bytes,
        fileName: 'payload.svg',
        mime: 'image/svg+xml',
        idempotencyKey: key('svg'),
      }),
    ).rejects.toThrow();

    const prisma = await getPrisma();
    expect(await prisma.photo.count({ where: { visitorId: visitor.id } })).toBe(0);
  });

  it('refuses a declared type that disagrees with the actual bytes', async () => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');

    const bytes = await fixture('landscape.jpg'); // really a JPEG
    const visitor = await makeVisitor();

    await expect(
      ingestPhotoBytes({
        placeId: await firstPlaceId(),
        visitorId: visitor.id,
        bytes,
        fileName: 'lies.png',
        mime: 'image/png',
        idempotencyKey: key('mismatch'),
      }),
    ).rejects.toMatchObject({ status: 415 });
  });

  it('removes every written key when the database insert fails', async () => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');
    const { getPrisma } = await import('@/server/db/client');
    const { DiskStorage } = await import('@/server/storage/DiskStorage');
    const { getConfig } = await import('@/lib/config');

    const config = getConfig();
    const bytes = await fixture('landscape.jpg');
    const visitor = await makeVisitor();
    const inputSha = createHash('sha256').update(bytes).digest('hex');

    // By this point the original and both previews have already been written.
    // The foreign key on Photo.placeId rejects the insert, so the failure lands
    // exactly where a rollback has to do real work.
    await expect(
      ingestPhotoBytes({
        placeId: 'no-such-place-id',
        visitorId: visitor.id,
        bytes,
        fileName: 'landscape.jpg',
        mime: 'image/jpeg',
        idempotencyKey: key('rollback'),
      }),
    ).rejects.toThrow();

    const prisma = await getPrisma();
    expect(await prisma.photo.count({ where: { visitorId: visitor.id } })).toBe(0);

    const storage = DiskStorage.fromConfig();
    const originalKey = DiskStorage.buildOriginalKey(inputSha, 'image/jpeg');
    await expect(fs.stat(storage.absolutePath(originalKey))).rejects.toThrow();
    for (const size of [400, 1200]) {
      await expect(
        fs.stat(storage.absolutePath(DiskStorage.buildPreviewKey(inputSha, size))),
      ).rejects.toThrow();
    }

    // The upload scratch directory is empty again.
    const leftover = await fs.readdir(config.uploadTmpDir);
    expect(leftover).toHaveLength(0);
  });
});

describe('idempotent upload', () => {
  it('returns the same photo for a repeated idempotency key without writing a second copy', async () => {
    const { ingestPhotoBytes } = await import('@/server/services/photo');
    const { getPrisma } = await import('@/server/db/client');
    const { DiskStorage } = await import('@/server/storage/DiskStorage');

    const bytes = await fixture('landscape.jpg');
    const visitor = await makeVisitor();
    const idempotencyKey = key('idem');
    const placeId = await firstPlaceId();

    const first = await ingestPhotoBytes({
      placeId,
      visitorId: visitor.id,
      bytes,
      fileName: 'landscape.jpg',
      mime: 'image/jpeg',
      idempotencyKey,
    });
    const second = await ingestPhotoBytes({
      placeId,
      visitorId: visitor.id,
      bytes,
      fileName: 'landscape.jpg',
      mime: 'image/jpeg',
      idempotencyKey,
    });

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.sha256).toBe(first.sha256);

    const prisma = await getPrisma();
    expect(await prisma.photo.count({ where: { visitorId: visitor.id } })).toBe(1);

    // The replay wrote nothing: the original file count is unchanged and the
    // row still points at the single blob for this content.
    const storage = DiskStorage.fromConfig();
    const originals = await listFilesRecursive(storage.roots.originalDir);
    const inputSha = createHash('sha256').update(bytes).digest('hex');
    const matching = originals.filter((file) => file.includes(inputSha));
    expect(matching).toHaveLength(1);

    const row = await prisma.photo.findUnique({ where: { id: first.id } });
    expect(row?.originalKey).toBe(DiskStorage.buildOriginalKey(inputSha, 'image/jpeg'));
  });
});

describe('storage immutability', () => {
  it('reuses the existing blob when identical bytes are stored again', async () => {
    const { DiskStorage, streamFromBuffer } = await import('@/server/storage/DiskStorage');
    const storage = DiskStorage.fromConfig();

    // Bytes nobody has uploaded in this run, so the key is genuinely new.
    const bytes = new Uint8Array(
      await sharp({
        create: { width: 64, height: 48, channels: 3, background: { r: 12, g: 200, b: 90 } },
      })
        .jpeg()
        .toBuffer(),
    );
    const sha = createHash('sha256').update(bytes).digest('hex');
    const keyPath = DiskStorage.buildOriginalKey(sha, 'image/jpeg');

    const first = await storage.putOriginal(keyPath, streamFromBuffer(bytes));
    expect(first.sha256).toBe(sha);
    expect(first.byteLength).toBe(bytes.byteLength);

    const before = await fs.stat(storage.absolutePath(keyPath));

    // Storing the same content again is a no-op, not an error: two friends may
    // legitimately upload the identical photo.
    const second = await storage.putOriginal(keyPath, streamFromBuffer(bytes));
    expect(second.sha256).toBe(sha);

    const after = await fs.readFile(storage.absolutePath(keyPath));
    expect(after.equals(Buffer.from(bytes))).toBe(true);
    // The original file was not rewritten.
    expect((await fs.stat(storage.absolutePath(keyPath))).ino).toBe(before.ino);
  });

  it('refuses to store different content under an existing key', async () => {
    const { DiskStorage, streamFromBuffer } = await import('@/server/storage/DiskStorage');
    const storage = DiskStorage.fromConfig();

    const contentA = new Uint8Array(
      await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 1, g: 2, b: 3 } },
      })
        .jpeg()
        .toBuffer(),
    );
    const contentB = new Uint8Array(
      await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 250, g: 2, b: 3 } },
      })
        .jpeg()
        .toBuffer(),
    );

    // Forge a key that claims content A while carrying content B. Content-
    // addressing means this cannot arise naturally, so the guard has to hold
    // against it anyway.
    const shaOfA = createHash('sha256').update(contentA).digest('hex');
    const keyPath = DiskStorage.buildOriginalKey(shaOfA, 'image/jpeg');

    await storage.putOriginal(keyPath, streamFromBuffer(contentA));

    await expect(storage.putOriginal(keyPath, streamFromBuffer(contentB))).rejects.toThrow(
      /refusing to overwrite/,
    );

    // The archived bytes are untouched.
    const onDisk = await fs.readFile(storage.absolutePath(keyPath));
    expect(onDisk.equals(Buffer.from(contentA))).toBe(true);
  });

  it('rejects a key containing traversal or an unexpected root', async () => {
    const { DiskStorage } = await import('@/server/storage/DiskStorage');
    const storage = DiskStorage.fromConfig();

    for (const bad of [
      '../../etc/passwd',
      'original/../preview/400/x.jpg',
      'preview/400/xx/x.jpg',
      'original/ZZ/not-hex.jpg',
      '/etc/passwd',
    ]) {
      expect(() => storage.absolutePath(bad), bad).toThrow();
    }
  });
});

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
