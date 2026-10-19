import { getPrisma } from '@/server/db/client';
import { rankPhotos, tallyVotes } from '@/server/ranking';

/**
 * Page-level photo loading.
 *
 * Every page that shows photographs goes through here so the ranking rules live
 * in exactly one place: a home page that ordered differently from the ranking
 * page would be a silent, very confusing bug.
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
 * Ranked READY photos for a place, plus the rolled-up counts the hero shows.
 *
 * `limit` caps how many are materialised; pass a large number for the full
 * ranking page. Totals are computed over the *whole* place, not the page, so a
 * hero never claims "08 photos" when there are 40.
 */
export async function loadRankedPhotos(
  placeId: string,
  visitorId: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<{ photos: PhotoView[]; summary: PlaceSummaryView }> {
  const prisma = await getPrisma();

  const [rows, ownVotes] = await Promise.all([
    prisma.photo.findMany({
      where: { placeId, status: 'READY' },
      include: {
        visitor: { select: { displayCode: true } },
        votes: { select: { value: true } },
      },
    }),
    prisma.vote.findMany({ where: { visitorId }, select: { photoId: true, value: true } }),
  ]);

  const ownByPhoto = new Map(ownVotes.map((vote) => [vote.photoId, vote.value]));

  const totals = tallyVotes(
    rows.flatMap((row) => row.votes.map((vote) => ({ photoId: row.id, value: vote.value }))),
  );

  const summary: PlaceSummaryView = {
    photoCount: rows.length,
    contributorCount: new Set(rows.map((row) => row.visitorId)).size,
    totalVotes: [...totals.values()].reduce(
      (sum, counts) => sum + counts.upCount - counts.downCount,
      0,
    ),
  };

  // Rank the entire set before slicing, so `rank` is the true leaderboard
  // position and not a position within whatever page we happen to return.
  const ranked = rankPhotos(
    rows.map((row) => {
      const counts = totals.get(row.id) ?? { upCount: 0, downCount: 0 };
      const own = ownByPhoto.get(row.id);
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        width: row.width,
        height: row.height,
        mime: row.originalMime,
        bytes: row.originalByteLength,
        createdAt: row.createdAt,
        uploaderDisplayCode: row.visitor.displayCode,
        upCount: counts.upCount,
        downCount: counts.downCount,
        score: counts.upCount - counts.downCount,
        currentVisitorVote: (own === 1 ? 1 : own === -1 ? -1 : 0) as -1 | 0 | 1,
        preview400Url: `/api/photos/${row.id}/preview/400`,
        preview1200Url: `/api/photos/${row.id}/preview/1200`,
        originalUrl: `/api/photos/${row.id}/original`,
        downloadUrl: `/api/photos/${row.id}/download`,
      };
    }),
  );

  const limited = Number.isFinite(limit) ? ranked.slice(0, limit) : ranked;

  return {
    photos: limited.map((photo, index) => ({ ...photo, rank: index + 1 })),
    summary,
  };
}

/** The top-ranked photo, or null when the place is empty. */
export async function loadLeader(placeId: string, visitorId: string): Promise<PhotoView | null> {
  const { photos } = await loadRankedPhotos(placeId, visitorId, 1);
  return photos[0] ?? null;
}
