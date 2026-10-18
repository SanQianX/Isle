import { describe, expect, it } from 'vitest';
import { parseRange } from '@/server/http/media';

/**
 * HTTP Range parsing (DATA_API_STORAGE §3).
 *
 * Only single byte ranges are supported. Refusing multi-range and suffixed units
 * outright is deliberate: a partial implementation of the full grammar is how
 * servers end up returning the wrong bytes for a media file.
 */

const SIZE = 1000;

describe('parseRange', () => {
  it('parses a closed range', () => {
    expect(parseRange('bytes=0-99', SIZE)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-199', SIZE)).toEqual({ start: 100, end: 199 });
  });

  it('parses an open-ended range to the last byte', () => {
    expect(parseRange('bytes=500-', SIZE)).toEqual({ start: 500, end: 999 });
    expect(parseRange('bytes=0-', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('parses a suffix range as the final N bytes', () => {
    expect(parseRange('bytes=-50', SIZE)).toEqual({ start: 950, end: 999 });
    expect(parseRange('bytes=-1000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('clamps a suffix range longer than the file', () => {
    expect(parseRange('bytes=-5000', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end beyond the last byte', () => {
    expect(parseRange('bytes=900-5000', SIZE)).toEqual({ start: 900, end: 999 });
  });

  it('accepts a range that ends exactly on the last byte', () => {
    expect(parseRange('bytes=0-999', SIZE)).toEqual({ start: 0, end: 999 });
  });

  it('ignores a missing header', () => {
    expect(parseRange(null, SIZE)).toBeNull();
  });

  it('refuses a multi-range request rather than returning a partial response', () => {
    // Answering 206 with only the first range would be a spec violation and a
    // confusing failure for a media element.
    expect(parseRange('bytes=0-99,200-299', SIZE)).toBeNull();
    expect(parseRange('bytes=0-99, 200-299', SIZE)).toBeNull();
  });

  it('refuses non-byte units', () => {
    expect(parseRange('items=0-99', SIZE)).toBeNull();
    expect(parseRange('seconds=0-10', SIZE)).toBeNull();
  });

  it('refuses reversed, empty and out-of-range requests', () => {
    expect(parseRange('bytes=99-0', SIZE)).toBeNull();
    expect(parseRange('bytes=-', SIZE)).toBeNull();
    expect(parseRange('bytes=1000-', SIZE)).toBeNull();
    expect(parseRange('bytes=5000-6000', SIZE)).toBeNull();
  });

  it('refuses malformed values instead of coercing them', () => {
    for (const bad of ['bytes=abc-def', 'bytes=', '=0-99', 'bytes 0-99', '0-99']) {
      expect(parseRange(bad, SIZE), bad).toBeNull();
    }
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseRange('  bytes=0-99  ', SIZE)).toEqual({ start: 0, end: 99 });
  });
});
