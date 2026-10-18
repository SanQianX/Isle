import sharp from 'sharp';
import type { Metadata } from 'sharp';
import { ApiError } from '@/lib/errors';

/**
 * Image inspection.
 *
 * Two responsibilities that must not be confused:
 *
 *   `inspectImage` measures the *display* dimensions — after EXIF orientation is
 *   applied — because the gallery lays photos out by how they will actually look
 *   on screen, not by how the sensor recorded them.
 *
 *   The stored original keeps its orientation tag and its bytes untouched.
 *
 * The pixel budget is a decompression-bomb guard. `sharp`'s own limit rejects
 * absurd images, but ours is explicit and configured (DATA_API_STORAGE §4.1).
 */

export type ImageInfo = {
  width: number;
  height: number;
  /** Raw sensor dimensions, before orientation is applied. */
  rawWidth: number;
  rawHeight: number;
  orientation: number;
  format: string;
  hasExif: boolean;
  hasGps: boolean;
};

export type InspectOptions = {
  maxPixels: number;
  maxBytes: number;
};

/**
 * Apply EXIF Orientation to a pixel count.
 *
 * Orientations 5–8 involve a 90-degree rotation, so width and height swap.
 * Values outside 1..8 are treated as 1, which is what every decoder does.
 */
export function orientedDimensions(
  rawWidth: number,
  rawHeight: number,
  orientation: number,
): { width: number; height: number } {
  const swaps = orientation >= 5 && orientation <= 8;
  return swaps ? { width: rawHeight, height: rawWidth } : { width: rawWidth, height: rawHeight };
}

function exifHasGps(exifBuffer: Buffer | undefined): boolean {
  if (exifBuffer === undefined) return false;
  // IFD0 pointer (2 bytes, big endian) then walk; a cheap heuristic is to look
  // for the GPS IFD pointer (0x8825) anywhere in the TIFF header block.
  return exifBuffer.includes(Buffer.from([0x88, 0x25]));
}

export async function inspectImage(bytes: Uint8Array, options: InspectOptions): Promise<ImageInfo> {
  if (bytes.byteLength === 0) {
    throw ApiError.invalidImage('文件是空的');
  }
  if (bytes.byteLength > options.maxBytes) {
    throw ApiError.tooLarge('单张照片超过大小限制');
  }

  // limitInputPixels makes libvips refuse to decode a decompression bomb before
  // it allocates memory for it.
  const image = sharp(bytes, { limitInputPixels: options.maxPixels, failOn: 'error' });

  let metadata: Metadata;
  try {
    metadata = await image.metadata();
  } catch (error) {
    throw ApiError.invalidImage(
      `图片无法解析：${error instanceof Error ? error.message : '文件可能已损坏'}`,
    );
  }

  const rawWidth = metadata.width ?? 0;
  const rawHeight = metadata.height ?? 0;
  if (rawWidth <= 0 || rawHeight <= 0) {
    throw ApiError.invalidImage('图片尺寸无效');
  }

  const pixelCount = rawWidth * rawHeight;
  if (pixelCount > options.maxPixels) {
    throw new ApiError(
      'IMAGE_TOO_LARGE',
      `图片分辨率过大（${rawWidth}×${rawHeight}），请压缩后再上传`,
    );
  }

  // A real decode, not just a header parse: a truncated file has valid leading
  // bytes but fails here, which is exactly the corrupt-jpeg case we must reject.
  try {
    await sharp(bytes, { limitInputPixels: options.maxPixels }).metadata();
    await sharp(bytes, { limitInputPixels: options.maxPixels }).stats();
  } catch (error) {
    throw ApiError.invalidImage(
      `图片数据不完整或已损坏：${error instanceof Error ? error.message : '解码失败'}`,
    );
  }

  const orientation = metadata.orientation ?? 1;
  const { width, height } = orientedDimensions(rawWidth, rawHeight, orientation);

  return {
    width,
    height,
    rawWidth,
    rawHeight,
    orientation,
    format: metadata.format ?? '',
    hasExif: metadata.exif !== undefined,
    hasGps: exifHasGps(metadata.exif),
  };
}

/**
 * Produce a preview that is never cropped and never upscaled.
 *
 * `fit: 'inside'` bounds the longest edge at `size`; `withoutEnlargement` keeps a
 * small photo at its native size rather than blowing it up to 1200px of blur.
 * EXIF is dropped from derivatives so a preview never exposes GPS.
 */
export async function renderPreview(
  original: Uint8Array,
  size: number,
  options: { maxPixels: number },
): Promise<Buffer> {
  return sharp(original, { limitInputPixels: options.maxPixels, failOn: 'error' })
    .rotate() // bake in EXIF orientation so the preview matches what is displayed
    .resize({
      width: size,
      height: size,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 82, effort: 4 })
    .toBuffer();
}
