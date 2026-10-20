import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { getPrisma } from '@/server/db/client';
import { encodeCursor, rankPhotos, type Rankable } from '@/server/ranking';

/**
 * Page-level photo loading.
 *
 * Every page that shows photographs goes through here so the ranking rules live
 * in exactly one place: a home page that ordered differently from the ranking
 * page would be a silent, very confusing bug.
 *
 * The vote counts are aggregated by the database rather than by loading every
 * vote row and counting in JavaScript. The difference is not academic: a place
 * with 500 photos that have been voted on pulls thousands of vote rows through
 * the connection, the query and the heap, when the same answer needs one row
 * per photo.
 */

export type PhotoView = {
  id: string;
  rank: number;
  title: string;
  description: string;
  width: number;
  height: number;
  mime: string;
  bytes: number;
  createdAt: Date;
  uploaderDisplayCode: string;
  upCount: number;
  downCount: number;
  score: number;
  currentVisitorVote: -1 | 0 | 1;
  preview400Url: string;
  preview1200Url: string;
  originalUrl: string;
  downloadUrl: string;
};

export type PlaceSummaryView = {
  photoCount: number;
  contributorCount: number;
  totalVotes: number;
};

/**
 * Vote totals per photo, computed in the database.
 *
 * One row per photo instead of one row per vote. The SQL is deliberately plain
 * -- a JOIN and a GROUP BY -- so it ports to another engine unchanged.
 */
async function aggregateVotes(
  prisma: PrismaClient,
  photoIds: string[],
): Promise<Map<string, { upCount: number; downCount: number }>> {
  if (photoIds.length === 0) return new Map();

  const rows = await prisma.$queryRaw<
    Array<{ photoId: string; upCount: bigint | number; downCount: bigint | number }>
  >`
    SELECT
      photoId,
      SUM(CASE WHEN value > 0 THEN 1 ELSE 0 END) AS upCount,
      SUM(CASE WHEN value < 0 THEN 1 ELSE 0 END) AS downCount
    FROM Vote
    WHERE photoId IN (${Prisma.join(photoIds)})
    GROUP BY photoId
  `;

  const result = new Map<string, { upCount: number; downCount: number }>();
  for (const row of rows) {
    result.set(row.photoId, {
      upCount: Number(row.upCount),
      downCount: Number(row.downCount),
    });
  }
  return result;
}

/**
 * Ranked READY photos for a place, plus the rolled-up counts the hero shows.
 *
 * `limit` caps how many are materialised; pass a large number for the full
 * ranking. Totals are computed over the *whole* place, not the page, so a hero
 * never claims "08 photos" when there are 40.
 */
export async function loadRankedPhotos(
  placeId: string,
  visitorId: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<{
  photos: PhotoView[];
  summary: PlaceSummaryView;
  totalPhotos: number;
  /** Cursor for the next page, or null when everything is shown. */
  nextCursor: string | null;
}> {
  const prisma = await getPrisma();

  const [rows, ownVotes, totalPhotos] = await Promise.all([
    prisma.photo.findMany({
      where: { placeId, status: 'READY' },
      select: {
        id: true,
        title: true,
        description: true,
        width: true,
        height: true,
        originalMime: true,
        originalByteLength: true,
        createdAt: true,
        visitor: { select: { displayCode: true } },
      },
    }),
    prisma.vote.findMany({
      where: { visitorId },
      select: { photoId: true, value: true },
    }),
    prisma.photo.count({ where: { placeId, status: 'READY' } }),
  ]);

  const ownByPhoto = new Map(ownVotes.map((vote) => [vote.photoId, vote.value]));
  const counts = await aggregateVotes(
    prisma,
    rows.map((row) => row.id),
  );

  const photos: PhotoView[] = rows.map((row) => {
    const tally = counts.get(row.id) ?? { upCount: 0, downCount: 0 };
    const own = ownByPhoto.get(row.id);
    return {
      id: row.id,
      rank: 0,
      title: row.title,
      description: row.description,
      width: row.width,
      height: row.height,
      mime: row.originalMime,
      bytes: row.originalByteLength,
      createdAt: row.createdAt,
      uploaderDisplayCode: row.visitor.displayCode,
      upCount: tally.upCount,
      downCount: tally.downCount,
      score: tally.upCount - tally.downCount,
      currentVisitorVote: own === 1 ? 1 : own === -1 ? -1 : 0,
      preview400Url: `/api/photos/${row.id}/preview/400`,
      preview1200Url: `/api/photos/${row.id}/preview/1200`,
      originalUrl: `/api/photos/${row.id}/original`,
      downloadUrl: `/api/photos/${row.id}/download`,
    };
  });

  const summary: PlaceSummaryView = {
    photoCount: totalPhotos,
    contributorCount: new Set(rows.map((row) => row.visitor.displayCode)).size,
    totalVotes: photos.reduce((sum, photo) => sum + photo.score, 0),
  };

  const sorted = rankPhotos(photos as unknown as Rankable[] as PhotoView[]);
  const limited = Number.isFinite(limit) ? sorted.slice(0, limit) : sorted;

  // The cursor comes from the server's own encoder. The client must not
  // re-implement it: two encoders that drift apart produce a page that silently
  // skips photographs.
  const last = limited[limited.length - 1];
  const nextCursor =
    last !== undefined && limited.length < totalPhotos
      ? encodeCursor(last as unknown as Rankable)
      : null;

  return {
    photos: limited.map((photo, index) => ({ ...photo, rank: index + 1 })),
    summary,
    totalPhotos,
    nextCursor,
  };
}

/**
 * The top N photographs of a place, ranked in the database.
 *
 * The home page shows four photographs and the place page shows seven, but
 * both used to load every photograph of the place to work out which four came
 * first. Ranking in SQL with a LIMIT means the query returns four rows no
 * matter how many photographs the place holds.
 *
 * The ORDER BY below must agree with `rankingComparator` in src/server/ranking.ts.
 * They are two implementations of the same rule, and the cursor pagination
 * walks between them: the API orders with the comparator, this query orders with
 * SQL. `tests/unit/ranking.test.ts` and the agreement test in
 * `tests/integration/place-scoping.test.ts` keep them in step.
 */
export async function loadTopPhotos(
  placeId: string,
  visitorId: string,
  limit: number,
): Promise<{ photos: PhotoView[]; summary: PlaceSummaryView; totalPhotos: number }> {
  const prisma = await getPrisma();

  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      title: string;
      description: string;
      width: number;
      height: number;
      originalMime: string;
      originalByteLength: number;
      createdAt: Date;
      displayCode: string;
      upCount: number | bigint;
      downCount: number | bigint;
    }>
  >`
    SELECT
      ph.id AS id,
      ph.title AS title,
      ph.description AS description,
      ph.width AS width,
      ph.height AS height,
      ph.originalMime AS originalMime,
      ph.originalByteLength AS originalByteLength,
      ph.createdAt AS createdAt,
      vi.displayCode AS displayCode,
      SUM(CASE WHEN v.value > 0 THEN 1 ELSE 0 END) AS upCount,
      SUM(CASE WHEN v.value < 0 THEN 1 ELSE 0 END) AS downCount
    FROM Photo ph
    JOIN Visitor vi ON vi.id = ph.visitorId
    LEFT JOIN Vote v ON v.photoId = ph.id
    WHERE ph.placeId = ${placeId} AND ph.status = 'READY'
    GROUP BY ph.id
    ORDER BY (upCount - downCount) DESC, upCount DESC, ph.createdAt ASC, ph.id ASC
    LIMIT ${limit}
  `;

  const [ownVotes, totals] = await Promise.all([
    prisma.vote.findMany({
      where: { visitorId, photoId: { in: rows.map((row) => row.id) } },
      select: { photoId: true, value: true },
    }),
    placeTotals(prisma, placeId),
  ]);

  const ownByPhoto = new Map(ownVotes.map((vote) => [vote.photoId, vote.value]));

  const photos: PhotoView[] = rows.map((row, index) => {
    const upCount = Number(row.upCount);
    const downCount = Number(row.downCount);
    const own = ownByPhoto.get(row.id);
    return {
      id: row.id,
      rank: index + 1,
      title: row.title,
      description: row.description,
      width: row.width,
      height: row.height,
      mime: row.originalMime,
      bytes: row.originalByteLength,
      createdAt: row.createdAt,
      uploaderDisplayCode: row.displayCode,
      upCount,
      downCount,
      score: upCount - downCount,
      currentVisitorVote: own === 1 ? 1 : own === -1 ? -1 : 0,
      preview400Url: `/api/photos/${row.id}/preview/400`,
      preview1200Url: `/api/photos/${row.id}/preview/1200`,
      originalUrl: `/api/photos/${row.id}/original`,
      downloadUrl: `/api/photos/${row.id}/download`,
    };
  });

  return { photos, summary: totals, totalPhotos: totals.photoCount };
}

/**
 * Whole-place totals in one row.
 *
 * The counts describe the place, not the page, so a hero never claims "08
 * photographs" when the place holds forty.
 */
async function placeTotals(prisma: PrismaClient, placeId: string): Promise<PlaceSummaryView> {
  const rows = await prisma.$queryRaw<
    Array<{
      photoCount: number | bigint;
      contributorCount: number | bigint;
      totalVotes: number | bigint;
    }>
  >`
    SELECT
      COUNT(DISTINCT ph.id) AS photoCount,
      COUNT(DISTINCT ph.visitorId) AS contributorCount,
      COALESCE(SUM(v.value), 0) AS totalVotes
    FROM Photo ph
    LEFT JOIN Vote v ON v.photoId = ph.id
    WHERE ph.placeId = ${placeId} AND ph.status = 'READY'
  `;

  const row = rows[0];
  if (row === undefined) {
    return { photoCount: 0, contributorCount: 0, totalVotes: 0 };
  }
  return {
    photoCount: Number(row.photoCount),
    contributorCount: Number(row.contributorCount),
    totalVotes: Number(row.totalVotes),
  };
}

/** The top-ranked photo, or null when the place is empty. */
export async function loadLeader(placeId: string, visitorId: string): Promise<PhotoView | null> {
  const { photos } = await loadRankedPhotos(placeId, visitorId, 1);
  return photos[0] ?? null;
}
