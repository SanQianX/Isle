import { describe, expect, it } from 'vitest';
import { buildPlaceSlug, normalizePlaceName, safeFilename } from '@/lib/place-name';

// Built from char codes so this test file stays pure ASCII and a stray RTL mark
// cannot reorder the source it lives in.
const RTL_OVERRIDE = String.fromCharCode(0x202e);
const BACKSLASH = String.fromCharCode(92);

describe('normalizePlaceName', () => {
  it('trims and collapses whitespace, including ideographic spaces', () => {
    expect(normalizePlaceName('  Guishan  ')).toBe('Guishan');
    expect(normalizePlaceName('Outer  Lingding   Island')).toBe('Outer Lingding Island');
    expect(normalizePlaceName('a\tb\nc')).toBe('a b c');
    expect(normalizePlaceName('a\u3000b')).toBe('a b');
    expect(normalizePlaceName('a\u00a0b')).toBe('a b');
  });

  it('never drops a letter while collapsing whitespace', () => {
    // Regression guard: an over-eager character class once replaced every "s"
    // with a space, turning "Island" into "I land".
    expect(normalizePlaceName('Island')).toBe('Island');
    expect(normalizePlaceName('Guishan Island')).toBe('Guishan Island');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizePlaceName('   ')).toBe('');
    expect(normalizePlaceName('\u3000')).toBe('');
  });

  it('keeps genuinely different Han names distinct', () => {
    // NFC does not fold traditional to simplified; these are different places
    // and collapsing them would merge two real entries.
    expect(normalizePlaceName('\u6842\u5c71\u5cf6')).not.toBe(
      normalizePlaceName('\u6842\u5c71\u5c9b'),
    );
  });

  it('never throws on emoji, RTL text or zero-width joiners', () => {
    expect(() =>
      normalizePlaceName('\u{1f5fa}\ufe0f harbor \u05e9\u05dc\u05d5\u05dd'),
    ).not.toThrow();
  });
});

describe('buildPlaceSlug', () => {
  it('derives a readable ASCII slug from a latin name', () => {
    expect(buildPlaceSlug('Outer Lingding Island')).toBe('outer-lingding-island');
    expect(buildPlaceSlug('Guishan Island')).toBe('guishan-island');
  });

  it('strips accents rather than dropping the word', () => {
    expect(buildPlaceSlug('Caf\u00e9 Bay')).toBe('cafe-bay');
  });

  it('falls back to an opaque suffix for names with no ASCII', () => {
    expect(buildPlaceSlug('\u6842\u5c71\u5c9b')).toMatch(/^place-[0-9a-f]{8}$/);
  });

  it('is deterministic when seeded, so idempotent seeding cannot duplicate slugs', () => {
    expect(buildPlaceSlug('\u6842\u5c71\u5c9b', 'guishan-island')).toBe(
      buildPlaceSlug('\u6842\u5c71\u5c9b', 'guishan-island'),
    );
    expect(buildPlaceSlug('\u6d77\u9675\u5c9b', 'hailing')).not.toBe(
      buildPlaceSlug('\u6842\u5c71\u5c9b', 'guishan-island'),
    );
  });

  it('produces two different random slugs for the same non-ASCII name', () => {
    expect(buildPlaceSlug('\u6d77\u9675\u5c9b')).not.toBe(buildPlaceSlug('\u6d77\u9675\u5c9b'));
  });

  it('never emits path separators, traversal or percent-encoding', () => {
    for (const hostile of ['../../etc/passwd', 'a/b/c', '..', '/absolute', '%2e%2e%2f']) {
      const slug = buildPlaceSlug(hostile);
      expect(slug).toMatch(/^[a-z0-9-]+$/);
      expect(slug).not.toContain('..');
      expect(slug).not.toContain('/');
      expect(slug).not.toContain('%');
    }
  });

  it('caps slug length and never ends on a hyphen', () => {
    const slug = buildPlaceSlug('a'.repeat(200));
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('safeFilename', () => {
  it('passes ordinary filenames through', () => {
    expect(safeFilename('sunset.jpg')).toBe('sunset.jpg');
    expect(safeFilename('photo.webp')).toBe('photo.webp');
    expect(safeFilename('photo')).toBe('photo');
  });

  it('keeps Han characters so a Chinese original downloads readably', () => {
    expect(safeFilename('\u6d77\u4e0a\u7684\u4e24\u5ea7\u706f\u5854.jpeg')).toBe(
      '\u6d77\u4e0a\u7684\u4e24\u5ea7\u706f\u5854.jpeg',
    );
  });

  it('neutralises path traversal in both separator styles', () => {
    const hostile = [
      '../../etc/passwd',
      '..' + BACKSLASH + '..' + BACKSLASH + 'windows' + BACKSLASH + 'cmd.exe',
      '/etc/shadow',
    ];
    for (const name of hostile) {
      const safe = safeFilename(name);
      expect(safe).not.toContain('/');
      expect(safe).not.toContain(BACKSLASH);
      expect(safe).not.toContain('..');
    }
  });

  it('collapses every dot run so a traversal cannot survive after substitution', () => {
    // Separators become underscores first, which would otherwise leave a
    // leading "_.." that LEADING_DOTS no longer sees.
    expect(safeFilename('../../etc/passwd')).toBe('_._etc_passwd');
    expect(safeFilename('..')).toBe('photo');
    expect(safeFilename('...')).toBe('photo');
  });

  it('drops leading dots so the result cannot become a hidden file', () => {
    expect(safeFilename('.bashrc')).toBe('bashrc');
  });

  it('defeats an RTL override extension spoof', () => {
    const safe = safeFilename('photo' + RTL_OVERRIDE + 'gnp.jpg');
    // Stripping the override leaves "photognp" -- a different string, which is
    // the point. It must never read as "photo.jpg".
    expect(safe).not.toBe('photo.jpg');
    expect(safe).toBe('photognp.jpg');
  });

  it('drops an extension rather than sanitising it into a different format', () => {
    // Sanitising would yield "photo.jpeg" -- a different, valid-looking format
    // from the real original, which is exactly the quiet lie we must avoid.
    expect(safeFilename('photo.jp eg')).toBe('photo.jp_eg');
    expect(safeFilename('photo.j')).toBe('photo.j');
    expect(safeFilename('photo.jpg')).toBe('photo.jpg');
  });

  it('falls back for empty or fully-stripped names', () => {
    expect(safeFilename('')).toBe('photo');
    expect(safeFilename('   ')).toBe('photo');
    expect(safeFilename(String.fromCharCode(7))).toBe('photo');
  });

  it('bounds the base length while keeping the extension', () => {
    const safe = safeFilename('a'.repeat(500) + '.jpg');
    expect(safe.length).toBeLessThanOrEqual(91);
    expect(safe.endsWith('.jpg')).toBe(true);
  });

  it('never emits a quote or newline that could break a Content-Disposition header', () => {
    const safe = safeFilename('ev"il\r\nX-Injected: 1.jpg');
    expect(safe).not.toContain('"');
    expect(safe).not.toContain('\r');
    expect(safe).not.toContain('\n');
  });
});
