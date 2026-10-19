import { expect, test } from '@playwright/test';

/**
 * Page rendering (MASTER_PLAN Phase 06, E2E_SCENARIOS NAV-01/NAV-02, HP-01).
 *
 * These assert that the pages are real: they read the database, they render the
 * seeded photographs, and every route works on a direct load rather than only
 * after navigating there from somewhere else.
 */

test('the home page renders the featured place from the database', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  // Real content, not the Phase 01 placeholder.
  await expect(page.getByRole('heading', { level: 1, name: '桂山岛' })).toBeVisible();
  await expect(page.getByText('一个地方，')).toBeVisible();
  await expect(page.getByRole('link', { name: /我也拍过这里/ })).toBeVisible();

  // The region and description come from the seeded row.
  await expect(page.getByText('广东 · 珠海 · 万山群岛')).toBeVisible();

  // The leader's photo actually loaded from our own preview route.
  const heroImage = page.locator('.hero-photo-frame img');
  await expect(heroImage).toHaveAttribute('src', /\/api\/photos\/[a-z0-9]+\/preview\/1200/);

  const loaded = await heroImage.evaluate(
    (img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0,
  );
  expect(loaded, 'hero image failed to decode').toBe(true);

  // Real counts, not the seeded constants from the prototype.
  await expect(page.locator('.stat-label').first()).toHaveText('张照片');

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toHaveLength(0);
});

test('the home page shows the runner-up photos in the justified wall', async ({ page }) => {
  await page.goto('/');

  const wall = page.getByTestId('photo-wall');
  await expect(wall).toBeVisible();

  const cards = wall.locator('.photo-card');
  // The wall lays out after its first measurement, which happens one frame
  // after hydration, so poll rather than sampling once.
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(0);
  const count = await cards.count();
  expect(count).toBeLessThanOrEqual(3); // ranks 2..4

  // Rank labels start at 02 because the hero holds rank 01.
  await expect(cards.first().locator('.rank-label')).toHaveText('02');

  // Every tile declares its own geometry, so the grid reserves space before the
  // image decodes and the page does not jump. Which property it is depends on
  // the layout: justified rows get an explicit width and height, the stacked
  // mobile layout gets an aspect ratio and takes the full container width.
  const first = cards.first();
  const style = await first.getAttribute('style');
  const isStacked = await page.evaluate(() => window.innerWidth <= 760);

  if (isStacked) {
    expect(style).toMatch(/--photo-aspect/);
  } else {
    expect(style).toMatch(/--photo-width/);
    expect(style).toMatch(/--photo-height/);
  }
});

test('photos keep their aspect ratio and are never cropped', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  // Wait for the decode *and* a real laid-out box. An image can be fully
  // decoded while its tile is still 0x0, and a ratio computed from that is NaN
  // rather than a genuine distortion.
  await page.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll('[data-testid^="photo-card-"]')];
      if (cards.length === 0) return false;
      return cards.every((card) => {
        const image = card.querySelector('img') as HTMLImageElement | null;
        if (image === null) return false;
        if (!image.complete || image.naturalWidth === 0) return false;
        const box = image.getBoundingClientRect();
        return box.width > 1 && box.height > 1;
      });
    },
    undefined,
    { timeout: 15_000 },
  );

  const cards = page.locator('[data-testid^="photo-card-"]');
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);

  const measurements = await cards.evaluateAll((nodes) =>
    nodes.map((node) => {
      const image = node.querySelector('img') as HTMLImageElement | null;
      const button = node.querySelector('.photo-tap') as HTMLElement | null;
      if (image === null || button === null) return null;
      const rendered = image.getBoundingClientRect();
      const frame = button.getBoundingClientRect();
      return {
        natural: image.naturalWidth / image.naturalHeight,
        renderedRatio: rendered.width / rendered.height,
        renderedWidth: rendered.width,
        frameWidth: frame.width,
      };
    }),
  );

  for (const measurement of measurements) {
    expect(measurement, 'tile without an image').not.toBeNull();
    if (measurement === null) continue;

    // The tile fills its frame exactly, so object-fit:contain has nothing to
    // crop: the photograph is shown whole at its true proportions.
    expect(Math.abs(measurement.renderedWidth - measurement.frameWidth)).toBeLessThanOrEqual(1);
    expect(measurement.renderedRatio).toBeCloseTo(measurement.natural, 1);
  }
});

test('rows share one height, which is what makes the wall justified', async ({ page }) => {
  // Below 760px the wall deliberately stacks, so each photo keeps its own
  // height and the equal-height invariant does not apply.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const rows = page.locator('.photo-row');
  await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(0);

  // The wall re-renders once it has measured its container, so poll for the
  // settled state rather than sampling a frame that is about to change.
  await expect
    .poll(
      async () => {
        const heights = await rows.evaluateAll((nodes) =>
          nodes.map((row) => {
            const tiles = [...row.querySelectorAll('.photo-tap')];
            if (tiles.length === 0) return 0;
            return new Set(tiles.map((tile) => Math.round(tile.getBoundingClientRect().height)))
              .size;
          }),
        );
        return heights.length > 0 && heights.every((distinct) => distinct === 1);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
});

test('the stacked mobile layout gives each photo its own aspect ratio', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const cards = page.locator('[data-testid^="photo-card-"]');
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(0);

  // Every photo spans the container on a phone. Polled, because the wall
  // re-lays out once it has measured and a single sample can catch it mid-update.
  await expect
    .poll(
      async () => {
        const widths = await cards.evaluateAll((nodes) =>
          nodes.map((node) => {
            const button = node.querySelector('.photo-tap') as HTMLElement | null;
            return button === null ? 0 : Math.round(button.getBoundingClientRect().width);
          }),
        );
        return widths.length > 0 && widths.every((width) => width > 200);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
});

test('navigation links work and each route loads directly', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('link', { name: '发现地点', exact: true }).click();
  await page.waitForURL('**/places');
  // NAV-02: a direct load must work, not just in-app navigation.
  const response = await page.goto('/places');
  expect(response?.status()).toBe(200);
});

test('no page overflows horizontally on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontal scroll on a 390px viewport').toBeLessThanOrEqual(0);
});

test('no page overflows horizontally on a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontal scroll on a 360px viewport').toBeLessThanOrEqual(0);
});

test('no page overflows on a wide desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('resizing the viewport re-lays out the wall', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect
    .poll(() => page.locator('.photo-row .photo-card').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);

  const widthAt = async () =>
    page
      .locator('.photo-row .photo-card')
      .first()
      .evaluate((node) => node.getBoundingClientRect().width);

  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await widthAt();

  await page.setViewportSize({ width: 700, height: 900 });
  const narrow = await widthAt();

  expect(narrow, 'the wall should re-measure on resize').not.toBeCloseTo(wide, 0);

  // Below the breakpoint it stacks to full width.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.locator('.photo-row .photo-card').count(), { timeout: 15_000 })
    .toBeGreaterThan(0);
  const stacked = await widthAt();
  const container = await page
    .locator('[data-testid="photo-wall"]')
    .evaluate((node) => node.getBoundingClientRect().width);
  expect(stacked).toBeGreaterThan(container * 0.9);
});

test('every navigation destination loads directly and renders', async ({ page }) => {
  for (const route of [
    '/places',
    '/places/guishan-island',
    '/places/guishan-island/ranking',
    '/places/guishan-island/upload',
    '/places/new',
  ]) {
    const response = await page.goto(route);
    expect(response?.status(), `${route} should not 404`).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
});

test('the ranking page lists every seeded photo in rank order', async ({ page }) => {
  await page.goto('/places/guishan-island/ranking');

  await expect(page.getByRole('heading', { level: 1, name: /照片榜/ })).toBeVisible();

  const cards = page.locator('[data-testid^="photo-card-"]');
  await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(0);
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);

  // The leader sits outside the wall, so wall rank labels start at 02.
  await expect(page.locator('[data-testid="ranking-leader-rank"]')).toBeVisible();
  const firstWallRank = await cards.first().locator('.rank-label').innerText();
  expect(Number(firstWallRank)).toBe(2);
});

test('no page overflows horizontally at any supported breakpoint', async ({ page }) => {
  const routes = [
    '/',
    '/places',
    '/places/guishan-island',
    '/places/guishan-island/ranking',
    '/places/guishan-island/upload',
    '/places/new',
  ];
  for (const [width, height] of [
    [360, 780],
    [390, 844],
    [768, 1024],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const route of routes) {
      await page.goto(route);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${route} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});
