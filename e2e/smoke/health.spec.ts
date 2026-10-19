import { expect, test } from '@playwright/test';

/**
 * Phase 01 acceptance smoke.
 *
 * Proves the Playwright pipeline drives a real browser against a real
 * production build: the home page renders, the health API answers 200 against
 * the isolated media directory, and the browser console stays clean.
 *
 * No `page.route()` interception — every assertion below is served by the real
 * Next server started by `npm run start:test`.
 */

test('health endpoint reports a writable, isolated storage root', async ({ request }) => {
  const response = await request.get('/api/health');

  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.status).toBe('ok');
  expect(body.checks.config.ok).toBe(true);
  // The database must be reachable and migrated, not merely present on disk.
  expect(body.checks.database.ok).toBe(true);
  expect(body.checks.originalDir.ok).toBe(true);
  expect(body.checks.previewRoot.ok).toBe(true);
  expect(body.checks.tmpDir.ok).toBe(true);
  expect(body.runtime.e2e).toBe(true);
  expect(response.headers()['cache-control']).toBe('no-store');
});

test('health response never discloses absolute paths or the database URL', async ({ request }) => {
  const response = await request.get('/api/health');
  const raw = await response.text();

  expect(raw).not.toContain('/var/lib/isle');
  expect(raw).not.toContain('file:');
  expect(raw).not.toMatch(/[A-Za-z]:\\\\/); // no Windows drive paths either
});

test('home page loads with no fatal console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const response = await page.goto('/');

  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.title()).toContain('ISLE');

  // Hydration/rendering must be clean; a mismatch here means the shell is broken.
  expect(pageErrors, `page errors: ${pageErrors.join(' | ')}`).toHaveLength(0);
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toHaveLength(0);
});

test('unmatched route renders a 404 rather than crashing', async ({ page }) => {
  const response = await page.goto('/this-route-does-not-exist');
  expect(response?.status()).toBe(404);
  await expect(page.locator('body')).toBeVisible();
});

test('the health check reports whether the stylesheet is actually reachable', async ({
  request,
}) => {
  // A release assembled without .next/static still answers every route with 200
  // and renders the site as unstyled HTML: text overlapping, no layout, and
  // nothing in the logs to say so. This check is what turns that into a visible
  // failure instead of something only a human looking at the page would catch.
  const response = await request.get('/api/health');
  const body = await response.json();

  expect(body.checks.staticAssets, 'staticAssets must be reported').toBeTruthy();
  expect(body.checks.staticAssets.ok, 'the stylesheet must be reachable').toBe(true);
  expect(response.status()).toBe(200);
});
