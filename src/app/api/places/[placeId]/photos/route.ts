import { ApiError, errorResponse } from '@/lib/errors';
import { getConfig } from '@/lib/config';
import { parseSingleFileUpload } from '@/server/image/multipart';
import {
  checkDurableQuota,
  checkMemoryRateLimit,
  dailyBucket,
  jsonWithCookie,
  LIMITS,
  rateLimited,
  requireReadContext,
  requireWriteContext,
} from '@/server/http/request';
import { ingestPhoto } from '@/server/services/photo';
import { getPlaceById, getPlaceBySlug } from '@/server/services/place';
import { getPrisma } from '@/server/db/client';
import {
  decodeCursor,
  encodeCursor,
  positionAfterCursor,
  rankingComparator,
  type Rankable,
} from '@/server/ranking';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ placeId: string }> };

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;

export type PhotoListItem = {
  id: string;
  title: string;
  description: string;
  rank: number;
  width: number;
  height: number;
  mime: string;
  bytes: number;
  score: number;
  upCount: number;
  downCount: number;
  currentVisitorVote: -1 | 0 | 1;
  uploader: { displayCode: string };
  preview400Url: string;
  preview1200Url: string;
  originalUrl: string;
  downloadUrl: string;
  createdAt: string;
};

/** Resolve the place by internal id or URL slug. */
async function resolvePlace(placeId: string) {
  const place = (await getPlaceById(placeId)) ?? (await getPlaceBySlug(placeId));
  if (place === null) throw ApiError.notFound('找不到该地点');
  return place;
}

/**
 * GET /api/places/:placeId/photos — the ranked leaderboard.
 *
 * Ordering is score DESC, upCount DESC, createdAt ASC, id ASC, computed
 * server-side from the Vote table. Only READY photos are ever returned.
 *
 * Pagination is a keyset cursor over that same sort tuple. Voting can change a
 * photo's sort key at any moment, so a cursor can stop resolving to a stable
 * position; rather than silently skipping rows we say so and let the caller
 * restart from the top (ADR-006).
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const readContext = await requireReadContext(request);
    const { placeId } = await context.params;

    const url = new URL(request.url);
    const rawLimit = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.trunc(rawLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const cursor = decodeCursor(url.searchParams.get('cursor'));

    const place = await resolvePlace(placeId);
    const prisma = await getPrisma();

    const photos = await prisma.photo.findMany({
      where: { placeId: place.id, status: 'READY' },
      include: {
        visitor: { select: { displayCode: true } },
        votes: { select: { value: true } },
      },
    });

    const ownVotes = await prisma.vote.findMany({
      where: { visitorId: readContext.visitor.id },
      select: { photoId: true, value: true },
    });
    const ownVoteByPhoto = new Map(ownVotes.map((vote) => [vote.photoId, vote.value]));

    const ranked = photos
      .map((photo) => {
        let upCount = 0;
        let downCount = 0;
        for (const vote of photo.votes) {
          if (vote.value > 0) upCount += 1;
          else if (vote.value < 0) downCount += 1;
        }
        return {
          id: photo.id,
          title: photo.title,
          description: photo.description,
          width: photo.width,
          height: photo.height,
          mime: photo.originalMime,
          bytes: photo.originalByteLength,
          createdAt: photo.createdAt,
          upCount,
          downCount,
          displayCode: photo.visitor.displayCode,
        };
      })
      // Rank the whole set before slicing, so `rank` is the true leaderboard
      // position rather than a position within a page.
      .sort(rankingComparator);

    const startIndex = cursor === null ? 0 : positionAfterCursor(ranked, cursor);
    if (cursor !== null && startIndex === -1) {
      return jsonWithCookie(
        {
          placeId: place.id,
          items: [],
          nextCursor: null,
          rankingMayHaveChanged: true,
          total: ranked.length,
        },
        readContext,
      );
    }

    const page = ranked.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < ranked.length;

    const items: PhotoListItem[] = page.map((photo, index) => ({
      id: photo.id,
      title: photo.title,
      description: photo.description,
      rank: startIndex + index + 1,
      width: photo.width,
      height: photo.height,
      mime: photo.mime,
      bytes: photo.bytes,
      score: photo.upCount - photo.downCount,
      upCount: photo.upCount,
      downCount: photo.downCount,
      currentVisitorVote: normaliseVote(ownVoteByPhoto.get(photo.id)),
      uploader: { displayCode: photo.displayCode },
      preview400Url: `/api/photos/${photo.id}/preview/400`,
      preview1200Url: `/api/photos/${photo.id}/preview/1200`,
      originalUrl: `/api/photos/${photo.id}/original`,
      downloadUrl: `/api/photos/${photo.id}/download`,
      createdAt: photo.createdAt.toISOString(),
    }));

    const last = page[page.length - 1];
    return jsonWithCookie(
      {
        placeId: place.id,
        items,
        nextCursor: hasMore && last !== undefined ? encodeCursor(last as Rankable) : null,
        rankingMayHaveChanged: false,
        total: ranked.length,
      },
      readContext,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function normaliseVote(value: number | undefined): -1 | 0 | 1 {
  if (value === 1) return 1;
  if (value === -1) return -1;
  return 0;
}

/**
 * POST /api/places/:placeId/photos — upload exactly one photo.
 *
 * The client batches by issuing several of these concurrently (two at a time,
 * per MAX_CONCURRENT_UPLOADS_PER_CLIENT); this endpoint deliberately accepts a
 * single file so one failure cannot take a whole batch down with it.
 */
export async function POST(request: Request, context: RouteContext): Promise<Response> {
  let cleanupPath: string | undefined;

  try {
    const config = getConfig();
    const writeContext = await requireWriteContext(request);
    const { placeId } = await context.params;

    // Burst limit first: cheap, in-memory, stops a runaway client early.
    const burst = checkMemoryRateLimit(
      writeContext.visitor.id,
      'photo-upload',
      LIMITS.uploadBurstPerMinute,
      60_000,
    );
    if (burst !== null) rateLimited(burst, '上传太频繁了，请稍后再试');

    // Durable daily quota, which survives a restart.
    const daily = await checkDurableQuota(writeContext.visitor.id, {
      name: dailyBucket('photo-upload'),
      limit: LIMITS.photosPerDay,
    });
    if (daily !== null) rateLimited(daily, '今天上传的照片太多了，明天再来吧');

    const place = await resolvePlace(placeId);

    const upload = await parseSingleFileUpload(request, {
      maxBytes: config.maxUploadBytes,
      maxFiles: 1,
      onFileCreated: (tempPath) => {
        cleanupPath = tempPath;
      },
    });

    const photo = await ingestPhoto({
      placeId: place.id,
      visitorId: writeContext.visitor.id,
      file: upload.file,
      title: upload.fields.title ?? '',
      description: upload.fields.description ?? '',
      idempotencyKey: upload.fields.idempotencyKey ?? '',
    });

    cleanupPath = undefined;

    // An idempotent replay is a success, not a fresh creation, so it answers 200.
    return jsonWithCookie({ photo }, writeContext, { status: photo.reused ? 200 : 201 });
  } catch (error) {
    if (cleanupPath !== undefined) {
      const { promises: fs } = await import('node:fs');
      await fs.rm(cleanupPath, { force: true }).catch(() => undefined);
    }
    return errorResponse(error);
  }
}
