import { describe, expect, it } from 'vitest';
import {
  assertDeclaredTypeMatches,
  detectFormat,
  formatForMime,
  isAllowedMime,
  mimeForFormat,
  sniffImage,
} from '@/server/image/validate';
import { orientedDimensions } from '@/server/image/metadata';

/**
 * Format sniffing and orientation maths — pure functions with no I/O, so every
 * branch is reachable here (DATA_API_STORAGE §4.1).
 */

const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function header(bytes: number[]): Uint8Array {
  return new Uint8Array([...bytes, ...new Array(32).fill(0)]);
}

describe('detectFormat', () => {
  it('recognises JPEG, PNG and WebP from their magic bytes', () => {
    expect(detectFormat(header(JPEG_HEADER))).toBe('jpeg');
    expect(detectFormat(header(PNG_HEADER))).toBe('png');

    // RIFF....WEBP — the discriminator sits at offset 8, not 0.
    const webp = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectFormat(webp)).toBe('webp');
  });

  it('does not mistake a WAV file for a WebP', () => {
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(detectFormat(wav)).toBe('unknown');
  });

  it('identifies HEIF separately so it can be rejected with a clear reason', () => {
    const heic = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(detectFormat(heic)).toBe('heif');
  });

  it('returns unknown for text, HTML and SVG', () => {
    expect(detectFormat(header([0x3c, 0x73, 0x76, 0x67]))).toBe('unknown');
    expect(detectFormat(header([0x3c, 0x68, 0x74, 0x6d, 0x6c]))).toBe('unknown');
    expect(detectFormat(header([0x7b, 0x22, 0x61, 0x22]))).toBe('unknown');
  });

  it('returns unknown for a buffer shorter than any signature', () => {
    expect(detectFormat(new Uint8Array([0xff, 0xd8]))).toBe('unknown');
    expect(detectFormat(new Uint8Array(0))).toBe('unknown');
  });
});

describe('sniffImage', () => {
  it('returns the real mime type for accepted formats', () => {
    expect(sniffImage(header(JPEG_HEADER)).mime).toBe('image/jpeg');
    expect(sniffImage(header(PNG_HEADER)).mime).toBe('image/png');
  });

  it('rejects an unrecognised file with 415', () => {
    expect(() => sniffImage(header([0x48, 0x65, 0x6c, 0x6c, 0x6f]))).toThrowError(
      /无法识别图片格式/,
    );
    try {
      sniffImage(header([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
    } catch (error) {
      expect((error as { status: number }).status).toBe(415);
    }
  });

  it('rejects HEIC with an explanation instead of converting it silently', () => {
    const heic = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(() => sniffImage(heic)).toThrowError(/HEIC/);
  });
});

describe('assertDeclaredTypeMatches', () => {
  it('accepts a matching declaration and an absent one', () => {
    expect(() => assertDeclaredTypeMatches('image/jpeg', 'image/jpeg')).not.toThrow();
    expect(() => assertDeclaredTypeMatches(undefined, 'image/jpeg')).not.toThrow();
    expect(() => assertDeclaredTypeMatches('', 'image/jpeg')).not.toThrow();
  });

  it('treats the legacy image/jpg spelling as image/jpeg', () => {
    expect(() => assertDeclaredTypeMatches('image/jpg', 'image/jpeg')).not.toThrow();
  });

  it('rejects a declaration that contradicts the bytes', () => {
    // A .png declared over JPEG bytes means something upstream is rewriting the
    // upload, which would break the byte-exactness guarantee.
    expect(() => assertDeclaredTypeMatches('image/png', 'image/jpeg')).toThrowError(/请求声明/);
  });

  it('rejects an unsupported declared type over otherwise valid bytes', () => {
    // SVG bytes never reach here -- sniffImage rejects them -- but a browser
    // declaring image/svg+xml for real PNG bytes must not be trusted either.
    expect(() => assertDeclaredTypeMatches('image/svg+xml', 'image/png')).toThrowError(
      /请求声明的是 image\/svg\+xml/,
    );
    expect(() => assertDeclaredTypeMatches('text/html', 'image/jpeg')).toThrowError(/请求声明的是/);
  });
});

describe('mime and format mapping', () => {
  it('round-trips between mime and format', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp'] as const) {
      expect(mimeForFormat(formatForMime(mime))).toBe(mime);
    }
  });

  it('accepts only the three v1 types', () => {
    expect(isAllowedMime('image/jpeg')).toBe(true);
    expect(isAllowedMime('image/png')).toBe(true);
    expect(isAllowedMime('image/webp')).toBe(true);
    expect(isAllowedMime('image/heic')).toBe(false);
    expect(isAllowedMime('image/svg+xml')).toBe(false);
    expect(isAllowedMime('text/html')).toBe(false);
  });
});

describe('orientedDimensions', () => {
  it('leaves dimensions alone for orientations 1-4', () => {
    for (const orientation of [1, 2, 3, 4]) {
      expect(orientedDimensions(4000, 3000, orientation)).toEqual({ width: 4000, height: 3000 });
    }
  });

  it('swaps dimensions for orientations 5-8, which rotate by 90 degrees', () => {
    for (const orientation of [5, 6, 7, 8]) {
      expect(orientedDimensions(4000, 3000, orientation)).toEqual({ width: 3000, height: 4000 });
    }
  });

  it('treats an absent or nonsensical orientation as upright', () => {
    expect(orientedDimensions(4000, 3000, 1)).toEqual({ width: 4000, height: 3000 });
    expect(orientedDimensions(4000, 3000, 0)).toEqual({ width: 4000, height: 3000 });
    expect(orientedDimensions(4000, 3000, 99)).toEqual({ width: 4000, height: 3000 });
  });

  it('matches the Orientation=6 fixture: a 1200x1600 sensor image displays as 1600x1200', () => {
    expect(orientedDimensions(1200, 1600, 6)).toEqual({ width: 1600, height: 1200 });
  });
});
