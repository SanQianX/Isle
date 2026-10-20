import { randomBytes } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { ApiError } from '@/lib/errors';
import { buildPlaceSlug, normalizePlaceName } from '@/lib/place-name';
import { getPrisma } from '@/server/db/client';

/**
 * Place reads and writes.
 *
 * Length limits live here as Zod schemas rather than as database constraints,
 * because SQLite has no length-constrained column type (DATA_API_STORAGE §1).
 * They are enforced again in the route layer, so an over-long string is
 * rejected with 400 before it can reach the unique-constraint path.
 */

// FRONTEND_UX §3.6: name 1–60 characters, region 2–80, description <= 300.
export const placeNameSchema = z.string().min(1, '请填写地点名称').max(60, '地点名称最多 60 个字');

export const placeRegionSchema = z
  .string()
  .min(2, '请填写所在地区')
  .max(80, '所在地区最多 80 个字');

export const placeDescriptionSchema = z
  .string()
  .max(300, '介绍最多 300 个字')
  .optional()
  .default('');

export const createPlaceSchema = z.object({
  name: placeNameSchema,
  region: placeRegionSchema,
  description: placeDescriptionSchema,
});

export type CreatePlaceInput = z.infer<typeof createPlaceSchema>;

export type PlaceSummary = {
  id: string;
  slug: string;
  name: string;
  region: string;
  description: string;
  createdAt: string;
  photoCount: number;
  contributorCount: number;
  coverPhotoId: string | null;
};

export type PlaceDetail = PlaceSummary & {
  totalVotes: number;
};

/**
 * Per-place counts, aggregated by the database.
 *
 * The list page needs three numbers per place and nothing else. Fetching every
 * photo and every vote of every place to count them meant the list got slower
 * as the *whole site* accumulated photographs -- a place with 500 shots made
 * every other place's row more expensive to read.
 *
 * The SQL is a plain JOIN with a GROUP BY, so it moves to another engine
 * unchanged.
 */
type PlaceAggregate = {
  placeId: string;
  photoCount: number | bigint;
  contributorCount: number | bigint;
  totalVotes: number | bigint;
};

const EMPTY_TALLY = { photoCount: 0, contributorCount: 0, totalVotes: 0 };

async function aggregatePlaces(
  prisma: PrismaClient,
): Promise<Map<string, { photoCount: number; contributorCount: number; totalVotes: number }>> {
  const rows = await prisma.$queryRaw<Array<PlaceAggregate>>`
    SELECT
      p.id AS placeId,
      COUNT(DISTINCT ph.id) AS photoCount,
      COUNT(DISTINCT ph.visitorId) AS contributorCount,
      COALESCE(SUM(v.value), 0) AS totalVotes
    FROM Place p
    LEFT JOIN Photo ph ON ph.placeId = p.id AND ph.status = 'READY'
    LEFT JOIN Vote v ON v.photoId = ph.id
    GROUP BY p.id
  `;

  const result = new Map<
    string,
    { photoCount: number; contributorCount: number; totalVotes: number }
  >();
  for (const row of rows) {
    result.set(row.placeId, {
      photoCount: Number(row.photoCount),
      contributorCount: Number(row.contributorCount),
      totalVotes: Number(row.totalVotes),
    });
  }
  return result;
}

/** The same counts for a single place. */
async function aggregatePlacesFor(
  prisma: PrismaClient,
  placeId: string,
): Promise<{ photoCount: number; contributorCount: number; totalVotes: number }> {
  const rows = await prisma.$queryRaw<Array<PlaceAggregate>>`
    SELECT
      p.id AS placeId,
      COUNT(DISTINCT ph.id) AS photoCount,
      COUNT(DISTINCT ph.visitorId) AS contributorCount,
      COALESCE(SUM(v.value), 0) AS totalVotes
    FROM Place p
    LEFT JOIN Photo ph ON ph.placeId = p.id AND ph.status = 'READY'
    LEFT JOIN Vote v ON v.photoId = ph.id
    WHERE p.id = ${placeId}
    GROUP BY p.id
  `;

  const row = rows[0];
  if (row === undefined) return EMPTY_TALLY;
  return {
    photoCount: Number(row.photoCount),
    contributorCount: Number(row.contributorCount),
    totalVotes: Number(row.totalVotes),
  };
}

export async function listPlaces(): Promise<PlaceSummary[]> {
  const prisma = await getPrisma();
  const [places, counts] = await Promise.all([
    prisma.place.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    aggregatePlaces(prisma),
  ]);

  return places.map((place) => {
    const tally = counts.get(place.id) ?? {
      photoCount: 0,
      contributorCount: 0,
      totalVotes: 0,
    };
    return {
      id: place.id,
      slug: place.slug,
      name: place.name,
      region: place.region,
      description: place.description,
      createdAt: place.createdAt.toISOString(),
      photoCount: tally.photoCount,
      contributorCount: tally.contributorCount,
      coverPhotoId: null,
    };
  });
}

/**
 * The place shown on `/`. Pinned by FEATURED_PLACE_SLUG when set, otherwise the
 * oldest place, so the home page is stable across restarts.
 */
export async function getFeaturedPlace(): Promise<PlaceDetail | null> {
  const config = (await import('@/lib/config')).getConfig();
  const prisma = await getPrisma();

  const place = config.featuredPlaceSlug
    ? await prisma.place.findUnique({ where: { slug: config.featuredPlaceSlug } })
    : await prisma.place.findFirst({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  if (place === null) return null;
  return toDetail(place, await aggregatePlacesFor(prisma, place.id));
}

function toDetail(
  place: {
    id: string;
    slug: string;
    name: string;
    region: string;
    description: string;
    createdAt: Date;
  },
  tally: { photoCount: number; contributorCount: number; totalVotes: number },
): PlaceDetail {
  return {
    id: place.id,
    slug: place.slug,
    name: place.name,
    region: place.region,
    description: place.description,
    createdAt: place.createdAt.toISOString(),
    photoCount: tally.photoCount,
    contributorCount: tally.contributorCount,
    coverPhotoId: null,
    totalVotes: tally.totalVotes,
  };
}

export async function getPlaceBySlug(slug: string): Promise<PlaceDetail | null> {
  const prisma = await getPrisma();
  const place = await prisma.place.findUnique({ where: { slug } });
  if (place === null) return null;
  return toDetail(place, await aggregatePlacesFor(prisma, place.id));
}

export async function getPlaceById(id: string): Promise<PlaceDetail | null> {
  const prisma = await getPrisma();
  const place = await prisma.place.findUnique({ where: { id } });
  if (place === null) return null;
  return toDetail(place, await aggregatePlacesFor(prisma, place.id));
}

/** True for any unique-constraint violation; see the call site for why the
 * field Prisma reports is deliberately not inspected. */
function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Create a place, or report a conflict the caller can act on.
 *
 * The duplicate check on normalizedName is a real unique constraint, so two
 * simultaneous requests for the same name cannot both win — the loser gets
 * DUPLICATE_PLACE and, when the existing place can be identified, a link to it.
 */
export async function createPlace(input: CreatePlaceInput): Promise<PlaceDetail> {
  const prisma = await getPrisma();

  const normalizedName = normalizePlaceName(input.name);
  if (normalizedName.length === 0) {
    throw ApiError.badRequest('请填写地点名称');
  }

  const name = normalizedName;
  const region = input.region.trim();
  if (region.length < 2) {
    throw ApiError.badRequest('请填写所在地区');
  }

  const existing = await prisma.place.findUnique({ where: { normalizedName } });
  if (existing !== null) {
    throw ApiError.duplicatePlace(`「${name}」已经存在`, {
      existingPlaceId: existing.id,
      slug: existing.slug,
    });
  }

  // A Latin name yields a readable slug; anything else gets an opaque one. The
  // seed keeps a collision retry deterministic instead of looping forever.
  const slugSeed = `${normalizedName}|${Date.now()}|${Math.random()}`;
  const slug = buildPlaceSlug(name, slugSeed);

  // A freshly created place holds no photographs yet, so its counts are known
  // without asking the database.
  const insert = async (candidateSlug: string) =>
    toDetail(
      await prisma.place.create({
        data: {
          name,
          slug: candidateSlug,
          normalizedName,
          region,
          description: input.description.trim(),
        },
      }),
      EMPTY_TALLY,
    );

  /**
   * Find the place that won a race, if there is one.
   *
   * Polls briefly: when two requests create the same name at once, the loser
   * can hit the unique constraint before the winner's transaction is visible.
   * A single lookup would miss it and report a meaningless internal error.
   */
  const findWinner = async (): Promise<{ id: string; slug: string } | null> => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const found = await prisma.place.findUnique({
        where: { normalizedName },
        select: { id: true, slug: true },
      });
      if (found !== null) return found;
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
    return null;
  };

  const conflict = async (): Promise<ApiError> => {
    // SQLite reports a single field for P2002 -- whichever index it checked
    // first -- so the reported name cannot be trusted to say which constraint
    // fired. Ask the database which one it was.
    const winner = await findWinner();
    if (winner !== null) {
      return ApiError.duplicatePlace(`「${name}」已经存在`, {
        existingPlaceId: winner.id,
        slug: winner.slug,
      });
    }
    // A genuine storage problem, surfaced as retryable rather than as a 500 the
    // caller can do nothing about.
    return new ApiError('STORAGE_UNAVAILABLE', '暂时无法保存这个地点，请稍后再试');
  };

  try {
    return await insert(slug);
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    // No row carries this name, so the slug collided -- and it collided with a
    // *different* place. That is possible because a name whose only ASCII is
    // digits slugifies to those digits, so "A 123" and "B 123" both want
    // "123".
    //
    // An empty name forces the opaque branch, because buildPlaceSlug ignores
    // its seed while ASCII characters remain. Passing the name again would
    // deterministically reproduce the slug that just collided.
    const retrySlug = buildPlaceSlug('', `${slugSeed}|retry|${randomBytes(8).toString('hex')}`);
    try {
      return await insert(retrySlug);
    } catch (retryError) {
      if (isUniqueConstraintError(retryError)) throw await conflict();
      throw retryError;
    }
  }
}

/**
 * Idempotent seed of the default place.
 *
 * Keyed on normalizedName, so running it on every boot — or twice in a row —
 * leaves exactly one 桂山岛.
 */
export const DEFAULT_PLACE = {
  name: '桂山岛',
  slug: 'guishan-island',
  region: '广东 · 珠海 · 万山群岛',
  description: '来看看大家在桂山岛拍下的风景，一起选出这里最好看的那张照片。',
} as const;

export async function seedDefaultPlace(): Promise<PlaceDetail> {
  const prisma = await getPrisma();
  const normalizedName = normalizePlaceName(DEFAULT_PLACE.name);

  const existing = await prisma.place.findFirst({
    where: { OR: [{ slug: DEFAULT_PLACE.slug }, { normalizedName }] },
  });
  if (existing !== null) {
    return toDetail(existing, await aggregatePlacesFor(prisma, existing.id));
  }

  return toDetail(
    await prisma.place.create({
      data: {
        name: DEFAULT_PLACE.name,
        slug: DEFAULT_PLACE.slug,
        normalizedName,
        region: DEFAULT_PLACE.region,
        description: DEFAULT_PLACE.description,
      },
    }),
    EMPTY_TALLY,
  );
}
