import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 02 acceptance in a real browser (E2E_SCENARIOS ID-01..04, PLACE-01).
 *
 * Everything here goes through the running Next server against the isolated
 * SQLite database created by scripts/run-e2e-isolated.mjs. No `page.route()`
 * interception: the responses asserted below are produced by the real handlers.
 */

const PLACE = {
  region: '广东 · 阳江',
  description: '安静的渔村，傍晚的码头很好看。',
};

type VisitorBody = { visitor: { displayCode: string; displayLabel: string } };
type PlaceBody = { place: { id: string; slug: string; name: string } };
type PlacesBody = { places: Array<{ id: string; slug: string; name: string }> };

async function getJson<T>(page: Page, url: string): Promise<T> {
  const response = await page.goto(url);
  if (response === null) throw new Error(`no response for ${url}`);
  return (await response.json()) as T;
}

/**
 * Unique per test process. The suite runs five browser projects against one
 * shared database, so a fixed name would be created five times concurrently and
 * four runs would correctly get 409 -- which is duplicate protection working,
 * not a flake.
 */
let nameCounter = 0;

function uniquePlaceName(): string {
  // Process id, clock, a counter and a random suffix. Any one of these alone
  // can repeat when five browser projects create places against one database.
  nameCounter += 1;
  const random = Math.random().toString(36).slice(2, 8);
  return `海陵岛 ${process.pid}-${Date.now()}-${nameCounter}-${random}`;
}

test('a fresh browser receives a secure-by-default visitor cookie', async ({ page, context }) => {
  const response = await page.goto('/api/visitor');
  expect(response?.status()).toBe(200);

  const body = (await response?.json()) as VisitorBody;
  expect(body.visitor.displayCode).toMatch(/^[0-9a-f]{6}$/);
  expect(body.visitor.displayLabel).toBe(`访客 #${body.visitor.displayCode}`);

  // The exact Set-Cookie header (HttpOnly, SameSite=Lax, Max-Age, and no Secure
  // on an http origin) is asserted in tests/integration/visitor-identity.test.ts,
  // which reads the Response object directly. Playwright's response.headers()
  // does not expose set-cookie consistently across engines, and WebKit's cookie
  // API reports sameSite "None" for a Lax cookie -- asserting those here would
  // test browser quirks instead of our behaviour.
  const cookies = await context.cookies();
  const visitorCookie = cookies.find((cookie) => cookie.name === 'isle_visitor');
  expect(visitorCookie, 'visitor cookie was not stored by the browser').toBeTruthy();

  const token = visitorCookie?.value ?? '';
  expect(visitorCookie?.httpOnly).toBe(true);
  expect(visitorCookie?.path).toBe('/');
  expect(visitorCookie?.domain).toBe('127.0.0.1');
  // 256 bits of entropy, base64url encoded -- not the 6-character display code.
  expect(token.length).toBeGreaterThanOrEqual(43);
  expect(token).not.toBe(body.visitor.displayCode);

  // The raw token must never appear in a response body.
  const raw = JSON.stringify(body);
  expect(raw).not.toContain(token);
  expect(raw).not.toContain('tokenHash');
});

test('the same browser keeps its identity across reloads', async ({ page }) => {
  const first = await getJson<VisitorBody>(page, '/api/visitor');
  await page.reload();
  const second = await getJson<VisitorBody>(page, '/api/visitor');

  expect(second.visitor.displayCode).toBe(first.visitor.displayCode);
});

test('a separate browser context gets a separate identity', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();

  try {
    const a = await getJson<VisitorBody>(await alice.newPage(), '/api/visitor');
    const b = await getJson<VisitorBody>(await bob.newPage(), '/api/visitor');

    expect(a.visitor.displayCode).not.toBe(b.visitor.displayCode);
  } finally {
    await alice.close();
    await bob.close();
  }
});

test('a tampered cookie cannot impersonate the original visitor', async ({ page, context }) => {
  const original = await getJson<VisitorBody>(page, '/api/visitor');
  const originalCode = original.visitor.displayCode;

  const cookies = await context.cookies();
  const current = cookies.find((cookie) => cookie.name === 'isle_visitor');
  const tampered = `${(current?.value ?? '').slice(0, -2)}XY`;

  await context.addCookies([
    {
      name: 'isle_visitor',
      value: tampered,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);

  const response = await page.goto('/api/visitor');
  expect(response?.status()).toBe(200);
  const body = (await response?.json()) as VisitorBody;
  expect(body.visitor.displayCode).not.toBe(originalCode);
});

test('the default place is present and the list endpoint reflects it', async ({ page }) => {
  const body = await getJson<PlacesBody>(page, '/api/places');
  const guishan = body.places.find((place) => place.slug === 'guishan-island');

  expect(guishan).toBeTruthy();
  expect(guishan?.name).toBe('桂山岛');
  expect(guishan?.id).toBeTruthy();
});

test('a place created in one browser is visible in another', async ({ browser }) => {
  const alice = await browser.newContext();
  const bob = await browser.newContext();

  try {
    const name = uniquePlaceName();
    const alicePage = await alice.newPage();
    const created = await alicePage.request.post('/api/places', { data: { ...PLACE, name } });
    expect(created.status()).toBe(201);

    const createdBody = (await created.json()) as PlaceBody;
    expect(createdBody.place.name).toBe(name);

    const bobPage = await bob.newPage();
    const list = (await (await bobPage.request.get('/api/places')).json()) as PlacesBody;
    expect(list.places.map((place) => place.name)).toContain(name);

    // And it is reachable directly by slug.
    const detail = await bobPage.request.get(`/api/places/${createdBody.place.slug}`);
    expect(detail.status()).toBe(200);
    expect(((await detail.json()) as PlaceBody).place.name).toBe(name);
  } finally {
    await alice.close();
    await bob.close();
  }
});

test('creating the same place twice returns 409 with a usable message', async ({ page }) => {
  const unique = uniquePlaceName();

  const first = await page.request.post('/api/places', { data: { ...PLACE, name: unique } });
  expect(first.status()).toBe(201);

  const second = await page.request.post('/api/places', {
    data: { ...PLACE, name: `  ${unique}  ` },
  });
  expect(second.status()).toBe(409);

  const body = (await second.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe('DUPLICATE_PLACE');
  expect(body.error.message).toContain('已经存在');
});

test('an unknown place slug is a clean 404', async ({ page }) => {
  const response = await page.request.get('/api/places/definitely-not-a-real-place');
  expect(response.status()).toBe(404);

  const raw = await response.text();
  expect(raw).not.toContain('/var/lib/isle');
  expect(raw).not.toContain('SELECT');
});

test('a cross-origin write is rejected without creating anything', async ({ page }) => {
  // Name it uniquely and assert that *this* place is absent. Comparing a total
  // count races every other worker, which legitimately creates places too.
  const name = uniquePlaceName();

  const response = await page.request.post('/api/places', {
    headers: { Origin: 'https://evil.example.com' },
    data: { ...PLACE, name },
  });

  expect(response.status()).toBe(403);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
    'INVALID_ORIGIN',
  );

  const after = (await (await page.request.get('/api/places')).json()) as PlacesBody;
  expect(after.places.map((place) => place.name)).not.toContain(name);
});
