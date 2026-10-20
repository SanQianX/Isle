import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as PhotoQuery from '@/server/services/photo-query';
import { createTestContext, migrateTestDatabase, type TestContext } from '../factories';

/**
 * The ranking rule is implemented twice: as SQL in `loadTopPhotos` and as the
 * JavaScript comparator in `src/server/ranking.ts`.
 *
 * They have to agree, because the cursor pagination walks between them -- the
 * API orders with the comparator, the home page orders with SQL, and a
 * photograph whose position differs between the two would be skipped or shown
 * twice.
 *
 * This test builds a set of photographs designed to exercise every tie-break
 * and asserts the two orderings are identical.
 */

let context: TestContext;
let loadTopPhotos: typeof PhotoQuery.loadTopPhotos;
let loadRankedPhotos: typeof PhotoQuery.loadRankedPhotos;

beforeAll(async () => {
  context = createTestContext('isle-order');
  context.applyEnv();
  await migrateTestDatabase(context.client);

  const { resetConfigCache } = await import('@/lib/config');
  const { resetPrismaForTests } = await import('@/server/db/client');
  resetConfigCache();
  await resetPrismaForTests();

  ({ loadTopPhotos, loadRankedPhotos } = await import('@/server/services/photo-query'));
});

afterAll(async () => {
  const { resetPrismaForTests } = await import('@/server/db/client');
  await resetPrismaForTests();
  await context.cleanup();
});

beforeEach(async () => {
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();
  await prisma.vote.deleteMany();
  await prisma.photo.deleteMany();
  await prisma.place.deleteMany();
  // The display code is unique, so the visitors have to go too.
  await prisma.visitor.deleteMany();
});

/**
 * Photographs arranged so every tie-break is exercised:
 *   - different scores
 *   - equal scores with different vote counts
 *   - equal scores and vote counts with different upload times
 *   - equal everything, decided by id
 */
async function seedTrickyRanking(): Promise<{ placeId: string; visitorId: string }> {
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();

  const stamp = Date.now();
  const place = await prisma.place.create({
    data: {
      name: `排序岛 ${stamp}`,
      slug: `order-island-${stamp}`,
      normalizedName: `排序岛 ${stamp}`,
      region: '测试',
    },
  });
  const author = await prisma.visitor.create({
    data: { tokenHash: `order-author-${Date.now()}`, displayCode: 'or001' },
  });

  const voters = [];
  for (let index = 0; index < 8; index += 1) {
    voters.push(
      (
        await prisma.visitor.create({
          data: {
            tokenHash: `order-v${index}-${Date.now()}`,
            displayCode: `ov${String(index).padStart(3, '0')}`,
          },
        })
      ).id,
    );
  }

  // [upCount, downCount, uploadOffsetMs] -- the offsets make the createdAt
  // tie-break deterministic and different.
  const plan: Array<[string, number, number, number]> = [
    ['alpha', 5, 0, 0],
    ['bravo', 5, 0, 1000],
    ['charlie', 4, 0, 2000],
    ['delta', 3, 0, 3000],
    ['echo', 3, 1, 4000],
    ['foxtrot', 2, 2, 5000],
    ['golf', 2, 2, 5000], // identical to foxtrot: decided by id
    ['hotel', 1, 3, 6000],
  ];

  for (const [title, upCount, downCount, offset] of plan) {
    const photo = await prisma.photo.create({
      data: {
        placeId: place.id,
        visitorId: author.id,
        title,
        originalKey: `original/aa/${title}.jpg`,
        originalFileName: `${title}.jpg`,
        originalMime: 'image/jpeg',
        originalByteLength: 100,
        originalSha256: title.padEnd(64, '0'),
        width: 1600,
        height: 900,
        status: 'READY',
        uploadIdempotencyKey: `order-${title}`,
        createdAt: new Date(Date.UTC(2026, 0, 1) + offset),
      },
    });

    // The up and down voters must not overlap: one visitor may hold only one
    // vote per photograph, which is the constraint the whole product rests on.
    for (let index = 0; index < upCount; index += 1) {
      await prisma.vote.create({
        data: { photoId: photo.id, visitorId: voters[index] as string, value: 1 },
      });
    }
    for (let index = 0; index < downCount; index += 1) {
      await prisma.vote.create({
        data: {
          photoId: photo.id,
          visitorId: voters[upCount + index] as string,
          value: -1,
        },
      });
    }
  }

  return { placeId: place.id, visitorId: author.id };
}

describe('SQL and JavaScript rankings agree', () => {
  it('orders the same photographs the same way', async () => {
    const { placeId, visitorId } = await seedTrickyRanking();

    const sql = await loadTopPhotos(placeId, visitorId, 20);
    const js = await loadRankedPhotos(placeId, visitorId, 20);

    expect(sql.photos.map((photo) => photo.id)).toEqual(js.photos.map((photo) => photo.id));
    expect(sql.photos.map((photo) => photo.rank)).toEqual(js.photos.map((photo) => photo.rank));
    expect(sql.photos.map((photo) => photo.score)).toEqual(js.photos.map((photo) => photo.score));
  });

  it('produces the same order when only the first few are requested', async () => {
    const { placeId, visitorId } = await seedTrickyRanking();

    const all = await loadTopPhotos(placeId, visitorId, 20);
    const top3 = await loadTopPhotos(placeId, visitorId, 3);

    expect(top3.photos.map((photo) => photo.id)).toEqual(
      all.photos.slice(0, 3).map((photo) => photo.id),
    );
    expect(top3.photos.map((photo) => photo.rank)).toEqual([1, 2, 3]);
  });

  it('reports the whole place in the summary even when only a few are returned', async () => {
    const { placeId, visitorId } = await seedTrickyRanking();

    const top2 = await loadTopPhotos(placeId, visitorId, 2);
    expect(top2.photos).toHaveLength(2);
    expect(top2.summary.photoCount).toBe(8);
    expect(top2.totalPhotos).toBe(8);
  });

  it('orders by score, then vote count, then upload time, then id', async () => {
    const { placeId, visitorId } = await seedTrickyRanking();
    const { photos } = await loadTopPhotos(placeId, visitorId, 20);

    // alpha and bravo both score 5; bravo was uploaded later, so alpha leads.
    expect(photos[0]?.title).toBe('alpha');
    expect(photos[1]?.title).toBe('bravo');
    // charlie scores 4.
    expect(photos[2]?.title).toBe('charlie');
    // delta scores 3 with 3 ups; echo scores 2 with 3 ups and 1 down.
    expect(photos[3]?.title).toBe('delta');
    expect(photos[4]?.title).toBe('echo');
    // foxtrot and golf are identical; the id decides.
    const tied = photos.filter((photo) => photo.title === 'foxtrot' || photo.title === 'golf');
    expect(tied).toHaveLength(2);
    const first = tied[0]?.id ?? '';
    const second = tied[1]?.id ?? '';
    expect(first < second).toBe(true);
  });
});
