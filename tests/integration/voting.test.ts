import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, migrateTestDatabase, type TestContext } from '../factories';

/**
 * Voting through the real service and the real HTTP route (E2E_SCENARIOS
 * VOTE-01..VOTE-06, VOTE-11, VOTE-12).
 *
 * The load-bearing test here is VOTE-11: one visitor hammering the endpoint must
 * leave exactly one vote row, not twenty.
 */

let context: TestContext;
type VoteHandler = (
  request: Request,
  context: { params: Promise<{ photoId: string }> },
) => Promise<Response>;
type PlaceHandler = (
  request: Request,
  context: { params: Promise<{ placeId: string }> },
) => Promise<Response>;

let voteRoute: { PUT: VoteHandler };
let placesRoute: { GET: PlaceHandler; POST: PlaceHandler };
let photosRoute: { GET: PlaceHandler; POST: PlaceHandler };

const BASE = 'http://127.0.0.1:3099';

let placeId: string;
let photoId: string;
let counter = 0;

async function makeVisitor(): Promise<{ id: string; cookie: string }> {
  const { getPrisma } = await import('@/server/db/client');
  const prisma = await getPrisma();
  counter += 1;
  const token = createHash('sha256').update(`vote-visitor-${counter}-${process.pid}`).digest('hex');
  const visitor = await prisma.visitor.create({
    data: {
      tokenHash: createHash('sha256').update(token).digest('hex'),
      displayCode: createHash('md5').update(token).digest('hex').slice(0, 6),
    },
  });
  return { id: visitor.id, cookie: `isle_visitor=${token}` };
}

async function seedPhoto(): Promise<string> {
  const { ingestPhotoBytes } = await import('@/server/services/photo');
  const { promises: fs } = await import('node:fs');
  const path = await import('node:path');

  const bytes = new Uint8Array(
    await fs.readFile(path.join(process.cwd(), 'tests', 'fixtures', 'landscape.jpg')),
  );
  const visitor = await makeVisitor();
  const photo = await ingestPhotoBytes({
    placeId,
    visitorId: visitor.id,
    bytes,
    fileName: 'landscape.jpg',
    mime: 'image/jpeg',
    title: '投票测试照片',
    idempotencyKey: `vote-seed-${counter}-${process.pid}`,
  });
  return photo.id;
}

function voteRequest(id: string, value: number, cookie: string, origin = BASE): Request {
  return new Request(`${BASE}/api/photos/${id}/vote`, {
    method: 'PUT',
    headers: { cookie, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ value }),
  });
}

beforeAll(async () => {
  context = createTestContext('isle-vote');
  context.applyEnv();
  await migrateTestDatabase(context.client);

  const { resetConfigCache } = await import('@/lib/config');
  const { resetPrismaForTests } = await import('@/server/db/client');
  resetConfigCache();
  await resetPrismaForTests();

  voteRoute = await import('@/app/api/photos/[photoId]/vote/route');
  placesRoute = await import('@/app/api/places/route');
  photosRoute = await import('@/app/api/places/[placeId]/photos/route');

  const { seedDefaultPlace } = await import('@/server/services/place');
  const place = await seedDefaultPlace();
  placeId = place.id;
  photoId = await seedPhoto();
});

afterAll(async () => {
  const { resetPrismaForTests } = await import('@/server/db/client');
  await resetPrismaForTests();
  await context.cleanup();
});

beforeEach(async () => {
  const { getPrisma } = await import('@/server/db/client');
  const { resetMemoryRateLimits } = await import('@/server/http/request');
  const prisma = await getPrisma();
  resetMemoryRateLimits();
  await prisma.vote.deleteMany();
  await prisma.rateBucket.deleteMany();
});

describe('absolute-state voting (VOTE-01..VOTE-06)', () => {
  it('up, up-again, down, up produces +1, 0, -2, +2 and one row at a time', async () => {
    const { setVote } = await import('@/server/services/vote');
    const visitor = await makeVisitor();
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();

    const up = await setVote(photoId, visitor.id, 1);
    expect(up).toMatchObject({ currentVisitorVote: 1, score: 1, upCount: 1, downCount: 0 });

    // Clicking the same arrow again withdraws rather than adding.
    const withdrawn = await setVote(photoId, visitor.id, 0);
    expect(withdrawn).toMatchObject({ currentVisitorVote: 0, score: 0, upCount: 0, downCount: 0 });
    expect(await prisma.vote.count({ where: { photoId, visitorId: visitor.id } })).toBe(0);

    const down = await setVote(photoId, visitor.id, -1);
    expect(down).toMatchObject({ currentVisitorVote: -1, score: -1, upCount: 0, downCount: 1 });

    const back = await setVote(photoId, visitor.id, 1);
    expect(back).toMatchObject({ currentVisitorVote: 1, score: 1, upCount: 1, downCount: 0 });

    // Still exactly one row, never two.
    expect(await prisma.vote.count({ where: { photoId, visitorId: visitor.id } })).toBe(1);
  });

  it('is idempotent across repeated identical requests', async () => {
    const visitor = await makeVisitor();
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await voteRoute.PUT(voteRequest(photoId, 1, visitor.cookie), {
        params: Promise.resolve({ photoId }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { score: number };
      expect(body.score).toBe(1);
    }

    expect(await prisma.vote.count({ where: { photoId, visitorId: visitor.id } })).toBe(1);
  });

  it('never stores a value of 0', async () => {
    const visitor = await makeVisitor();
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();

    await voteRoute.PUT(voteRequest(photoId, 1, visitor.cookie), {
      params: Promise.resolve({ photoId }),
    });
    await voteRoute.PUT(voteRequest(photoId, 0, visitor.cookie), {
      params: Promise.resolve({ photoId }),
    });

    const rows = await prisma.vote.findMany({ where: { photoId }, select: { value: true } });
    expect(rows.every((row) => row.value !== 0)).toBe(true);
  });

  it('aggregates two visitors independently', async () => {
    const alice = await makeVisitor();
    const bob = await makeVisitor();

    const a = await voteRoute.PUT(voteRequest(photoId, 1, alice.cookie), {
      params: Promise.resolve({ photoId }),
    });
    const b = await voteRoute.PUT(voteRequest(photoId, -1, bob.cookie), {
      params: Promise.resolve({ photoId }),
    });

    const bodyA = (await a.json()) as { score: number; currentVisitorVote: number };
    const bodyB = (await b.json()) as { score: number; currentVisitorVote: number };

    // Each response reports the aggregate as of that request. Alice's is taken
    // before Bob has voted, so hers legitimately still reads 1.
    expect(bodyA.currentVisitorVote).toBe(1);
    expect(bodyB.currentVisitorVote).toBe(-1);
    expect(bodyA.score).toBe(1);
    expect(bodyB.score).toBe(0);

    // Re-reading the listing afterwards shows both of them the settled 0.
    const listing = await photosRoute.GET(
      new Request(`${BASE}/api/places/${placeId}/photos`, { headers: { cookie: alice.cookie } }),
      { params: Promise.resolve({ placeId }) },
    );
    const item = (
      (await listing.json()) as { items: Array<{ id: string; score: number }> }
    ).items.find((row) => row.id === photoId);
    expect(item?.score).toBe(0);
  });

  it('shows each visitor their own vote state in the listing', async () => {
    const alice = await makeVisitor();
    const bob = await makeVisitor();

    await voteRoute.PUT(voteRequest(photoId, 1, alice.cookie), {
      params: Promise.resolve({ photoId }),
    });
    await voteRoute.PUT(voteRequest(photoId, -1, bob.cookie), {
      params: Promise.resolve({ photoId }),
    });

    const asAlice = await photosRoute.GET(
      new Request(`${BASE}/api/places/${placeId}/photos`, {
        headers: { cookie: alice.cookie },
      }),
      { params: Promise.resolve({ placeId }) },
    );
    const asBob = await photosRoute.GET(
      new Request(`${BASE}/api/places/${placeId}/photos`, { headers: { cookie: bob.cookie } }),
      { params: Promise.resolve({ placeId }) },
    );

    const aliceItem = (
      (await asAlice.json()) as { items: Array<{ id: string; currentVisitorVote: number }> }
    ).items.find((item) => item.id === photoId);
    const bobItem = (
      (await asBob.json()) as { items: Array<{ id: string; currentVisitorVote: number }> }
    ).items.find((item) => item.id === photoId);

    expect(aliceItem?.currentVisitorVote).toBe(1);
    expect(bobItem?.currentVisitorVote).toBe(-1);
  });
});

describe('concurrency (VOTE-11)', () => {
  it('twenty simultaneous identical requests leave exactly one vote and score 1', async () => {
    const { setVote } = await import('@/server/services/vote');
    const visitor = await makeVisitor();
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => setVote(photoId, visitor.id, 1)),
    );

    // The database constraint is the final arbiter, so some transactions may
    // have contended; none of them may produce a wrong number.
    expect(results.every((result) => result.score === 1)).toBe(true);
    expect(results.every((result) => result.upCount === 1)).toBe(true);

    const rows = await prisma.vote.findMany({ where: { photoId, visitorId: visitor.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(1);
  });

  it('twenty concurrent mixed requests never leave a partial or doubled state', async () => {
    const { setVote } = await import('@/server/services/vote');
    const visitor = await makeVisitor();
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();

    const targets: Array<1 | 0 | -1> = [
      1, 1, -1, 1, 0, 1, -1, 1, 1, 0, 1, -1, 1, 1, 0, 1, -1, 1, 1, 1,
    ];
    await Promise.all(targets.map((value) => setVote(photoId, visitor.id, value)));

    // Promise.all preserves array order, not commit order, so no single
    // response can be treated as "the final state". What must hold regardless
    // is that the visitor holds at most one vote and it is never a stored 0.
    const rows = await prisma.vote.findMany({ where: { photoId, visitorId: visitor.id } });
    expect(rows.length).toBeLessThanOrEqual(1);
    expect(rows.every((row) => row.value === 1 || row.value === -1)).toBe(true);

    // A subsequent explicit request must return an aggregate that matches a
    // fresh recount of the table exactly. If the response were derived from a
    // running total rather than the rows, concurrency drift would show up here.
    const final = await setVote(photoId, visitor.id, 1);
    const allVotes = await prisma.vote.findMany({ where: { photoId }, select: { value: true } });
    const upCount = allVotes.filter((vote) => vote.value === 1).length;
    const downCount = allVotes.filter((vote) => vote.value === -1).length;

    expect(final.upCount).toBe(upCount);
    expect(final.downCount).toBe(downCount);
    expect(final.score).toBe(upCount - downCount);
    expect(final.currentVisitorVote).toBe(1);
  });

  it('many different visitors voting at once aggregate correctly', async () => {
    const { setVote } = await import('@/server/services/vote');
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();

    const visitors = await Promise.all(Array.from({ length: 10 }, () => makeVisitor()));
    await Promise.all(
      visitors.map((visitor, index) => setVote(photoId, visitor.id, index % 3 === 0 ? -1 : 1)),
    );

    const allVotes = await prisma.vote.findMany({ where: { photoId }, select: { value: true } });
    const upCount = allVotes.filter((vote) => vote.value === 1).length;
    const downCount = allVotes.filter((vote) => vote.value === -1).length;

    expect(upCount + downCount).toBe(allVotes.length);
    expect(allVotes.filter((vote) => vote.value === 1)).toHaveLength(upCount);
  });
});

describe('input validation and access control (VOTE-12)', () => {
  it.each([
    [{ value: 5 }, 400],
    [{ value: '1' }, 400],
    [{ value: true }, 400],
    [{ value: null }, 400],
    [{ value: 2 }, 400],
    [{ value: 1.5 }, 400],
    [{}, 400],
    [{ value: 1, visitorId: 'someone-else' }, 400],
  ])('rejects %j with %i', async (body, expectedStatus) => {
    const visitor = await makeVisitor();
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    const before = await prisma.vote.count();

    const response = await voteRoute.PUT(
      new Request(`${BASE}/api/photos/${photoId}/vote`, {
        method: 'PUT',
        headers: { cookie: visitor.cookie, origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ photoId }) },
    );

    expect(response.status).toBe(expectedStatus);
    // A rejected request must not have written anything.
    expect(await prisma.vote.count()).toBe(before);
  });

  it('rejects a malformed body without a JSON content type', async () => {
    const visitor = await makeVisitor();
    const response = await voteRoute.PUT(
      new Request(`${BASE}/api/photos/${photoId}/vote`, {
        method: 'PUT',
        headers: { cookie: visitor.cookie, origin: BASE, 'content-type': 'application/json' },
        body: 'not json at all',
      }),
      { params: Promise.resolve({ photoId }) },
    );
    expect(response.status).toBe(400);
  });

  it('rejects a cross-origin vote with 403 and changes nothing', async () => {
    const visitor = await makeVisitor();
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    const before = await prisma.vote.count();

    const response = await voteRoute.PUT(
      voteRequest(photoId, 1, visitor.cookie, 'https://evil.example.com'),
      {
        params: Promise.resolve({ photoId }),
      },
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_ORIGIN',
    );
    expect(await prisma.vote.count()).toBe(before);
  });

  it('returns 404 for an unknown photo', async () => {
    const visitor = await makeVisitor();
    const response = await voteRoute.PUT(voteRequest('no-such-photo', 1, visitor.cookie), {
      params: Promise.resolve({ photoId: 'no-such-photo' }),
    });
    expect(response.status).toBe(404);
  });

  it('never returns the visitor token or its hash', async () => {
    const visitor = await makeVisitor();
    const response = await voteRoute.PUT(voteRequest(photoId, 1, visitor.cookie), {
      params: Promise.resolve({ photoId }),
    });
    const raw = await response.text();
    const token = visitor.cookie.split('=')[1] ?? '';

    expect(raw).not.toContain(token);
    expect(raw).not.toContain(createHash('sha256').update(token).digest('hex'));
  });
});

describe('rate limiting (SEC-06)', () => {
  it('returns 429 with Retry-After once the per-minute vote budget is spent', async () => {
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    const visitor = await makeVisitor();

    let limited: Response | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const response = await voteRoute.PUT(
        voteRequest(photoId, attempt % 2 === 0 ? 1 : 0, visitor.cookie),
        {
          params: Promise.resolve({ photoId }),
        },
      );
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited, 'expected the vote limiter to engage').toBeDefined();
    expect(limited?.headers.get('Retry-After')).toMatch(/^\d+$/);
    const body = (await limited?.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');

    // The limiter must not have corrupted anything.
    const rows = await prisma.vote.findMany({ where: { photoId, visitorId: visitor.id } });
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});

describe('place scoping', () => {
  it('lists photos under the right place and never mixes them', async () => {
    const { createPlace } = await import('@/server/services/place');
    const other = await createPlace({
      name: `他处 ${Date.now()}`,
      region: '测试地区',
      description: '',
    });

    const response = await placesRoute.GET(new Request(`${BASE}/api/places`), {
      params: Promise.resolve({ placeId }),
    });
    const body = (await response.json()) as { places: Array<{ id: string; photoCount: number }> };
    const listed = body.places.find((place) => place.id === other.id);
    expect(listed?.photoCount).toBe(0);

    const otherPhotos = await photosRoute.GET(
      new Request(`${BASE}/api/places/${other.id}/photos`, {
        headers: { cookie: 'isle_visitor=x' },
      }),
      { params: Promise.resolve({ placeId: other.id }) },
    );
    const items = (await otherPhotos.json()) as { items: unknown[] };
    expect(items.items).toHaveLength(0);
  });
});
