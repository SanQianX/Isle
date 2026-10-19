import { ApiError } from '@/lib/errors';
import { ALLOWED_IMAGE_MIME_TYPES, type AllowedImageMime } from '@/lib/config';

/**
 * Upload validation (DATA_API_STORAGE §4.1).
 *
 * The declared Content-Type and the filename extension are both treated as
 * untrusted hints. Acceptance is decided by the file's own magic bytes plus a
 * real decode, so a text file named `photo.jpg` and an HTML payload named
 * `.jpg` are both rejected regardless of what the browser claimed.
 */

export type DetectedFormat = 'jpeg' | 'png' | 'webp' | 'unknown' | 'heif';

const MIME_BY_FORMAT: Record<Exclude<DetectedFormat, 'unknown' | 'heif'>, AllowedImageMime> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const FORMAT_BY_MIME: Record<AllowedImageMime, Exclude<DetectedFormat, 'unknown' | 'heif'>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function startsWith(buffer: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (buffer.length < offset + signature.length) return false;
  return signature.every((byte, index) => buffer[offset + index] === byte);
}

/**
 * Identify the container from its leading bytes.
 *
 * Needs at least 16 bytes to distinguish every format here, which is why the
 * streaming parser keeps a header prefix before handing the rest to sharp.
 */
export function detectFormat(buffer: Uint8Array): DetectedFormat {
  // JPEG: FF D8 FF
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'jpeg';

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';

  // RIFF....WEBP — the four bytes at offset 8 are the discriminator.
  if (
    startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'webp';
  }

  // HEIC/HEIF: ....ftyp{heic,heix,hevc,heim,mif1,msf1}
  if (startsWith(buffer, [0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(...buffer.slice(8, 12));
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'mif1', 'msf1'].includes(brand)) {
      return 'heif';
    }
  }

  return 'unknown';
}

export type SniffResult = {
  /** Narrowed: `unknown` and `heif` throw, so they never reach a caller. */
  format: 'jpeg' | 'png' | 'webp';
  mime: AllowedImageMime;
};

/**
 * Decide the real type of an upload from its bytes.
 *
 * Throws rather than returning a verdict, so every rejection carries the right
 * HTTP status: 415 for a type we do not accept at all, 422 for one we accept
 * but that is not actually an image.
 */
export function sniffImage(buffer: Uint8Array): SniffResult {
  const format = detectFormat(buffer);

  if (format === 'unknown') {
    throw ApiError.unsupportedType('无法识别图片格式，仅支持 JPEG / PNG / WebP');
  }

  if (format === 'heif') {
    // Explicit, explained rejection: HEIC originals cannot be displayed natively
    // across browsers, and silently converting would mean the stored "original"
    // is not the file the user uploaded (DATA_API_STORAGE §4.1).
    throw new ApiError(
      'UNSUPPORTED_MEDIA_TYPE',
      '暂不支持 HEIC/HEIF 格式，请在相册里转换为 JPEG 后再上传',
    );
  }

  return { format, mime: MIME_BY_FORMAT[format] };
}

/**
 * Cross-check the browser's declared type against the bytes.
 *
 * A mismatch is an error, not a hint: it means something upstream is rewriting
 * the upload or the client is confused about what it sent, and accepting it
 * would break the byte-exactness guarantee the whole product rests on.
 *
 * `actual` is always one of the three accepted types -- sniffImage has already
 * rejected anything else -- so a mismatch is the only failure mode here.
 */
export function assertDeclaredTypeMatches(
  declared: string | undefined,
  actual: AllowedImageMime,
): void {
  if (declared === undefined || declared === '') return;

  // A generic type carries no information about the content. Browsers send it
  // when they do not know the format themselves -- WebKit does exactly this for
  // .webp uploads, whose File.type is empty. Treating that as a contradiction
  // would reject a perfectly good photo, so it is accepted and the magic bytes
  // stay authoritative.
  if (declared === 'application/octet-stream') return;

  // Browsers may send the legacy `image/jpg` spelling.
  const normalized = declared === 'image/jpg' ? 'image/jpeg' : declared;
  if (normalized === actual) return;

  throw ApiError.unsupportedType(
    `文件内容是 ${actual}，但请求声明的是 ${declared}，已拒绝以避免内容与记录不一致`,
  );
}

export function mimeForFormat(
  format: Exclude<DetectedFormat, 'unknown' | 'heif'>,
): AllowedImageMime {
  return MIME_BY_FORMAT[format];
}

export function formatForMime(mime: AllowedImageMime): Exclude<DetectedFormat, 'unknown' | 'heif'> {
  return FORMAT_BY_MIME[mime];
}

export function isAllowedMime(value: string): value is AllowedImageMime {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}
