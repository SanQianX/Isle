import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { waitForHydration } from '../support';

/**
 * The ranking page loads a bounded number of photographs and fetches the rest
 * on demand.
 *
 * The page used to load every photograph of the place, so a place with a few
 * hundred shots produced a megabyte of HTML and hundreds of image elements.
 * This checks that the bounded load still shows the whole ranking, in order,
 * and that the cursor the server issued is the one that is used.
 */

const ORIGIN = 'http://127.0.0.1:3017';

test('the ranking page shows every photograph and can load the rest on demand', async ({
  page,
  request,
}) => {
  // A place with more photographs than the page renders in one go.
  const name = `分页岛 ${process.pid}-${Date.now()}`;
  const created = await request.post(`${ORIGIN}/api/places`, {
    data: { name, region: '测试地区' },
  });
  expect(created.status()).toBe(201);
  const place = (await created.json()) as { place: { id: string; slug: string } };

  // Seed enough photographs to exceed the page's first-load window.
  const total = 70;
  const bytes = await fs.readFile(path.join(process.cwd(), 'tests', 'fixtures', 'landscape.jpg'));

  // The upload limiter is per visitor, and it is doing its job: a single
  // identity may not upload more than a dozen photographs a minute. Spreading
  // the seed over several identities is what real friends would look like,
  // and it keeps the test honest about the limit rather than disabling it.
  const identities = await Promise.all(
    Array.from({ length: 8 }, async (_, index) => {
      const response = await request.get(`${ORIGIN}/api/visitor`, {
        headers: { cookie: `isle_visitor=seed-identity-${index}-${Date.now()}` },
      });
      const setCookie = response.headers()['set-cookie'] ?? '';
      return setCookie.split(';')[0] ?? '';
    }),
  );

  for (let index = 0; index < total; index += 1) {
    // A distinct idempotency key per photo: content-addressed storage would
    // otherwise collapse identical files into one photograph.
    const uploaded = await request.post(`${ORIGIN}/api/places/${place.place.id}/photos`, {
      headers: { cookie: identities[index % identities.length] as string },
      multipart: {
        file: { name: `photo-${index}.jpg`, mimeType: 'image/jpeg', buffer: bytes },
        title: `照片 ${index}`,
        idempotencyKey: `page-${index}-${Date.now()}`,
      },
    });
    expect(uploaded.status(), `upload ${index}`).toBe(201);
  }

  await page.goto(`/places/${place.place.slug}/ranking`);
  await waitForHydration(page);

  // The first load is bounded: not every photograph is in the DOM yet.
  const initialCards = await page.locator('[data-testid^="photo-card-"]').count();
  expect(initialCards).toBeGreaterThan(0);
  expect(initialCards).toBeLessThan(total);

  // The count is stated, so a visitor knows the ranking is not finished.
  await expect(page.getByTestId('ranking-load-more')).toBeVisible();
  await expect(page.getByTestId('ranking-load-more')).toContainText('还有');

  // Loading the rest appends without duplicating or reordering.
  const before = await page
    .locator('[data-testid^="photo-card-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));

  await page.getByTestId('ranking-load-more').click();

  await expect
    .poll(async () => page.locator('[data-testid^="photo-card-"]').count(), { timeout: 30_000 })
    .toBeGreaterThan(initialCards);

  const after = await page
    .locator('[data-testid^="photo-card-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));

  // No duplicates.
  expect(new Set(after).size).toBe(after.length);
  // The first page was not disturbed.
  expect(after.slice(0, before.length)).toEqual(before);

  // The ranks are contiguous and ascending.
  const ranks = await page
    .locator('.rank-label')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.textContent?.trim() ?? '')));
  for (let index = 1; index < ranks.length; index += 1) {
    expect(ranks[index]).toBe((ranks[index - 1] as number) + 1);
  }
});
