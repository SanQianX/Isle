import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ORIGIN } from '../support';

/**
 * Voting through the real HTTP endpoint (E2E_SCENARIOS VOTE-01..VOTE-12).
 *
 * Each browser context is a distinct visitor with its own cookie, so two
 * contexts in this file are two different people as far as the server is
 * concerned. Votes go through the same PUT endpoint the UI will call; the UI
 * wiring itself is exercised in Phase 07.
 */

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

type VoteResponse = {
  photoId: string;
  currentVisitorVote: number;
  score: number;
  upCount: number;
  downCount: number;
  rankingMayHaveChanged: boolean;
};

async function firstPhoto(request: APIRequestContext, place: string): Promise<string> {
  const response = await request.get(`${ORIGIN}/api/places/${place}/photos`);
  const body = (await response.json()) as { items: Array<{ id: string }> };
  const photo = body.items[0];
  if (photo === undefined) throw new Error('seeded leaderboard is empty');
  return photo.id;
}

async function defaultPlace(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${ORIGIN}/api/places`);
  const body = (await response.json()) as { places: Array<{ id: string; slug: string }> };
  const guishan = body.places.find((place) => place.slug === 'guishan-island');
  if (guishan === undefined) throw new Error('default place missing');
  return guishan.id;
}

async function vote(
  request: APIRequestContext,
  photoId: string,
  value: number,
): Promise<{ status: number; body: VoteResponse }> {
  const response = await request.put(`${ORIGIN}/api/photos/${photoId}/vote`, { data: { value } });
  return { status: response.status(), body: (await response.json()) as VoteResponse };
}

/**
 * Create a place owned by this test and upload one photo into it.
 *
 * The seeded leaderboard is shared by every Playwright worker, so any assertion
 * about an absolute score races against other tests voting at the same moment.
 * Each test therefore builds its own two-photo leaderboard and all score
 * assertions are relative to that.
 */
async function setupIsolatedPlace(request: APIRequestContext): Promise<{
  placeId: string;
  photoIds: string[];
  listUrl: string;
}> {
  const created = await request.post(`${ORIGIN}/api/places`, {
    data: { name: `投票测试岛 ${process.pid}-${Date.now()}-${Math.random()}`, region: '测试地区' },
  });
  expect(created.status()).toBe(201);
  const place = (await created.json()) as { place: { id: string } };

  const photoIds: string[] = [];
  for (const file of ['landscape.jpg', 'portrait.jpg']) {
    const response = await request.post(`${ORIGIN}/api/places/${place.place.id}/photos`, {
      multipart: {
        file: {
          name: file,
          mimeType: 'image/jpeg',
          buffer: await fs.readFile(path.join(FIXTURES, file)),
        },
        title: file,
        idempotencyKey: `vote-${process.pid}-${file}-${Date.now()}-${Math.random()}`,
      },
    });
    expect(response.status()).toBe(201);
    const body = (await response.json()) as { photo: { id: string } };
    photoIds.push(body.photo.id);
  }

  return {
    placeId: place.place.id,
    photoIds,
    listUrl: `${ORIGIN}/api/places/${place.place.id}/photos`,
  };
}

test('up, withdraw, switch, switch back produces +1, 0, -2, +2', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const request = page.request;
    const photoId = await firstPhoto(request, await defaultPlace(request));
    const before = (await vote(request, photoId, 0)).body.score;

    const up = await vote(request, photoId, 1);
    expect(up.status).toBe(200);
    expect(up.body.currentVisitorVote).toBe(1);
    expect(up.body.score).toBe(before + 1);
    expect(up.body.rankingMayHaveChanged).toBe(true);

    // Clicking the same arrow again withdraws rather than adding.
    const withdrawn = await vote(request, photoId, 0);
    expect(withdrawn.body.currentVisitorVote).toBe(0);
    expect(withdrawn.body.score).toBe(before);

    const down = await vote(request, photoId, -1);
    expect(down.body.currentVisitorVote).toBe(-1);
    expect(down.body.score).toBe(before - 1);

    const back = await vote(request, photoId, 1);
    expect(back.body.currentVisitorVote).toBe(1);
    expect(back.body.score).toBe(before + 1);
  } finally {
    await context.close();
  }
});

test('repeating the same request is idempotent', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const request = (await context.newPage()).request;
    const { photoIds } = await setupIsolatedPlace(request);
    const photoId = photoIds[0] as string;
    const before = (await vote(request, photoId, 0)).body.score;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await vote(request, photoId, 1);
      expect(result.status).toBe(200);
      expect(result.body.score).toBe(before + 1);
    }
  } finally {
    await context.close();
  }
});

test('two visitors vote independently and the aggregate reflects both', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();

  try {
    const alice = (await aliceContext.newPage()).request;
    const bob = (await bobContext.newPage()).request;
    const { photoIds, listUrl } = await setupIsolatedPlace(alice);
    const photoId = photoIds[0] as string;
    const before = (await vote(alice, photoId, 0)).body.score;

    const a = await vote(alice, photoId, 1);
    expect(a.body.currentVisitorVote).toBe(1);
    expect(a.body.score).toBe(before + 1);

    const b = await vote(bob, photoId, -1);
    expect(b.body.currentVisitorVote).toBe(-1);
    // Bob's down vote cancels Alice's up vote.
    expect(b.body.score).toBe(before);

    // Alice still sees her own state as unchanged, and the listing now shows the
    // settled total: one up and one down cancel out.
    const reread = await vote(alice, photoId, 1);
    expect(reread.body.currentVisitorVote).toBe(1);
    expect(reread.body.score).toBe(before);

    const item = (
      (await (await alice.get(listUrl)).json()) as {
        items: Array<{ id: string; score: number; currentVisitorVote: number }>;
      }
    ).items.find((row) => row.id === photoId);
    expect(item?.score).toBe(before);
    expect(item?.currentVisitorVote).toBe(1);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test('the listing reflects a vote from a different browser', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();

  try {
    const alice = (await aliceContext.newPage()).request;
    const bob = (await bobContext.newPage()).request;
    const { photoIds, listUrl } = await setupIsolatedPlace(alice);
    const photoId = photoIds[0] as string;

    await vote(alice, photoId, 1);

    const bobList = await bob.get(listUrl);
    const bobItems = (await bobList.json()) as {
      items: Array<{ id: string; currentVisitorVote: number }>;
    };
    // Bob has not voted, so he must not inherit Alice's state.
    expect(bobItems.items.find((item) => item.id === photoId)?.currentVisitorVote).toBe(0);

    const aliceList = await alice.get(listUrl);
    const aliceItems = (await aliceList.json()) as {
      items: Array<{ id: string; currentVisitorVote: number }>;
    };
    expect(aliceItems.items.find((item) => item.id === photoId)?.currentVisitorVote).toBe(1);
  } finally {
    await aliceContext.close();
    await bobContext.close();
  }
});

test('rapid repeated clicks never accumulate a score', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const request = (await context.newPage()).request;
    const { photoIds } = await setupIsolatedPlace(request);
    const photoId = photoIds[0] as string;
    const baseline = (await vote(request, photoId, 0)).body;

    // Twenty simultaneous clicks of the same arrow.
    const results = await Promise.all(Array.from({ length: 20 }, () => vote(request, photoId, 1)));

    for (const result of results) {
      expect(result.status).toBe(200);
    }
    // Every response agrees: the score moved by exactly one, no matter how many
    // requests landed. The photo already carries seeded votes from the fixture
    // data, so the comparison is against that baseline rather than zero.
    expect(results.every((result) => result.body.score === baseline.score + 1)).toBe(true);

    // A final read confirms the persisted state: exactly one new supporter.
    const final = await vote(request, photoId, 1);
    expect(final.body.score).toBe(baseline.score + 1);
    expect(final.body.upCount).toBe(baseline.upCount + 1);
  } finally {
    await context.close();
  }
});

test('malformed vote payloads are refused and change nothing', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const request = (await context.newPage()).request;
    const { photoIds } = await setupIsolatedPlace(request);
    const photoId = photoIds[0] as string;
    const before = (await vote(request, photoId, 0)).body.score;

    for (const payload of [
      { value: 5 },
      { value: '1' },
      { value: true },
      { value: null },
      {},
      { value: 1, visitorId: 'someone-else' },
    ]) {
      const response = await request.put(`${ORIGIN}/api/photos/${photoId}/vote`, { data: payload });
      expect(response.status(), JSON.stringify(payload)).toBe(400);
    }

    // Nothing changed.
    const after = await vote(request, photoId, 0);
    expect(after.body.score).toBe(before);
    expect(after.body.currentVisitorVote).toBe(0);
  } finally {
    await context.close();
  }
});

test('a cross-origin vote is refused', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const request = (await context.newPage()).request;
    const { photoIds } = await setupIsolatedPlace(request);
    const photoId = photoIds[0] as string;
    const before = (await vote(request, photoId, 0)).body.score;

    const response = await request.put(`${ORIGIN}/api/photos/${photoId}/vote`, {
      headers: { Origin: 'https://evil.example.com' },
      data: { value: 1 },
    });

    expect(response.status()).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_ORIGIN',
    );
    expect((await vote(request, photoId, 0)).body.score).toBe(before);
  } finally {
    await context.close();
  }
});

test('voting on an unknown photo is a clean 404', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const request = (await context.newPage()).request;
    const response = await request.put(`${ORIGIN}/api/photos/no-such-photo/vote`, {
      data: { value: 1 },
    });
    expect(response.status()).toBe(404);
  } finally {
    await context.close();
  }
});

test('the leaderboard reorders after a decisive vote', async ({ browser }) => {
  const ownerContext = await browser.newContext();

  try {
    const owner = (await ownerContext.newPage()).request;

    // A place owned by this test alone. Using the shared seeded leaderboard
    // would race every other Playwright worker that votes on it concurrently.
    const unique = `重排测试岛 ${Date.now()}`;
    const created = await owner.post(`${ORIGIN}/api/places`, {
      data: { name: unique, region: '测试地区' },
    });
    expect(created.status()).toBe(201);
    const place = (await created.json()) as { place: { id: string } };

    const upload = async (file: string) =>
      owner.post(`${ORIGIN}/api/places/${place.place.id}/photos`, {
        multipart: {
          file: {
            name: file,
            mimeType: 'image/jpeg',
            buffer: await fs.readFile(path.join(FIXTURES, file)),
          },
          title: file,
          idempotencyKey: `reorder-${file}-${Date.now()}`,
        },
      });

    // The first upload becomes the incumbent leader, the second the challenger.
    const first = await upload('landscape.jpg');
    expect(first.status()).toBe(201);
    const second = await upload('portrait.jpg');
    expect(second.status()).toBe(201);

    const listUrl = `${ORIGIN}/api/places/${place.place.id}/photos`;
    const initial = (await (await owner.get(listUrl)).json()) as {
      items: Array<{ id: string; title: string; score: number; rank: number }>;
    };
    expect(initial.items).toHaveLength(2);

    const leader = initial.items[0] as { id: string; title: string; score: number };
    const challenger = initial.items[1] as { id: string; title: string; score: number };
    expect(leader.title).toBe('landscape.jpg');

    // Enough separate visitors to overtake the leader.
    const needed = leader.score - challenger.score + 1;
    expect(needed).toBeGreaterThan(0);

    for (let index = 0; index < needed; index += 1) {
      const voterContext = await browser.newContext();
      const voter = (await voterContext.newPage()).request;
      const result = await vote(voter, challenger.id, 1);
      expect(result.status).toBe(200);
      await voterContext.close();
    }

    const after = (await (await owner.get(listUrl)).json()) as {
      items: Array<{ id: string; rank: number; score: number }>;
    };

    expect(after.items[0]?.id).toBe(challenger.id);
    expect(after.items[0]?.rank).toBe(1);
    expect(after.items[1]?.rank).toBe(2);

    // Ranks stay contiguous and unique after the reorder.
    expect(after.items.map((item) => item.rank)).toEqual([1, 2]);
    expect(after.items[1]?.score).toBeLessThan(after.items[0]?.score ?? 0);
  } finally {
    await ownerContext.close();
  }
});
