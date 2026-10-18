import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import { ApiError } from '@/lib/errors';
import { safeFilename } from '@/lib/place-name';
import { getPrisma } from '@/server/db/client';
import { DiskStorage } from '@/server/storage/DiskStorage';

/**
 * Byte-exact media delivery (DATA_API_STORAGE §3).
 *
 * Shared by the `/original`, `/download` and `/preview/:size` routes.
 *
 * The original is streamed straight off disk. It is never re-encoded, never
 * passed through the Next image optimizer, and never served for a HIDDEN photo.
 * Range requests are honoured so a large JPEG can be fetched incrementally.
 */

export type MediaKind = 'original' | 'download' | 'preview';

type PhotoRow = {
  id: string;
  status: string;
  originalKey: string;
  originalMime: string;
  originalFileName: string;
  originalByteLength: number;
  originalSha256: string;
  preview400Key: string | null;
  preview1200Key: string | null;
};

async function loadPhoto(photoId: string): Promise<PhotoRow> {
  if (typeof photoId !== 'string' || photoId.length === 0 || photoId.length > 64) {
    throw ApiError.notFound('找不到该照片');
  }
  const prisma = await getPrisma();
  const photo = await prisma.photo.findUnique({ where: { id: photoId } });
  // A HIDDEN or still-processing photo is indistinguishable from a missing one:
  // returning 404 avoids confirming that moderation happened (DATA_API_STORAGE §1).
  if (photo === null || photo.status !== 'READY') {
    throw ApiError.notFound('找不到该照片');
  }
  return photo;
}

function resolveKey(photo: PhotoRow, kind: MediaKind, size?: number): string {
  if (kind === 'original' || kind === 'download') return photo.originalKey;

  const key = size === 400 ? photo.preview400Key : photo.preview1200Key;
  if (key === null) {
    // A READY photo always has both previews; this is a corruption signal, not
    // a user error, so it must not silently fall back to the original.
    throw new ApiError('STORAGE_UNAVAILABLE', '照片预览暂时不可用');
  }
  return key;
}

function contentDisposition(kind: MediaKind, photo: PhotoRow): string {
  const filename = safeFilename(photo.originalFileName, 'photo');
  const type = kind === 'download' ? 'attachment' : 'inline';
  // Both forms are emitted: the plain one for old clients, RFC 5987 for modern.
  return `${type}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Parse a single-range `Range: bytes=a-b` header.
 * Multi-range and non-byte units are refused, which is simpler and safer than
 * a partial implementation of the full grammar.
 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === undefined || rawEnd === undefined) return null;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

export async function serveMedia(
  request: Request,
  photoId: string,
  kind: MediaKind,
  size?: number,
): Promise<Response> {
  const photo = await loadPhoto(photoId);
  const storage = DiskStorage.fromConfig();
  const key = resolveKey(photo, kind, size);

  // Previews are content-addressed and immutable, so they cache aggressively.
  // The original is also immutable, but a listing page must never be able to
  // learn another visitor's state, so anything personalised stays no-store.
  const isPreview = kind === 'preview';
  const etag = `"${photo.originalSha256}${isPreview ? `-${size}` : ''}"`;

  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatch !== null && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const absolute = storage.absolutePath(key);
  let total: number;
  try {
    total = (await fs.stat(absolute)).size;
  } catch {
    throw new ApiError('STORAGE_UNAVAILABLE', '照片文件暂时不可用');
  }

  const headers = new Headers();
  headers.set('Content-Type', isPreview ? 'image/webp' : photo.originalMime);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('ETag', etag);
  headers.set('Content-Disposition', contentDisposition(kind, photo));
  headers.set(
    'Cache-Control',
    isPreview ? 'public, max-age=31536000, immutable' : 'public, max-age=3600, must-revalidate',
  );

  // HEAD: same headers, no body.
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(total));
    return new Response(null, { status: 200, headers });
  }

  const range = parseRange(request.headers.get('range'), total);
  if (range !== null) {
    const { stream, size: length } = await storage.openReadStream(key, range);
    headers.set('Content-Length', String(length));
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
    headers.set('Accept-Ranges', 'bytes');
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers });
  }

  const { stream } = await storage.openReadStream(key);
  headers.set('Content-Length', String(total));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers });
}
