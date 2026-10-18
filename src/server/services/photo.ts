import { createReadStream, promises as fs } from 'node:fs';
import { ApiError } from '@/lib/errors';
import { getConfig, PREVIEW_SIZES, type AllowedImageMime } from '@/lib/config';
import { safeFilename } from '@/lib/place-name';
import { getPrisma } from '@/server/db/client';
import { DiskStorage, streamFromBuffer } from '@/server/storage/DiskStorage';
import { inspectImage, renderPreview } from '@/server/image/metadata';
import { assertDeclaredTypeMatches, mimeForFormat, sniffImage } from '@/server/image/validate';
import type { StreamedFile } from '@/server/image/multipart';

/**
 * Photo ingestion (DATA_API_STORAGE §4.2).
 *
 * Order matters and is enforced here rather than in the route:
 *
 *   1. idempotency short-circuit — a retried request must not duplicate
 *   2. sniff the real type from bytes, never from the declared Content-Type
 *   3. inspect: real decode, dimensions, EXIF orientation, pixel budget
 *   4. move the bytes into an immutable storage key, untouched
 *   5. render the 400/1200 derivatives
 *   6. insert the READY row
 *
 * A failure at any step leaves no READY row and no orphan file: already-written
 * keys are removed and the temp file is cleaned up.
 */

export type IngestInput = {
  placeId: string;
  visitorId: string;
  file: StreamedFile;
  title: string;
  description: string;
  idempotencyKey: string;
};

export type IngestedPhoto = {
  id: string;
  title: string;
  description: string;
  width: number;
  height: number;
  byteLength: number;
  sha256: string;
  mime: AllowedImageMime;
  fileName: string;
  /** True when an idempotent replay matched an existing READY photo. */
  reused: boolean;
};

export const TITLE_MAX_LENGTH = 80;
export const DESCRIPTION_MAX_LENGTH = 300;

/**
 * Derive a title from the uploaded filename when the client sent none
 * (FRONTEND_UX §3.5): strip any directory component and the extension, collapse
 * whitespace, then bound the length.
 */
export function titleFromFileName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const withoutExtension = dot > 0 ? base.slice(0, dot) : base;
  const trimmed = withoutExtension.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) return '未命名照片';
  return trimmed.slice(0, TITLE_MAX_LENGTH);
}

function validateTitle(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '未命名照片';
  if (trimmed.length > TITLE_MAX_LENGTH) {
    throw ApiError.badRequest(`照片标题最多 ${TITLE_MAX_LENGTH} 个字`);
  }
  return trimmed;
}

function validateDescription(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
    throw ApiError.badRequest(`照片说明最多 ${DESCRIPTION_MAX_LENGTH} 个字`);
  }
  return trimmed;
}

function toPublicPhoto(
  row: {
    id: string;
    title: string;
    description: string;
    width: number;
    height: number;
    originalByteLength: number;
    originalSha256: string;
    originalMime: string;
    originalFileName: string;
  },
  reused: boolean,
): IngestedPhoto {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    width: row.width,
    height: row.height,
    byteLength: row.originalByteLength,
    sha256: row.originalSha256,
    mime: row.originalMime as AllowedImageMime,
    fileName: row.originalFileName,
    reused,
  };
}

export async function ingestPhoto(input: IngestInput): Promise<IngestedPhoto> {
  const config = getConfig();
  const prisma = await getPrisma();
  const storage = DiskStorage.fromConfig();
  const { file } = input;

  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0) {
    throw ApiError.badRequest('缺少 idempotencyKey');
  }
  if (idempotencyKey.length > 128) {
    throw ApiError.badRequest('idempotencyKey 过长');
  }

  // 1. Idempotent replay: a retried request returns the existing photo rather
  //    than writing a second copy to disk.
  const existing = await prisma.photo.findUnique({
    where: {
      visitorId_uploadIdempotencyKey: {
        visitorId: input.visitorId,
        uploadIdempotencyKey: idempotencyKey,
      },
    },
  });
  if (existing !== null && existing.status === 'READY') {
    return toPublicPhoto(existing, true);
  }

  const writtenKeys: string[] = [];

  try {
    // 2. Real type from the leading bytes.
    const sniffed = sniffImage(file.head);
    const mime = sniffed.mime as AllowedImageMime;
    assertDeclaredTypeMatches(file.declaredMime, mime);

    // Bounded read: the stream already refused anything over maxUploadBytes.
    const bytes = new Uint8Array(await fs.readFile(file.tempPath));

    // 3. Real decode, dimensions, orientation, pixel budget.
    const info = await inspectImage(bytes, {
      maxPixels: config.maxImagePixels,
      maxBytes: config.maxUploadBytes,
    });

    const title = validateTitle(input.title || titleFromFileName(file.declaredFileName));
    const description = validateDescription(input.description);
    const fileName = safeFilename(file.declaredFileName, `photo.${mimeForFormat(sniffed.format)}`);

    // 4. Store the original byte-for-byte. The key is derived from the SHA-256
    //    of the upload, and putOriginal streams the temp file through without
    //    re-encoding, fsyncing and refusing to overwrite an existing key.
    const originalKey = DiskStorage.buildOriginalKey(file.sha256, mime);
    const stored = await storage.putOriginal(originalKey, createReadStream(file.tempPath));
    writtenKeys.push(originalKey);

    // Second, independent hash of the same bytes. They were computed by
    // different code paths (upload stream vs storage write), so a mismatch means
    // real corruption and must abort the upload.
    if (stored.sha256 !== file.sha256) {
      throw ApiError.storageUnavailable('照片写入校验失败，已回滚');
    }
    if (stored.byteLength !== file.byteLength) {
      throw ApiError.storageUnavailable('照片写入后大小不一致，已回滚');
    }

    // 5. Derivatives: independent files, never cropped, never upscaled, and
    //    stripped of EXIF so a preview can never leak GPS.
    const previewKeys: Partial<Record<(typeof PREVIEW_SIZES)[number], string>> = {};
    for (const size of PREVIEW_SIZES) {
      const preview = await renderPreview(bytes, size, { maxPixels: config.maxImagePixels });
      const key = DiskStorage.buildPreviewKey(file.sha256, size);
      await storage.putDerivative(key, new Uint8Array(preview));
      writtenKeys.push(key);
      previewKeys[size] = key;
    }

    await fs.rm(file.tempPath, { force: true });

    // 6. Only now does the photo become publicly visible.
    const created = await prisma.photo.create({
      data: {
        placeId: input.placeId,
        visitorId: input.visitorId,
        title,
        description,
        originalKey,
        preview400Key: previewKeys[400] ?? null,
        preview1200Key: previewKeys[1200] ?? null,
        originalFileName: fileName,
        originalMime: mime,
        originalByteLength: file.byteLength,
        originalSha256: file.sha256,
        width: info.width,
        height: info.height,
        status: 'READY',
        uploadIdempotencyKey: idempotencyKey,
      },
    });

    return toPublicPhoto(created, false);
  } catch (error) {
    // Roll back every key written during this attempt, so a failed upload never
    // leaves a half-finished photo or an orphan file for the reconciler.
    await Promise.all(writtenKeys.map((key) => storage.remove(key).catch(() => undefined)));
    await fs.rm(file.tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Test helper: ingest straight from bytes, bypassing the multipart parser. */
export async function ingestPhotoBytes(input: {
  placeId: string;
  visitorId: string;
  bytes: Uint8Array;
  fileName: string;
  mime: string;
  title?: string;
  description?: string;
  idempotencyKey: string;
}): Promise<IngestedPhoto> {
  const { createHash, randomBytes } = await import('node:crypto');
  const config = getConfig();
  await fs.mkdir(config.uploadTmpDir, { recursive: true });
  const tempKey = `${randomBytes(16).toString('hex')}.upload`;
  const tempPath = `${config.uploadTmpDir}/${tempKey}`;
  await fs.writeFile(tempPath, input.bytes);

  return ingestPhoto({
    placeId: input.placeId,
    visitorId: input.visitorId,
    title: input.title ?? '',
    description: input.description ?? '',
    idempotencyKey: input.idempotencyKey,
    file: {
      fieldName: 'file',
      tempKey,
      tempPath,
      declaredFileName: input.fileName,
      declaredMime: input.mime,
      byteLength: input.bytes.byteLength,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      head: Buffer.from(input.bytes.subarray(0, 32)),
    } satisfies StreamedFile,
  });
}

export { streamFromBuffer };
