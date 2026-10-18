import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Leaderboard and media delivery (E2E_SCENARIOS HP-01, LB-02, LB-03, LB-12,
 * G-03 and DATA_API_STORAGE §3).
 *
 * The seeded place carries seven photos with a known tally, so ordering is
 * checked against real data rather than fixtures invented in the test.
 */

const ORIGIN = 'http://127.0.0.1:3017';
const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

type ListItem = {
  id: string;
  title: string;
  rank: number;
  score: number;
  upCount: number;
  downCount: number;
  currentVisitorVote: number;
  width: number;
  height: number;
  mime: string;
  uploader: { displayCode: string };
  preview400Url: string;
  preview1200Url: string;
  originalUrl: string;
  downloadUrl: string;
  createdAt: string;
};

type ListBody = {
  placeId: string;
  items: ListItem[];
  nextCursor: string | null;
  rankingMayHaveChanged: boolean;
  total: number;
};

async function placeId(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${ORIGIN}/api/places`);
  const body = (await response.json()) as { places: Array<{ id: string; slug: string }> };
  const guishan = body.places.find((place) => place.slug === 'guishan-island');
  if (guishan === undefined) throw new Error('default place missing');
  return guishan.id;
}

async function listPhotos(
  request: APIRequestContext,
  place: string,
  query = '',
): Promise<ListBody> {
  const response = await request.get(`${ORIGIN}/api/places/${place}/photos${query}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as ListBody;
}

test('the leaderboard is ordered by score, then upCount, then upload time, then id', async ({
  request,
}) => {
  const place = await placeId(request);
  const { items, total } = await listPhotos(request, place);

  expect(total).toBe(items.length);
  expect(items.length).toBeGreaterThan(1);

  for (let index = 1; index < items.length; index += 1) {
    const previous = items[index - 1] as ListItem;
    const current = items[index] as ListItem;

    if (previous.score !== current.score) {
      expect(previous.score).toBeGreaterThan(current.score);
      continue;
    }
    if (previous.upCount !== current.upCount) {
      expect(previous.upCount).toBeGreaterThan(current.upCount);
      continue;
    }
    if (previous.createdAt !== current.createdAt) {
      expect(Date.parse(previous.createdAt)).toBeLessThanOrEqual(Date.parse(current.createdAt));
      continue;
    }
    expect(previous.id.localeCompare(current.id)).toBeLessThan(0);
  }

  // Ranks are 1-based, contiguous and match list position.
  expect(items.map((item) => item.rank)).toEqual(items.map((_, index) => index + 1));
});

test('score always equals upCount minus downCount', async ({ request }) => {
  const place = await placeId(request);
  const { items } = await listPhotos(request, place);

  for (const item of items) {
    expect(item.score, item.title).toBe(item.upCount - item.downCount);
  }
});

test('the list exposes both previews, the original and a download URL per photo', async ({
  request,
}) => {
  const place = await placeId(request);
  const { items } = await listPhotos(request, place);
  const first = items[0] as ListItem;

  expect(first.preview400Url).toBe(`/api/photos/${first.id}/preview/400`);
  expect(first.preview1200Url).toBe(`/api/photos/${first.id}/preview/1200`);
  expect(first.originalUrl).toBe(`/api/photos/${first.id}/original`);
  expect(first.downloadUrl).toBe(`/api/photos/${first.id}/download`);

  // Dimensions come from the stored record, so the gallery can reserve space
  // before the image decodes and avoid layout shift.
  expect(first.width).toBeGreaterThan(0);
  expect(first.height).toBeGreaterThan(0);

  // No server filesystem path is ever exposed.
  const raw = JSON.stringify(items);
  expect(raw).not.toContain('/var/lib/isle');
  expect(raw).not.toContain(originalDirMarker());
});

function originalDirMarker(): string {
  return 'media/original';
}

test('a visitor sees their own vote state as zero before voting', async ({ browser, request }) => {
  const place = await placeId(request);

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/api/visitor`);
    const { items } = (await (
      await page.request.get(`${ORIGIN}/api/places/${place}/photos`)
    ).json()) as ListBody;
    expect(items.every((item) => item.currentVisitorVote === 0)).toBe(true);
  } finally {
    await context.close();
  }
});

test('personalised listings are never cached', async ({ request }) => {
  const place = await placeId(request);
  const response = await request.get(`${ORIGIN}/api/places/${place}/photos`);
  // Another visitor's vote state must not be readable from a shared cache.
  expect(response.headers()['cache-control']).toBe('private, no-store');
});

test('paging with a cursor walks the leaderboard without repeating or skipping', async ({
  request,
}) => {
  const place = await placeId(request);

  const seen: string[] = [];
  const ranks: number[] = [];
  let cursor: string | null = null;
  let guard = 0;

  do {
    const query = cursor === null ? '?limit=2' : `?limit=2&cursor=${encodeURIComponent(cursor)}`;
    const page = await listPhotos(request, place, query);
    seen.push(...page.items.map((item) => item.id));
    ranks.push(...page.items.map((item) => item.rank));
    cursor = page.nextCursor;
    guard += 1;
  } while (cursor !== null && guard < 20);

  // These invariants hold regardless of concurrent writes from other browser
  // projects uploading to the same place. Comparing the whole walk against a
  // separately-timed full listing would be racy by construction: the leaderboard
  // legitimately changes between the two reads.
  expect(new Set(seen).size, 'a photo appeared on two pages').toBe(seen.length);

  // Ranks are contiguous and ascending, so nothing between them was skipped.
  for (let index = 1; index < ranks.length; index += 1) {
    expect(ranks[index]).toBe((ranks[index - 1] as number) + 1);
  }

  // The walk terminates rather than looping forever on a live cursor.
  expect(guard).toBeLessThan(20);
});

test('an unknown photo id is a clean 404 on every media route', async ({ request }) => {
  for (const suffix of ['original', 'download', 'preview/400', 'preview/1200']) {
    const response = await request.get(`${ORIGIN}/api/photos/does-not-exist/${suffix}`);
    expect(response.status(), suffix).toBe(404);
    const raw = await response.text();
    expect(raw).not.toContain('/var/lib/isle');
  }
});

test('an unsupported preview width is refused rather than resized on demand', async ({
  request,
}) => {
  const place = await placeId(request);
  const { items } = await listPhotos(request, place);
  const first = items[0] as ListItem;

  for (const size of ['800', '2048', '0', 'abc']) {
    const response = await request.get(`${ORIGIN}/api/photos/${first.id}/preview/${size}`);
    expect(response.status(), size).toBe(404);
  }
});

test('the original responds to a Range request with exactly the requested bytes', async ({
  request,
}) => {
  const place = await placeId(request);
  const { items } = await listPhotos(request, place);
  const first = items[0] as ListItem;

  const full = await request.get(`${ORIGIN}${first.originalUrl}`);
  expect(full.status()).toBe(200);
  const fullBytes = await full.body();
  expect(full.headers()['accept-ranges']).toBe('bytes');

  const partial = await request.get(`${ORIGIN}${first.originalUrl}`, {
    headers: { Range: 'bytes=0-99' },
  });
  expect(partial.status()).toBe(206);
  expect(partial.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);

  const partialBytes = await partial.body();
  expect(partialBytes.byteLength).toBe(100);
  expect(partialBytes.equals(fullBytes.subarray(0, 100))).toBe(true);

  // A suffix range returns the tail.
  const tail = await request.get(`${ORIGIN}${first.originalUrl}`, {
    headers: { Range: 'bytes=-50' },
  });
  expect(tail.status()).toBe(206);
  expect((await tail.body()).equals(fullBytes.subarray(fullBytes.byteLength - 50))).toBe(true);
});

test('conditional requests are answered with 304', async ({ request }) => {
  const place = await placeId(request);
  const { items } = await listPhotos(request, place);
  const first = items[0] as ListItem;

  const firstResponse = await request.get(`${ORIGIN}${first.originalUrl}`);
  const etag = firstResponse.headers()['etag'];
  expect(etag).toBeTruthy();

  const second = await request.get(`${ORIGIN}${first.originalUrl}`, {
    headers: { 'If-None-Match': etag as string },
  });
  expect(second.status()).toBe(304);
});

test('media responses are served with nosniff and a matching content type', async ({ request }) => {
  const place = await placeId(request);
  const { items } = await listPhotos(request, place);
  const first = items[0] as ListItem;

  const original = await request.get(`${ORIGIN}${first.originalUrl}`);
  expect(original.headers()['x-content-type-options']).toBe('nosniff');
  expect(original.headers()['content-type']).toBe(first.mime);

  const preview = await request.get(`${ORIGIN}${first.preview400Url}`);
  expect(preview.headers()['x-content-type-options']).toBe('nosniff');
  expect(preview.headers()['content-type']).toBe('image/webp');
  expect(preview.headers()['cache-control']).toContain('immutable');
});

test('downloading an original reproduces the fixture bytes exactly', async ({ request }) => {
  const place = await placeId(request);
  const { items } = await listPhotos(request, place);

  // Find the seeded photo whose title came from a known fixture.
  const target = items.find((item) => item.title === '从云端经过桂山岛');
  expect(target, 'seeded landscape photo missing').toBeTruthy();

  const expected = await fs.readFile(path.join(FIXTURES, 'landscape.jpg'));
  const download = await request.get(`${ORIGIN}${target?.downloadUrl ?? ''}`);

  expect(download.status()).toBe(200);
  const bytes = await download.body();
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    createHash('sha256').update(expected).digest('hex'),
  );
  expect(bytes.equals(expected)).toBe(true);
});
