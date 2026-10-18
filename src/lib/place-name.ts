import { createHash, randomBytes } from 'node:crypto';

/**
 * Place name normalisation and slug generation.
 *
 * Two separate concerns, deliberately not merged:
 *
 *   normalizePlaceName() decides whether two names are *the same place*. It must
 *   be stable across Unicode forms and whitespace, because it backs the
 *   duplicate constraint.
 *
 *   buildPlaceSlug() decides the URL segment. It must be safe ASCII and must
 *   never let user text escape into a path. Chinese names produce no slug
 *   characters at all, so they get an opaque suffix rather than a
 *   transliteration we would then have to maintain.
 *
 * Two authoring rules this file follows, both learned the hard way:
 *
 * 1. Character classes are regex *literals*, never `new RegExp(string)`. In a
 *    string, a backslash-dot is an identity escape that collapses to a plain
 *    dot, which silently turned an anchored one-or-more-dots pattern into
 *    "any character" and wiped entire filenames.
 *
 * 2. Classes are written with Unicode property escapes rather than fixed
 *    code-point ranges. Property escapes keep this file pure ASCII, whereas a
 *    literal control byte inside a character class gets mangled by editors,
 *    diff tools and patch appliers.
 */

/**
 * Whitespace. The JS `\s` class already covers ASCII space plus U+00A0,
 * U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 (ideographic
 * space) and U+FEFF, which is everything CJK and NBSP input can throw at us.
 */
const WHITESPACE = /\s+/g;

/** Diacritics left behind by NFKD: non-spacing and enclosing marks. */
const COMBINING_MARKS = /[\p{Mn}\p{Me}]+/gu;

/**
 * C0/C1 controls plus every format character. That covers the bidi overrides
 * (U+202A-U+202E), LRM/RLM, zero-width joiners and U+FEFF -- the characters
 * that let "photo<RTL-override>gnp.jpg" render as "photo.jpg".
 */
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]+/gu;

/** Leading dots: a hidden file, or ".." in disguise. */
const LEADING_DOTS = /^\.+/;

/** Any run of two or more dots, including a bare "..". */
const DOT_RUNS = /\.{2,}/g;

/** A plain alphanumeric extension, and nothing else. */
const PLAIN_EXTENSION = /^[A-Za-z0-9]+$/;

/** Allowed in a filename base: ASCII, dots, hyphens and Han characters. */
const UNSAFE_BASENAME = /[^A-Za-z0-9._\p{Script=Han}-]/gu;

/** Non-alphanumeric runs become a single hyphen in slugs. */
const NON_SLUG_CHARS = /[^a-z0-9]+/g;

const EDGE_HYPHENS = /^-+|-+$/g;
const TRAILING_HYPHENS = /-+$/;

/** The Windows path separator, built from its char code to avoid an escape. */
const WINDOWS_SEPARATOR = String.fromCharCode(92);

const MAX_SLUG_LENGTH = 48;

/**
 * Collapse whitespace and apply Unicode NFC.
 *
 * NFC matters for CJK compatibility characters: the traditional and simplified
 * forms of an island character are compatibility variants that NFC folds
 * together, which is exactly the class of near-duplicate the unique constraint
 * on Place.normalizedName should catch.
 */
export function normalizePlaceName(raw: string): string {
  return raw.normalize('NFC').replace(WHITESPACE, ' ').trim();
}

/**
 * Derive a URL-safe ASCII slug.
 *
 * Latin names keep their words ("Outer Lingding Island" becomes
 * "outer-lingding-island"). Anything else yields only a short opaque suffix,
 * so a Chinese place becomes "place-a1b2c3d4" instead of an empty or
 * percent-encoded segment.
 */
export function buildPlaceSlug(name: string, seed?: string): string {
  const ascii = name
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(NON_SLUG_CHARS, '-')
    .replace(EDGE_HYPHENS, '');

  if (ascii.length >= 2) {
    return ascii.slice(0, MAX_SLUG_LENGTH).replace(TRAILING_HYPHENS, '');
  }

  // Deterministic when a seed is supplied (tests, idempotent seeding).
  const entropy = seed
    ? createHash('sha256').update(seed).digest('hex').slice(0, 8)
    : randomBytes(4).toString('hex');
  return `place-${entropy}`;
}

/**
 * Human-facing file name for a download response.
 *
 * Strips path separators, control/format characters and RTL overrides so a
 * hostile originalFileName cannot traverse a client filesystem or disguise its
 * own extension. The original extension is preserved so the browser picks the
 * right handler for the byte-exact original.
 */
export function safeFilename(raw: string, fallback = 'photo'): string {
  const stripped = raw
    .replace(CONTROL_CHARS, '')
    // A separator in either direction becomes an underscore. The Windows
    // separator is matched by char code and split/join rather than as a
    // backslash literal, so this file stays free of escape sequences that
    // tooling can silently truncate.
    .replace(/[/]/g, '_')
    .split(WINDOWS_SEPARATOR)
    .join('_')
    // Collapse ".." (and any longer run) before stripping leading dots, so a
    // traversal attempt cannot survive as "_..etcpasswd".
    .replace(DOT_RUNS, '.')
    .replace(LEADING_DOTS, '')
    .trim();

  if (stripped.length === 0) return fallback;

  const dot = stripped.lastIndexOf('.');
  const ext = dot > 0 ? stripped.slice(dot + 1) : '';

  // Keep the extension only when it is already plain. Sanitising instead would
  // turn "photo.jp eg" into "photo.jpeg" -- a different, valid-looking format
  // than the real original, which is exactly the kind of quiet lie the original
  // is byte-exact to avoid.
  if (PLAIN_EXTENSION.test(ext)) {
    const safeBase = stripped.slice(0, dot).replace(UNSAFE_BASENAME, '_').slice(0, 80) || fallback;
    return `${safeBase}.${ext.slice(0, 10)}`;
  }

  // No trustworthy extension: keep the whole sanitised string rather than
  // discarding the name down to nothing.
  return stripped.replace(UNSAFE_BASENAME, '_').slice(0, 80) || fallback;
}
