import { describe, expect, it } from 'vitest';
import {
  cursorMatches,
  decodeCursor,
  encodeCursor,
  positionAfterCursor,
  rankPhotos,
  rankingComparator,
  score,
  tallyVotes,
  withRanks,
  type Rankable,
} from '@/server/ranking';

/**
 * Leaderboard ordering (DATA_API_STORAGE §2.1).
 *
 * The tie-breakers carry the product's definition of "best", so each is asserted
 * in isolation: fixing one tie-break at the expense of another would silently
 * change what the site means.
 */

const T0 = new Date('2026-10-19T00:00:00.000Z');

function photo(overrides: Partial<Rankable> = {}): Rankable {
  return {
    id: 'photo-1',
    createdAt: T0,
    upCount: 0,
    downCount: 0,
    ...overrides,
  };
}

describe('score', () => {
  it('is upCount minus downCount', () => {
    expect(score({ upCount: 13, downCount: 1 })).toBe(12);
    expect(score({ upCount: 0, downCount: 1 })).toBe(-1);
    expect(score({ upCount: 0, downCount: 0 })).toBe(0);
  });

  it('can go negative', () => {
    expect(score({ upCount: 2, downCount: 5 })).toBe(-3);
  });
});

describe('rankingComparator', () => {
  it('ranks a higher score first', () => {
    const a = photo({ id: 'a', upCount: 10, downCount: 0 });
    const b = photo({ id: 'b', upCount: 3, downCount: 0 });
    expect([a, b].sort(rankingComparator).map((p) => p.id)).toEqual(['a', 'b']);
    expect([b, a].sort(rankingComparator).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('breaks a score tie by upCount, so a popular photo beats an equally scored unpopular one', () => {
    // Both score 5, but 6-1 has more supporters than 5-0. Without the upCount
    // tie-break these would be arbitrary.
    const popular = photo({ id: 'popular', upCount: 6, downCount: 1 });
    const unpopular = photo({ id: 'unpopular', upCount: 5, downCount: 0 });
    expect([unpopular, popular].sort(rankingComparator).map((p) => p.id)).toEqual([
      'popular',
      'unpopular',
    ]);
  });

  it('breaks a full tie by earliest upload', () => {
    const later = photo({ id: 'later', createdAt: new Date('2026-10-20T00:00:00Z') });
    const earlier = photo({ id: 'earlier', createdAt: new Date('2026-10-18T00:00:00Z') });
    expect([later, earlier].sort(rankingComparator).map((p) => p.id)).toEqual(['earlier', 'later']);
  });

  it('falls back to id when score, upCount and createdAt are all equal', () => {
    // Identical tally and timestamp: only the id can decide, and it must decide
    // the same way every time or the page re-flows on refresh.
    const a = photo({ id: 'aaa' });
    const b = photo({ id: 'bbb' });
    expect([b, a].sort(rankingComparator).map((p) => p.id)).toEqual(['aaa', 'bbb']);
    expect([a, b].sort(rankingComparator).map((p) => p.id)).toEqual(['aaa', 'bbb']);
  });

  it('returns 0 for two identical rows', () => {
    expect(rankingComparator(photo({ id: 'same' }), photo({ id: 'same' }))).toBe(0);
  });

  it('is a valid comparator: sorting is stable regardless of input order', () => {
    const rows = [
      photo({ id: 'd', upCount: 5, downCount: 0 }),
      photo({ id: 'c', upCount: 5, downCount: 0, createdAt: new Date('2026-10-18T00:00:00Z') }),
      photo({ id: 'b', upCount: 9, downCount: 0 }),
      photo({ id: 'a', upCount: 5, downCount: 0, createdAt: new Date('2026-10-18T00:00:00Z') }),
    ];
    const forwards = rankPhotos(rows).map((p) => p.id);
    const backwards = rankPhotos([...rows].reverse()).map((p) => p.id);
    expect(forwards).toEqual(backwards);
    expect(forwards).toEqual(['b', 'a', 'c', 'd']);
  });

  it('never mutates its input', () => {
    const rows = [photo({ id: 'a', upCount: 1 }), photo({ id: 'b', upCount: 9 })];
    const snapshot = rows.map((p) => p.id);
    rankPhotos(rows);
    expect(rows.map((p) => p.id)).toEqual(snapshot);
  });

  it('handles negative scores', () => {
    const worse = photo({ id: 'worse', upCount: 0, downCount: 5 });
    const better = photo({ id: 'better', upCount: 0, downCount: 2 });
    expect([worse, better].sort(rankingComparator).map((p) => p.id)).toEqual(['better', 'worse']);
  });
});

describe('withRanks', () => {
  it('assigns 1-based ranks in ranking order', () => {
    const ranked = withRanks([
      photo({ id: 'low', upCount: 1 }),
      photo({ id: 'high', upCount: 9 }),
      photo({ id: 'mid', upCount: 5 }),
    ]);
    expect(ranked.map((p) => [p.id, p.rank])).toEqual([
      ['high', 1],
      ['mid', 2],
      ['low', 3],
    ]);
  });

  it('gives every row a distinct rank even when scores tie', () => {
    const ranked = withRanks([photo({ id: 'a' }), photo({ id: 'b' }), photo({ id: 'c' })]);
    expect(new Set(ranked.map((p) => p.rank)).size).toBe(3);
  });

  it('returns an empty array for an empty input', () => {
    expect(withRanks([])).toEqual([]);
  });
});

describe('cursors', () => {
  it('round-trips a photo through encode/decode', () => {
    const original = photo({ id: 'abc', upCount: 7, downCount: 2, createdAt: T0 });
    const decoded = decodeCursor(encodeCursor(original));

    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe('abc');
    expect(decoded?.upCount).toBe(7);
    expect(decoded?.score).toBe(5);
    expect(decoded?.createdAt).toBe(T0.getTime());
  });

  it('produces a URL-safe string', () => {
    const cursor = encodeCursor(photo({ id: 'a'.repeat(30) }));
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('returns null rather than throwing for malformed input', () => {
    for (const bad of [
      '',
      'not-base64!!',
      'eyJib2d1cyI6',
      Buffer.from('[1,2]').toString('base64url'),
    ]) {
      expect(decodeCursor(bad), bad).toBeNull();
    }
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('rejects a cursor whose element types are wrong', () => {
    const wrongTypes = Buffer.from(JSON.stringify(['a', 1, 2, 3])).toString('base64url');
    expect(decodeCursor(wrongTypes)).toBeNull();
    const tooShort = Buffer.from(JSON.stringify([1, 2, 3])).toString('base64url');
    expect(decodeCursor(tooShort)).toBeNull();
    const notFinite = Buffer.from(JSON.stringify([1, 2, 'NaN', 'x'])).toString('base64url');
    expect(decodeCursor(notFinite)).toBeNull();
  });
});

describe('cursor positioning', () => {
  const rows = rankPhotos([
    photo({ id: 'c', upCount: 1 }),
    photo({ id: 'a', upCount: 9 }),
    photo({ id: 'b', upCount: 5 }),
  ]);

  it('returns the row after an exact cursor match', () => {
    const cursor = decodeCursor(encodeCursor(rows[0] as Rankable));
    expect(positionAfterCursor(rows, cursor!)).toBe(1);
  });

  it('returns 0 when the cursor is the last row', () => {
    const last = rows[rows.length - 1] as Rankable;
    expect(positionAfterCursor(rows, decodeCursor(encodeCursor(last))!)).toBe(rows.length);
  });

  it('returns -1 when the cursor photo has been re-ranked, so the caller restarts', () => {
    // Same photo id, but its score changed because someone voted in between.
    const stale = decodeCursor(encodeCursor(photo({ id: 'a', upCount: 9, downCount: 0 })))!;
    expect(positionAfterCursor(rows, stale)).toBe(1); // still matches: upCount is 9

    const moved = decodeCursor(encodeCursor(photo({ id: 'a', upCount: 30, downCount: 0 })))!;
    expect(positionAfterCursor(rows, moved)).toBe(-1);
  });

  it('cursorMatches compares the full sort key, not just the id', () => {
    const row = photo({ id: 'x', upCount: 4, downCount: 1, createdAt: T0 });
    expect(cursorMatches(row, decodeCursor(encodeCursor(row))!)).toBe(true);
    expect(
      cursorMatches(row, decodeCursor(encodeCursor(photo({ id: 'x', upCount: 5, downCount: 1 })))!),
    ).toBe(false);
    expect(
      cursorMatches(
        row,
        decodeCursor(encodeCursor(photo({ id: 'x', upCount: 4, createdAt: new Date(0) })))!,
      ),
    ).toBe(false);
  });
});

describe('tallyVotes', () => {
  it('counts ups and downs per photo', () => {
    const counts = tallyVotes([
      { photoId: 'a', value: 1 },
      { photoId: 'a', value: 1 },
      { photoId: 'a', value: -1 },
      { photoId: 'b', value: -1 },
    ]);

    expect(counts.get('a')).toEqual({ upCount: 2, downCount: 1 });
    expect(counts.get('b')).toEqual({ upCount: 0, downCount: 1 });
  });

  it('ignores a value of 0, which is never persisted', () => {
    const counts = tallyVotes([
      { photoId: 'a', value: 0 },
      { photoId: 'a', value: 1 },
    ]);
    expect(counts.get('a')).toEqual({ upCount: 1, downCount: 0 });
  });

  it('returns an empty map for no votes', () => {
    expect(tallyVotes([]).size).toBe(0);
  });

  it('agrees with score(): the leaderboard total is always the vote sum', () => {
    const votes = [
      { photoId: 'a', value: 1 },
      { photoId: 'a', value: 1 },
      { photoId: 'a', value: -1 },
    ];
    const counts = tallyVotes(votes).get('a')!;
    expect(score(counts)).toBe(votes.reduce((sum, v) => sum + v.value, 0));
  });
});
