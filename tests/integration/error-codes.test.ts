import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type * as VisitorRoute from '@/app/api/visitor/route';
import type * as PlacesRoute from '@/app/api/places/route';
import type * as PhotosRoute from '@/app/api/places/[placeId]/photos/route';
import type * as VoteRoute from '@/app/api/photos/[photoId]/vote/route';
import type * as OriginalRoute from '@/app/api/photos/[photoId]/original/route';
import type * as DownloadRoute from '@/app/api/photos/[photoId]/download/route';
import type * as PreviewRoute from '@/app/api/photos/[photoId]/preview/[size]/route';
import { createTestContext, migrateTestDatabase, type TestContext } from '../factories';

/**
 * Every documented error code, exercised through the real HTTP handlers.
 *
 * DATA_API_STORAGE §3 lists the codes and their statuses. The rule that
 * matters most: **a failure must never be reported as a success.** A handler
 * that swallows an exception and returns 200 leaves the caller believing
 * something happened that did not.
 *
 * The response body is also checked for leaked internals -- a 500 that says
 * "SQLITE_CANTOPEN at /var/lib/isle/db/isle.db" tells an attacker where the
 * database lives.
 */

let context: TestContext;
let visitorRoute: typeof VisitorRoute;
let placesRoute: typeof PlacesRoute;
let photosRoute: typeof PhotosRoute;
let voteRoute: typeof VoteRoute;
let originalRoute: typeof OriginalRoute;
let downloadRoute: typeof DownloadRoute;
let previewRoute: typeof PreviewRoute;

const BASE = 'http://127.0.0.1:3099';
let placeId: string;
let photoId: string;

beforeAll(async () => {
  context = createTestContext('isle-errors');
  context.applyEnv();
  await migrateTestDatabase(context.client);

  const { resetConfigCache } = await import('@/lib/config');
  const { resetPrismaForTests } = await import('@/server/db/client');
  resetConfigCache();
  await resetPrismaForTests();

  visitorRoute = await import('@/app/api/visitor/route');
  placesRoute = await import('@/app/api/places/route');
  photosRoute = await import('@/app/api/places/[placeId]/photos/route');
  voteRoute = await import('@/app/api/photos/[photoId]/vote/route');
  originalRoute = await import('@/app/api/photos/[photoId]/original/route');
  downloadRoute = await import('@/app/api/photos/[photoId]/download/route');
  previewRoute = await import('@/app/api/photos/[photoId]/preview/[size]/route');

  const { seedDefaultPlace } = await import('@/server/services/place');
  const place = await seedDefaultPlace();
  placeId = place.id;

  const { ingestPhotoBytes } = await import('@/server/services/photo');
  const { promises: fs } = await import('node:fs');
  const bytes = new Uint8Array(
    await fs.readFile(new URL('../../tests/fixtures/landscape.jpg', import.meta.url)),
  );
  const visitor = await import('@/server/auth/visitor');
  const resolved = await visitor.resolveVisitor(undefined);
  const photo = await ingestPhotoBytes({
    placeId,
    visitorId: resolved.visitor.id,
    bytes,
    fileName: 'landscape.jpg',
    mime: 'image/jpeg',
    idempotencyKey: 'error-codes-fixture',
  });
  photoId = photo.id;
});

afterAll(async () => {
  const { resetPrismaForTests } = await import('@/server/db/client');
  await resetPrismaForTests();
  await context.cleanup();
});

beforeEach(async () => {
  const { resetMemoryRateLimits } = await import('@/server/http/request');
  resetMemoryRateLimits();
});

/** Every response must be JSON with the documented envelope. */
async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status, `expected ${status}, got ${response.status}`).toBe(status);

  // Read once: the body can only be consumed a single time.
  const raw = await response.text();
  const body = JSON.parse(raw) as { error?: { code?: string; message?: string } };
  expect(body.error, 'the response must carry an error envelope').toBeTruthy();
  expect(body.error?.code).toBe(code);
  expect(typeof body.error?.message).toBe('string');
  expect((body.error?.message ?? '').length).toBeGreaterThan(0);
  expectNoInternals(raw);
}

/** No response body may contain a filesystem path or SQL. */
function expectNoInternals(raw: string): void {
  expect(raw).not.toContain('/var/lib/isle');
  expect(raw).not.toContain('MEDIA_ROOT');
  expect(raw).not.toContain('UPLOAD_TMP_DIR');
  expect(raw).not.toMatch(/[A-Za-z]:\\\\/);
  expect(raw).not.toContain('SELECT ');
  expect(raw).not.toContain('sqlite');
  expect(raw).not.toContain('PrismaClient');
}

describe('400 BAD_REQUEST', () => {
  it('rejects a place creation with a malformed body', async () => {
    const response = await placesRoute.POST(
      new Request(`${BASE}/api/places`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: 'not json',
      }),
    );
    await expectError(response, 400, 'BAD_REQUEST');
  });

  it('rejects a place creation with an empty name', async () => {
    const response = await placesRoute.POST(
      new Request(`${BASE}/api/places`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ name: '', region: '测试地区' }),
      }),
    );
    await expectError(response, 400, 'BAD_REQUEST');
  });

  it('rejects a vote whose value is out of range', async () => {
    const response = await voteRoute.PUT(
      new Request(`${BASE}/api/photos/${photoId}/vote`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ value: 5 }),
      }),
      { params: Promise.resolve({ photoId }) },
    );
    await expectError(response, 400, 'BAD_REQUEST');
  });

  it('rejects a vote carrying a client-supplied identity', async () => {
    const response = await voteRoute.PUT(
      new Request(`${BASE}/api/photos/${photoId}/vote`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ value: 1, visitorId: 'someone-else' }),
      }),
      { params: Promise.resolve({ photoId }) },
    );
    await expectError(response, 400, 'BAD_REQUEST');
  });
});

describe('403 INVALID_ORIGIN', () => {
  it('rejects a cross-origin vote and changes nothing', async () => {
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    const before = await prisma.vote.count();

    const response = await voteRoute.PUT(
      new Request(`${BASE}/api/photos/${photoId}/vote`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
        body: JSON.stringify({ value: 1 }),
      }),
      { params: Promise.resolve({ photoId }) },
    );

    await expectError(response, 403, 'INVALID_ORIGIN');
    expect(await prisma.vote.count()).toBe(before);
  });

  it('rejects a cross-origin place creation and changes nothing', async () => {
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    const before = await prisma.place.count();

    const response = await placesRoute.POST(
      new Request(`${BASE}/api/places`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
        body: JSON.stringify({ name: `跨域岛 ${Date.now()}`, region: '测试地区' }),
      }),
    );

    await expectError(response, 403, 'INVALID_ORIGIN');
    expect(await prisma.place.count()).toBe(before);
  });
});

describe('404 NOT_FOUND', () => {
  it('reports an unknown place', async () => {
    const placeRoute = await import('@/app/api/places/[placeId]/route');
    const response = await placeRoute.GET(new Request(`${BASE}/api/places/no-such-place`), {
      params: Promise.resolve({ placeId: 'no-such-place' }),
    });
    await expectError(response, 404, 'NOT_FOUND');
  });

  it('reports an unknown photo on every media route', async () => {
    const unknown = 'no-such-photo';
    const responses = await Promise.all([
      originalRoute.GET(new Request(`${BASE}/api/photos/${unknown}/original`), {
        params: Promise.resolve({ photoId: unknown }),
      }),
      downloadRoute.GET(new Request(`${BASE}/api/photos/${unknown}/download`), {
        params: Promise.resolve({ photoId: unknown }),
      }),
      previewRoute.GET(new Request(`${BASE}/api/photos/${unknown}/preview/400`), {
        params: Promise.resolve({ photoId: unknown, size: '400' }),
      }),
    ]);

    for (const response of responses) {
      await expectError(response, 404, 'NOT_FOUND');
    }
  });

  it('reports an unsupported preview width', async () => {
    const response = await previewRoute.GET(
      new Request(`${BASE}/api/photos/${photoId}/preview/8000`),
      { params: Promise.resolve({ photoId, size: '8000' }) },
    );
    await expectError(response, 404, 'NOT_FOUND');
  });
});

describe('409 DUPLICATE_PLACE', () => {
  it('reports a duplicate name and points at the existing place', async () => {
    const name = `重复岛 ${Date.now()}`;
    const first = await placesRoute.POST(
      new Request(`${BASE}/api/places`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ name, region: '测试地区' }),
      }),
    );
    expect(first.status).toBe(201);

    const second = await placesRoute.POST(
      new Request(`${BASE}/api/places`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASE },
        body: JSON.stringify({ name: `  ${name}  `, region: '测试地区' }),
      }),
    );

    expect(second.status).toBe(409);
    const body = (await second.json()) as {
      error: { code: string; message: string; details?: { slug?: string } };
    };
    expect(body.error.code).toBe('DUPLICATE_PLACE');
    expect(body.error.message.length).toBeGreaterThan(0);
    expect(body.error.details?.slug).toBeTruthy();
  });
});

describe('413 PHOTO_TOO_LARGE', () => {
  it('refuses a file above the size ceiling without storing it', async () => {
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    const before = await prisma.photo.count();

    const oversized = new Uint8Array(26 * 1024 * 1024);
    const form = new FormData();
    form.append('file', new Blob([oversized], { type: 'image/jpeg' }), 'huge.jpg');
    form.append('idempotencyKey', `too-large-${Date.now()}`);

    const response = await photosRoute.POST(
      new Request(`${BASE}/api/places/${placeId}/photos`, { method: 'POST', body: form }),
      { params: Promise.resolve({ placeId }) },
    );

    await expectError(response, 413, 'PHOTO_TOO_LARGE');
    expect(await prisma.photo.count()).toBe(before);
  });
});

describe('415 UNSUPPORTED_MEDIA_TYPE', () => {
  it('refuses a file that is not an image at all', async () => {
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    const before = await prisma.photo.count();

    const form = new FormData();
    form.append(
      'file',
      new Blob([new TextEncoder().encode('not an image')], { type: 'text/plain' }),
      'a.txt',
    );
    form.append('idempotencyKey', `not-image-${Date.now()}`);

    const response = await photosRoute.POST(
      new Request(`${BASE}/api/places/${placeId}/photos`, { method: 'POST', body: form }),
      { params: Promise.resolve({ placeId }) },
    );

    await expectError(response, 415, 'UNSUPPORTED_MEDIA_TYPE');
    expect(await prisma.photo.count()).toBe(before);
  });
});

describe('422 INVALID_IMAGE', () => {
  it('refuses a file with a valid header but undecodable content', async () => {
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    const before = await prisma.photo.count();

    // A JPEG header followed by nothing usable.
    const corrupt = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const form = new FormData();
    form.append('file', new Blob([corrupt], { type: 'image/jpeg' }), 'corrupt.jpg');
    form.append('idempotencyKey', `corrupt-${Date.now()}`);

    const response = await photosRoute.POST(
      new Request(`${BASE}/api/places/${placeId}/photos`, { method: 'POST', body: form }),
      { params: Promise.resolve({ placeId }) },
    );

    await expectError(response, 422, 'INVALID_IMAGE');
    expect(await prisma.photo.count()).toBe(before);
  });
});

describe('429 RATE_LIMITED', () => {
  it('refuses votes past the per-minute budget and says how long to wait', async () => {
    // The limiter is keyed on the visitor. A token that matches no stored row
    // mints a brand new visitor on every request, so the window never fills.
    // Create a real Visitor whose stored hash matches the cookie we send.
    const { getPrisma } = await import('@/server/db/client');
    const prisma = await getPrisma();
    // The stored hash must be sha256(rawToken) -- that is what resolveVisitor
    // computes. Storing sha256(label) directly would never match, and every
    // request would mint a fresh visitor, so the window would never fill.
    const rawToken = createHash('sha256').update('rate-limit-subject').digest('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await prisma.visitor.create({ data: { tokenHash, displayCode: 'r8e001' } });
    const cookie = `isle_visitor=${rawToken}`;

    // The per-minute budget is 120 with a burst of 30, so one visitor has to
    // exceed 150 requests before the limiter engages.
    let limited: Response | undefined;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const response = await voteRoute.PUT(
        new Request(`${BASE}/api/photos/${photoId}/vote`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', origin: BASE, cookie },
          body: JSON.stringify({ value: attempt % 2 === 0 ? 1 : -1 }),
        }),
        { params: Promise.resolve({ photoId }) },
      );
      if (response.status === 429) {
        limited = response;
        break;
      }
    }

    expect(limited, 'the vote limiter never engaged').toBeDefined();
    await expectError(limited as Response, 429, 'RATE_LIMITED');
    expect(limited?.headers.get('Retry-After')).toMatch(/^\d+$/);
  });
});

describe('no error body leaks internals', () => {
  it('keeps paths and SQL out of every failure response', async () => {
    const responses = await Promise.all([
      placesRoute.GET(new Request(`${BASE}/api/places`)),
      placesRoute.POST(
        new Request(`${BASE}/api/places`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASE },
          body: '{',
        }),
      ),
      voteRoute.PUT(
        new Request(`${BASE}/api/photos/${photoId}/vote`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json', origin: BASE },
          body: JSON.stringify({ value: 99 }),
        }),
        { params: Promise.resolve({ photoId }) },
      ),
    ]);

    for (const response of responses) {
      expectNoInternals(await response.text());
    }
  });
});

describe('the visitor route always answers', () => {
  it('issues an identity even with a tampered cookie', async () => {
    const response = await visitorRoute.GET(
      new Request(`${BASE}/api/visitor`, {
        headers: { cookie: 'isle_visitor=completely-made-up-token-value' },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { visitor: { displayCode: string } };
    expect(body.visitor.displayCode).toMatch(/^[0-9a-f]{6}$/);
    expectNoInternals(JSON.stringify(body));
  });
});
