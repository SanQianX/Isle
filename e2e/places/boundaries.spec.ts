import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Boundary inputs.
 *
 * The contract fixes the limits: a place name is 1-60 characters, a region
 * 2-80, a description at most 300. These tests check that the limits are
 * enforced identically on both sides, and that a request that violates them is
 * refused rather than truncated.
 *
 * They also cover the sizes the client relies on: a long place name, a title in
 * another script, and query parameters that are nonsense.
 */

const ORIGIN = 'http://127.0.0.1:3017';

/**
 * A suffix unique to this process.
 *
 * Five browser projects run against one database, so a fixed name would be
 * created five times and the second run would be refused as a duplicate. Names
 * have to be unique per process, not merely per test.
 */
const RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;

/**
 * A string of exactly `length` characters.
 *
 * The run suffix is shorter than the limits being tested, so padding has to
 * reach the exact length -- otherwise the "one past the limit" case is still
 * inside the limit and the test proves nothing.
 */
function exactLength(text: string, length: number): string {
  return text.length >= length ? text.slice(0, length) : text.padEnd(length, '岛');
}

async function createPlace(
  request: APIRequestContext,
  name: string,
  region = '测试地区',
): Promise<string> {
  const response = await request.post(`${ORIGIN}/api/places`, {
    data: { name, region },
  });
  if (response.status() !== 201) {
    throw new Error(`place creation failed with ${response.status()}: ${await response.text()}`);
  }
  const body = (await response.json()) as { place: { id: string; slug: string } };
  return body.place.id;
}

test.describe('place field limits', () => {
  test('accepts a name at the limit and refuses one past it', async ({ request }) => {
    const atLimit = exactLength(`${RUN}岛`, 60);
    const created = await request.post(`${ORIGIN}/api/places`, {
      data: { name: atLimit, region: '测试地区' },
    });
    expect(created.status(), await created.text()).toBe(201);

    const pastLimit = await request.post(`${ORIGIN}/api/places`, {
      data: { name: exactLength(`${RUN}岛`, 61), region: '测试地区' },
    });
    expect(pastLimit.status(), await pastLimit.text()).toBe(400);
    const body = (await pastLimit.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(body.error.message).toContain('60');
  });

  test('accepts a region at the limit and refuses one past it', async ({ request }) => {
    const created = await request.post(`${ORIGIN}/api/places`, {
      data: { name: `地区上限岛 ${RUN}`, region: '地'.repeat(80) },
    });
    expect(created.status(), await created.text()).toBe(201);

    const pastLimit = await request.post(`${ORIGIN}/api/places`, {
      data: { name: `地区超限岛 ${RUN}`, region: '地'.repeat(81) },
    });
    expect(pastLimit.status(), await pastLimit.text()).toBe(400);
  });

  test('refuses a blank or whitespace-only name', async ({ request }) => {
    for (const name of ['', '   ', '\t\n', '　']) {
      // Sent verbatim: a suffix would turn a blank name into a valid one.
      const response = await request.post(`${ORIGIN}/api/places`, {
        data: { name, region: '测试地区' },
      });
      expect(response.status(), JSON.stringify(name)).toBe(400);
    }
  });

  test('refuses a region shorter than two characters', async ({ request }) => {
    for (const region of ['', 'x', ' ']) {
      const response = await request.post(`${ORIGIN}/api/places`, {
        data: { name: `地区太短岛 ${RUN}`, region },
      });
      expect(response.status(), JSON.stringify(region)).toBe(400);
    }
  });

  test('refuses a description past 300 characters', async ({ request }) => {
    const response = await request.post(`${ORIGIN}/api/places`, {
      data: { name: `介绍超长岛 ${RUN}`, region: '测试地区', description: 'x'.repeat(301) },
    });
    expect(response.status(), await response.text()).toBe(400);
  });
});

test.describe('names in other scripts', () => {
  test('accepts a Cyrillic, Japanese and emoji name', async ({ request }) => {
    for (const name of ['Остров', 'かくれが', '🏝️ 无人岛']) {
      const response = await request.post(`${ORIGIN}/api/places`, {
        data: { name: `${name} ${RUN}`, region: '测试地区' },
      });
      expect(response.status(), name).toBe(201);
    }
  });

  test('a long name does not push the page sideways', async ({ page, request }) => {
    // Long enough to wrap, still inside the 60-character limit.
    const name = `很长的地名测试 ${'甲乙丙丁'.repeat(9)} ${RUN}`;
    await createPlace(request, name);

    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/places');
    await page.waitForSelector('html[data-hydrated="true"]');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'a long place name must not widen the page').toBeLessThanOrEqual(0);
  });
});

test.describe('query parameters', () => {
  test('an absurd limit is clamped rather than honoured', async ({ request }) => {
    const placeId = await createPlace(request, `参数岛 ${RUN}`);
    const response = await request.get(`${ORIGIN}/api/places/${placeId}/photos?limit=100000`);
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { items: unknown[] };
    expect(body.items.length).toBeLessThanOrEqual(100);
  });

  test('a nonsensical limit falls back to the default', async ({ request }) => {
    const placeId = await createPlace(request, `参数异常岛 ${RUN}`);
    for (const limit of ['abc', '-5', '0', 'NaN', '1e999']) {
      const response = await request.get(`${ORIGIN}/api/places/${placeId}/photos?limit=${limit}`);
      expect(response.status(), limit).toBe(200);
      const body = (await response.json()) as { items: unknown[] };
      expect(Array.isArray(body.items), limit).toBe(true);
    }
  });

  test('a malformed cursor is ignored rather than erroring', async ({ request }) => {
    const placeId = await createPlace(request, `游标异常岛 ${RUN}`);
    for (const cursor of ['not-base64!!', 'eyJib2d1cyI6', '../../etc/passwd']) {
      const response = await request.get(
        `${ORIGIN}/api/places/${placeId}/photos?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(response.status(), cursor).toBe(200);
    }
  });
});

test.describe('stored text stays text', () => {
  test('markup in a place name is stored verbatim and never interpreted', async ({ request }) => {
    const payload = `<img src=x onerror=alert(1)>${RUN}`;
    const response = await request.post(`${ORIGIN}/api/places`, {
      data: { name: payload, region: '测试地区' },
    });
    expect(response.status(), await response.text()).toBe(201);

    const body = (await response.json()) as { place: { name: string; slug: string } };
    expect(body.place.name).toBe(payload);
    // The slug is derived through an allow-list, so it cannot carry markup.
    expect(body.place.slug).toMatch(/^[a-z0-9-]+$/);
  });

  test('a name that is only punctuation still yields a usable slug', async ({ request }) => {
    const response = await request.post(`${ORIGIN}/api/places`, {
      data: { name: `??? ${RUN}`, region: '测试地区' },
    });
    expect(response.status(), await response.text()).toBe(201);
    const body = (await response.json()) as { place: { slug: string } };
    expect(body.place.slug).toMatch(/^[a-z0-9-]+$/);
  });
});
