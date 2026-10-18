import { Prisma } from '@prisma/client';
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

/** Row shape used for listing; keeps the public contract separate from Prisma. */
type PlaceWithCounts = Prisma.PlaceGetPayload<{
  include: {
    photos: {
      where: { status: string };
      select: { visitorId: true; votes: { select: { value: true } } };
    };
  };
}>;

function summarize(place: PlaceWithCounts): PlaceSummary {
  return {
    id: place.id,
    slug: place.slug,
    name: place.name,
    region: place.region,
    description: place.description,
    createdAt: place.createdAt.toISOString(),
    photoCount: place.photos.length,
    contributorCount: new Set(place.photos.map((photo) => photo.visitorId)).size,
    coverPhotoId: null,
  };
}

const placeInclude = {
  photos: {
    where: { status: 'READY' },
    select: { visitorId: true, votes: { select: { value: true } } },
  },
} satisfies Prisma.PlaceInclude;

export async function listPlaces(): Promise<PlaceSummary[]> {
  const prisma = await getPrisma();
  const places = await prisma.place.findMany({
    include: placeInclude,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return places.map(summarize);
}

/**
 * The place shown on `/`. Pinned by FEATURED_PLACE_SLUG when set, otherwise the
 * oldest place, so the home page is stable across restarts.
 */
export async function getFeaturedPlace(): Promise<PlaceDetail | null> {
  const config = (await import('@/lib/config')).getConfig();
  const prisma = await getPrisma();

  const place = config.featuredPlaceSlug
    ? await prisma.place.findUnique({
        where: { slug: config.featuredPlaceSlug },
        include: placeInclude,
      })
    : await prisma.place.findFirst({
        include: placeInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

  if (place === null) return null;
  return toDetail(place);
}

function toDetail(place: PlaceWithCounts): PlaceDetail {
  const summary = summarize(place);
  const totalVotes = place.photos.reduce(
    (sum, photo) => sum + photo.votes.reduce((inner, vote) => inner + vote.value, 0),
    0,
  );
  return { ...summary, totalVotes };
}

export async function getPlaceBySlug(slug: string): Promise<PlaceDetail | null> {
  const prisma = await getPrisma();
  const place = await prisma.place.findUnique({ where: { slug }, include: placeInclude });
  return place === null ? null : toDetail(place);
}

export async function getPlaceById(id: string): Promise<PlaceDetail | null> {
  const prisma = await getPrisma();
  const place = await prisma.place.findUnique({ where: { id }, include: placeInclude });
  return place === null ? null : toDetail(place);
}

function isUniqueConstraintError(error: unknown, field: 'normalizedName' | 'slug'): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  const target = error.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.includes(field);
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

  try {
    const place = await prisma.place.create({
      data: { name, slug, normalizedName, region, description: input.description.trim() },
      include: placeInclude,
    });
    return toDetail(place);
  } catch (error) {
    if (isUniqueConstraintError(error, 'normalizedName')) {
      throw ApiError.duplicatePlace(`「${name}」已经存在`, { reason: 'normalizedName' });
    }
    if (isUniqueConstraintError(error, 'slug')) {
      // Astronomically unlikely with 32 bits of entropy plus the name; retry
      // once with fresh randomness rather than surfacing a 500.
      const retrySlug = buildPlaceSlug(name, `${slugSeed}|retry`);
      try {
        const place = await prisma.place.create({
          data: {
            name,
            slug: retrySlug,
            normalizedName,
            region,
            description: input.description.trim(),
          },
          include: placeInclude,
        });
        return toDetail(place);
      } catch (retryError) {
        if (isUniqueConstraintError(retryError, 'normalizedName')) {
          throw ApiError.duplicatePlace(`「${name}」已经存在`, { reason: 'normalizedName' });
        }
        throw retryError;
      }
    }
    throw error;
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
    include: placeInclude,
  });
  if (existing !== null) return toDetail(existing);

  return toDetail(
    await prisma.place.create({
      data: {
        name: DEFAULT_PLACE.name,
        slug: DEFAULT_PLACE.slug,
        normalizedName,
        region: DEFAULT_PLACE.region,
        description: DEFAULT_PLACE.description,
      },
      include: placeInclude,
    }),
  );
}
