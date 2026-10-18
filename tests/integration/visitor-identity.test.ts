import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as VisitorRoute from '@/app/api/visitor/route';
import type * as PlacesRoute from '@/app/api/places/route';
import type * as PlaceRoute from '@/app/api/places/[placeId]/route';
import {
  createTestContext,
  migrateTestDatabase,
  visitorCookieHeader,
  type TestContext,
} from '../factories';

/**
 * Anonymous identity and place APIs, exercised through the real route handlers
 * against a real SQLite database (E2E_SCENARIOS ID-01..05, PLACE-01..05).
 *
 * No mocks: the handlers below are the actual modules Next will invoke. They are
 * imported dynamically in beforeAll so that the test environment variables are
 * already in place when the modules first touch configuration.
 */

let context: TestContext;
let visitorRoute: typeof VisitorRoute;
let placesRoute: typeof PlacesRoute;
let placeRoute: typeof PlaceRoute;

const BASE = 'http://127.0.0.1:3099';
const COOKIE = 'isle_visitor';

beforeAll(async () => {
  context = createTestContext('isle-visitor');
  context.applyEnv();
  await migrateTestDatabase(context.client);

  const { resetConfigCache } = await import('@/lib/config');
  const { resetPrismaForTests } = await import('@/server/db/client');
  resetConfigCache();
  await resetPrismaForTests();

  visitorRoute = await import('@/app/api/visitor/route');
  placesRoute = await import('@/app/api/places/route');
  placeRoute = await import('@/app/api/places/[placeId]/route');

  const { seedDefaultPlace } = await import('@/server/services/place');
  await seedDefaultPlace();
});

afterAll(async () => {
  const { resetPrismaForTests } = await import('@/server/db/client');
  await resetPrismaForTests();
  await context.cleanup();
});

beforeEach(async () => {
  const { resetMemoryRateLimits } = await import('@/server/http/request');
  resetMemoryRateLimits();
  const prisma = await (await import('@/server/db/client')).getPrisma();
  await prisma.rateBucket.deleteMany();
});

function visitorRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`${BASE}${path}`, init);
}

function extractSetCookie(response: Response): string | null {
  const header = response.headers.get('set-cookie');
  return header;
}

function readCookieToken(setCookie: string): string {
  const first = setCookie.split(';')[0] ?? '';
  return decodeURIComponent(first.slice(first.indexOf('=') + 1));
}

describe('visitor identity (ID-01..ID-05)', () => {
  it('issues a cookie on first contact and never leaks the token in the body', async () => {
    const response = await visitorRoute.GET(visitorRequest('/api/visitor'));
    expect(response.status).toBe(200);

    const setCookie = extractSetCookie(response);
    expect(setCookie).not.toBeNull();
    expect(setCookie).toContain(`${COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=31536000');
    // No Secure flag on an http origin, because __Host- requires it (ADR-003).
    expect(setCookie).not.toContain('Secure');

    const raw = await response.text();
    const token = readCookieToken(setCookie as string);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain('tokenHash');

    const body = JSON.parse(raw) as { visitor: { displayCode: string; displayLabel: string } };
    expect(body.visitor.displayCode).toMatch(/^[0-9a-f]{6}$/);
    expect(body.visitor.displayLabel).toBe(`访客 #${body.visitor.displayCode}`);
  });

  it('returns the same identity when the cookie is replayed', async () => {
    const first = await visitorRoute.GET(visitorRequest('/api/visitor'));
    const setCookie = extractSetCookie(first) as string;
    const token = readCookieToken(setCookie);

    const second = await visitorRoute.GET(
      visitorRequest('/api/visitor', { headers: { cookie: visitorCookieHeader(COOKIE, token) } }),
    );

    const firstBody = (await first.clone().json()) as { visitor: { displayCode: string } };
    const secondBody = (await second.json()) as { visitor: { displayCode: string } };

    expect(secondBody.visitor.displayCode).toBe(firstBody.visitor.displayCode);
    // Reuse must not mint a new cookie.
    expect(extractSetCookie(second)).toBeNull();
  });

  it('gives a different browser context a different identity', async () => {
    const alice = await visitorRoute.GET(visitorRequest('/api/visitor'));
    const bob = await visitorRoute.GET(visitorRequest('/api/visitor'));

    const a = (await alice.json()) as { visitor: { displayCode: string } };
    const b = (await bob.json()) as { visitor: { displayCode: string } };

    expect(a.visitor.displayCode).not.toBe(b.visitor.displayCode);
  });

  it('treats a tampered cookie as absent rather than as someone else', async () => {
    const original = await visitorRoute.GET(visitorRequest('/api/visitor'));
    const originalCode = ((await original.clone().json()) as { visitor: { displayCode: string } })
      .visitor.displayCode;

    const tampered = `${readCookieToken(extractSetCookie(original) as string).slice(0, -2)}XY`;
    const response = await visitorRoute.GET(
      visitorRequest('/api/visitor', {
        headers: { cookie: visitorCookieHeader(COOKIE, tampered) },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { visitor: { displayCode: string } };
    expect(body.visitor.displayCode).not.toBe(originalCode);
    // A new identity must be issued, otherwise the caller would be stuck.
    expect(extractSetCookie(response)).not.toBeNull();
  });

  it('never stores the plaintext token', async () => {
    const response = await visitorRoute.GET(visitorRequest('/api/visitor'));
    const token = readCookieToken(extractSetCookie(response) as string);
    const prisma = await (await import('@/server/db/client')).getPrisma();

    const rows = await prisma.visitor.findMany({ select: { tokenHash: true } });
    expect(rows.every((row) => row.tokenHash !== token)).toBe(true);
    expect(rows.every((row) => row.tokenHash.length === 64)).toBe(true);
  });

  it('rejects a malformed cookie without throwing', async () => {
    for (const bad of ['short', 'a'.repeat(500), 'has spaces and ! symbols', '../../etc/passwd']) {
      const response = await visitorRoute.GET(
        visitorRequest('/api/visitor', { headers: { cookie: visitorCookieHeader(COOKIE, bad) } }),
      );
      expect(response.status).toBe(200);
    }
  });
});

describe('place listing and creation (PLACE-01..05)', () => {
  it('lists the seeded default place', async () => {
    const response = await placesRoute.GET(visitorRequest('/api/places'));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { places: Array<{ slug: string; name: string }> };
    expect(body.places.map((place) => place.slug)).toContain('guishan-island');
  });

  it('creates a place and is immediately visible to a different visitor', async () => {
    const alice = await visitorRoute.GET(visitorRequest('/api/visitor'));
    const aliceCookie = visitorCookieHeader(
      COOKIE,
      readCookieToken(extractSetCookie(alice) as string),
    );

    const created = await placesRoute.POST(
      visitorRequest('/api/places', {
        method: 'POST',
        headers: { cookie: aliceCookie, origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ name: '海陵岛', region: '广东 · 阳江', description: '安静的渔村' }),
      }),
    );

    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { place: { slug: string; name: string } };
    expect(createdBody.place.name).toBe('海陵岛');

    // A completely separate identity sees it too.
    const bob = await placesRoute.GET(visitorRequest('/api/places'));
    const bobBody = (await bob.json()) as { places: Array<{ name: string }> };
    expect(bobBody.places.map((place) => place.name)).toContain('海陵岛');
  });

  it('returns 409 for a duplicate name, normalising whitespace first', async () => {
    const first = await placesRoute.POST(
      visitorRequest('/api/places', {
        method: 'POST',
        headers: { origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Dupe Island', region: 'Region A' }),
      }),
    );
    expect(first.status).toBe(201);

    const second = await placesRoute.POST(
      visitorRequest('/api/places', {
        method: 'POST',
        headers: { origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ name: '  Dupe   Island  ', region: 'Region B' }),
      }),
    );

    expect(second.status).toBe(409);
    const body = (await second.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('DUPLICATE_PLACE');
  });

  it('lets only one of two simultaneous creations win', async () => {
    const payload = JSON.stringify({ name: 'Race Island', region: 'Region' });
    const options = {
      method: 'POST',
      headers: { origin: BASE, 'content-type': 'application/json' },
    };

    const results = await Promise.all([
      placesRoute.POST(visitorRequest('/api/places', { ...options, body: payload })),
      placesRoute.POST(visitorRequest('/api/places', { ...options, body: payload })),
    ]);

    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409]);

    const prisma = await (await import('@/server/db/client')).getPrisma();
    const count = await prisma.place.count({ where: { normalizedName: 'Race Island' } });
    expect(count).toBe(1);
  });

  it('rejects invalid input with 400 and a Chinese message', async () => {
    const cases: Array<{ body: unknown; match: RegExp }> = [
      { body: { name: '', region: 'Region' }, match: /地点名称/ },
      { body: { name: 'A'.repeat(61), region: 'Region' }, match: /60/ },
      { body: { name: 'Valid', region: 'x' }, match: /地区/ },
      { body: { name: 'Valid', region: 'R'.repeat(81) }, match: /80/ },
      { body: { name: 'Valid', region: 'Region', description: 'x'.repeat(301) }, match: /300/ },
    ];

    for (const testCase of cases) {
      const response = await placesRoute.POST(
        visitorRequest('/api/places', {
          method: 'POST',
          headers: { origin: BASE, 'content-type': 'application/json' },
          body: JSON.stringify(testCase.body),
        }),
      );
      expect(response.status, JSON.stringify(testCase.body)).toBe(400);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('BAD_REQUEST');
      expect(body.error.message).toMatch(testCase.match);
    }
  });

  it('rejects a cross-origin write with 403 and changes nothing', async () => {
    const before = await (await import('@/server/db/client'))
      .getPrisma()
      .then((db) => db.place.count());

    const response = await placesRoute.POST(
      visitorRequest('/api/places', {
        method: 'POST',
        headers: { origin: 'https://evil.example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Cross Origin Island', region: 'Region' }),
      }),
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_ORIGIN');

    const after = await (await import('@/server/db/client'))
      .getPrisma()
      .then((db) => db.place.count());
    expect(after).toBe(before);
  });

  it('stores user text verbatim and never executes it', async () => {
    const xss = '<script>alert(1)</script>';
    const response = await placesRoute.POST(
      visitorRequest('/api/places', {
        method: 'POST',
        headers: { origin: BASE, 'content-type': 'application/json' },
        body: JSON.stringify({ name: xss, region: 'Region' }),
      }),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { place: { name: string; slug: string } };

    // Stored verbatim: React escapes on render, so the database keeps exactly
    // what the user typed rather than a mangled copy.
    expect(body.place.name).toBe(xss);

    // The slug is derived through the ASCII allow-list, so markup characters,
    // separators and percent-encoding cannot reach a URL.
    expect(body.place.slug).toMatch(/^[a-z0-9-]+$/);
    expect(body.place.slug).not.toMatch(/[<>&/\\%?#]/);
  });

  it('caps place creation at 3 per visitor per day', async () => {
    const visitor = await visitorRoute.GET(visitorRequest('/api/visitor'));
    const cookie = visitorCookieHeader(
      COOKIE,
      readCookieToken(extractSetCookie(visitor) as string),
    );

    const statuses: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await placesRoute.POST(
        visitorRequest('/api/places', {
          method: 'POST',
          headers: { cookie, origin: BASE, 'content-type': 'application/json' },
          body: JSON.stringify({ name: `Quota Island ${index}`, region: 'Region' }),
        }),
      );
      statuses.push(response.status);
      if (response.status === 429) {
        const body = (await response.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('RATE_LIMITED');
        expect(response.headers.get('Retry-After')).toMatch(/^\d+$/);
      }
    }

    expect(statuses.filter((status) => status === 201)).toHaveLength(3);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);
  });

  it('returns 404 for an unknown place id or slug without leaking internals', async () => {
    for (const unknown of ['no-such-slug', 'x'.repeat(200)]) {
      const response = await placeRoute.GET(visitorRequest(`/api/places/${unknown}`), {
        params: Promise.resolve({ placeId: unknown }),
      });
      expect(response.status).toBe(404);
      const raw = await response.text();
      expect(raw).not.toContain('/var/lib/isle');
      expect(raw).not.toContain('SELECT');
    }
  });

  it('resolves a place by both slug and internal id', async () => {
    const list = await placesRoute.GET(visitorRequest('/api/places'));
    const { places } = (await list.json()) as { places: Array<{ id: string; slug: string }> };
    const target = places[0] as { id: string; slug: string };

    const bySlug = await placeRoute.GET(visitorRequest(`/api/places/${target.slug}`), {
      params: Promise.resolve({ placeId: target.slug }),
    });
    const byId = await placeRoute.GET(visitorRequest(`/api/places/${target.id}`), {
      params: Promise.resolve({ placeId: target.id }),
    });

    expect(bySlug.status).toBe(200);
    expect(byId.status).toBe(200);

    const a = (await bySlug.json()) as { place: { id: string } };
    const b = (await byId.json()) as { place: { id: string } };
    expect(a.place.id).toBe(b.place.id);
  });
});
