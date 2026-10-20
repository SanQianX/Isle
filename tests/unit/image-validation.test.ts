import { describe, expect, it } from 'vitest';
import { assertDeclaredTypeMatches, detectFormat, sniffImage } from '@/server/image/validate';

/**
 * Format detection and the declared-type check.
 *
 * The declared type is a browser-supplied *hint*. Two real cases make it
 * unreliable:
 *
 *   - WebKit leaves `File.type` empty for `.webp` files, so the multipart part
 *     arrives as `application/octet-stream`.
 *   - Some platforms send the legacy `image/jpg` spelling.
 *
 * Treating either as a contradiction rejects photos the server handles
 * perfectly, so the magic bytes have to stay authoritative.
 */

describe('detectFormat', () => {
  it('recognises JPEG, PNG and WebP from their magic bytes', () => {
    expect(detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'png',
    );
    expect(
      detectFormat(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
      ),
    ).toBe('webp');
  });

  it('does not mistake a WAV file for a WebP', () => {
    expect(
      detectFormat(
        new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45]),
      ),
    ).toBe('unknown');
  });

  it('identifies HEIF so it can be rejected with a reason', () => {
    expect(
      detectFormat(
        new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
      ),
    ).toBe('heif');
  });

  it('returns unknown for text and markup', () => {
    expect(detectFormat(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBe('unknown');
    expect(detectFormat(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]))).toBe('unknown');
    expect(detectFormat(new Uint8Array(0))).toBe('unknown');
  });
});

describe('sniffImage', () => {
  it('returns the real mime type for accepted formats', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).mime).toBe('image/jpeg');
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).mime).toBe(
      'image/png',
    );
  });

  it('rejects an unrecognised file with 415', () => {
    try {
      sniffImage(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]));
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { status: number }).status).toBe(415);
    }
  });

  it('rejects HEIC with an explanation instead of converting it silently', () => {
    expect(() =>
      sniffImage(
        new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
      ),
    ).toThrowError(/HEIC/);
  });
});

describe('assertDeclaredTypeMatches', () => {
  it('accepts a matching declaration', () => {
    expect(() => assertDeclaredTypeMatches('image/jpeg', 'image/jpeg')).not.toThrow();
    expect(() => assertDeclaredTypeMatches('image/png', 'image/png')).not.toThrow();
    expect(() => assertDeclaredTypeMatches('image/webp', 'image/webp')).not.toThrow();
  });

  it('accepts an absent declaration', () => {
    expect(() => assertDeclaredTypeMatches(undefined, 'image/jpeg')).not.toThrow();
    expect(() => assertDeclaredTypeMatches('', 'image/jpeg')).not.toThrow();
  });

  it('accepts the legacy image/jpg spelling', () => {
    expect(() => assertDeclaredTypeMatches('image/jpg', 'image/jpeg')).not.toThrow();
  });

  it('accepts a generic octet-stream, which carries no information', () => {
    // WebKit sends this for .webp uploads because its File.type is empty.
    // The magic bytes said image/webp, so the photo is fine.
    expect(() => assertDeclaredTypeMatches('application/octet-stream', 'image/webp')).not.toThrow();
  });

  it('rejects a declaration that genuinely contradicts the bytes', () => {
    // A PNG declared over JPEG bytes means something upstream is rewriting the
    // upload, which would break the byte-exactness guarantee.
    expect(() => assertDeclaredTypeMatches('image/png', 'image/jpeg')).toThrowError(/请求声明/);
    expect(() => assertDeclaredTypeMatches('image/svg+xml', 'image/png')).toThrowError(/请求声明/);
  });
});
