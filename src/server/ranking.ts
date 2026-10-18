/**
 * Leaderboard ordering (DATA_API_STORAGE §2.1).
 *
 *   score    = upCount - downCount
 *   ORDER BY score DESC, upCount DESC, createdAt ASC, id ASC
 *
 * The tie-breakers are not decoration. Without `upCount` a photo with 5 up and
 * 5 down would outrank one with 6 up and 0 down; without `createdAt` two photos
 * with identical tallies would shuffle on every request; and `id` is what makes
 * the order *totally* determined, so the page never re-flows between renders.
 *
 * Kept pure and separate from Prisma so it can be exhaustively unit-tested and
 * reused by the API, the seeder and the tests without a database.
 */

export type Rankable = {
  id: string;
  createdAt: Date;
  upCount: number;
  downCount: number;
};

export function score(photo: { upCount: number; downCount: number }): number {
  return photo.upCount - photo.downCount;
}

/**
 * Comparator for the leaderboard. Returns a negative number when `a` ranks
 * first. Suitable for `Array.prototype.sort` directly.
 */
export function rankingComparator(a: Rankable, b: Rankable): number {
  const scoreDelta = score(b) - score(a);
  if (scoreDelta !== 0) return scoreDelta;

  const upDelta = b.upCount - a.upCount;
  if (upDelta !== 0) return upDelta;

  const createdDelta = a.createdAt.getTime() - b.createdAt.getTime();
  if (createdDelta !== 0) return createdDelta;

  // Final, fully deterministic tie-break.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Sort a copy; the input array is never mutated. */
export function rankPhotos<T extends Rankable>(photos: readonly T[]): T[] {
  return [...photos].sort(rankingComparator);
}

/** Assign 1-based ranks, breaking ties so a rank is never shared. */
export function withRanks<T extends Rankable>(photos: readonly T[]): Array<T & { rank: number }> {
  return rankPhotos(photos).map((photo, index) => ({ ...photo, rank: index + 1 }));
}

/**
 * Encode a cursor from a photo's sort key.
 *
 * base64url of a compact JSON tuple. It is opaque to clients and decodable by
 * the server, which is what makes "resume exactly after this row" possible.
 */
export function encodeCursor(photo: Rankable): string {
  return Buffer.from(
    JSON.stringify([score(photo), photo.upCount, photo.createdAt.getTime(), photo.id]),
    'utf8',
  ).toString('base64url');
}

export type DecodedCursor = {
  score: number;
  upCount: number;
  createdAt: number;
  id: string;
};

/**
 * Decode a cursor. Returns null for anything malformed rather than throwing: a
 * stale cursor from before a re-rank is an expected condition, and the caller
 * responds by restarting from the first page (ADR-006).
 */
export function decodeCursor(raw: string | null | undefined): DecodedCursor | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [scoreValue, upCount, createdAt, id] = parsed;
    if (
      typeof scoreValue !== 'number' ||
      typeof upCount !== 'number' ||
      typeof createdAt !== 'number' ||
      typeof id !== 'string' ||
      !Number.isFinite(scoreValue) ||
      !Number.isFinite(upCount) ||
      !Number.isFinite(createdAt)
    ) {
      return null;
    }
    return { score: scoreValue, upCount, createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Aggregate vote rows into the counts the comparator needs.
 *
 * `score` is always derived from the vote table; the client never sends or
 * stores an authoritative total (DATA_API_STORAGE §6.5).
 */
export type VoteTally = { photoId: string; value: number };

export function tallyVotes(
  votes: readonly VoteTally[],
): Map<string, { upCount: number; downCount: number }> {
  const counts = new Map<string, { upCount: number; downCount: number }>();
  for (const vote of votes) {
    const existing = counts.get(vote.photoId) ?? { upCount: 0, downCount: 0 };
    if (vote.value > 0) existing.upCount += 1;
    else if (vote.value < 0) existing.downCount += 1;
    counts.set(vote.photoId, existing);
  }
  return counts;
}

/** Does this row still sit exactly at the cursor's sort position? */
export function cursorMatches(photo: Rankable, cursor: DecodedCursor): boolean {
  return (
    photo.id === cursor.id &&
    photo.createdAt.getTime() === cursor.createdAt &&
    photo.upCount === cursor.upCount &&
    score(photo) === cursor.score
  );
}

/**
 * Index of the first row strictly after the cursor, or -1 when the cursor's
 * photo has moved (a vote landed between pages). -1 is a signal to restart from
 * the top, never to silently skip or repeat rows.
 */
export function positionAfterCursor(rows: readonly Rankable[], cursor: DecodedCursor): number {
  const index = rows.findIndex((row) => cursorMatches(row, cursor));
  return index === -1 ? -1 : index + 1;
}
