import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ORIGIN, waitForHydration } from '../support';

/**
 * Visual regression (TEST_STRATEGY §6, VR-01..VR-12).
 *
 * Fixed fixtures and a deterministic place, so a pixel difference means a real
 * layout change. Baselines are captured on Linux CI; local Windows runs write to
 * a separate folder (snapshotPathTemplate in playwright.config.ts and ADR-007),
 * because font rasterisation differs between platforms and mixing them would
 * produce permanent false diffs.
 *
 * Every capture waits for images to decode first, so a screenshot never races
 * the layout.
 */

const DESKTOP = { width: 1440, height: 900 } as const;
const MOBILE = { width: 390, height: 844 } as const;

async function settleImages(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      // Only images inside the viewport are guaranteed to load: the wall marks
      // off-screen tiles lazy, and waiting on those would hang forever.
      const height = window.innerHeight;
      const visible = [...document.querySelectorAll('img')].filter((image) => {
        const rect = image.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < height;
      });
      return (
        visible.length > 0 &&
        visible.every((image) => {
          const element = image as HTMLImageElement;
          return element.complete && element.naturalWidth > 0;
        })
      );
    },
    undefined,
    { timeout: 20_000 },
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function waitForJustifiedWall(page: Page): Promise<void> {
  await expect
    .poll(async () => (await page.locator('.photo-card').first().getAttribute('style')) ?? '', {
      timeout: 20_000,
    })
    .toMatch(/--photo-width/);
}

/**
 * A place with a fixed set of photographs, created once per process. Reused
 * across the cases below so the leaderboard content is identical each run.
 */
async function deterministicPlace(page: Page): Promise<string> {
  // A fixed name, not one derived from the process id. The place name is
  // rendered in the page heading, so a pid in it would make every screenshot
  // differ from the baseline -- the comparison would be measuring the pid
  // rather than the layout.
  // One fixture place per browser project. The projects share a database, so a
  // single shared place would accumulate votes from every project that ran
  // before it, and the score printed under each photograph would differ from
  // one project to the next.
  const name = `视觉基线岛 ${test.info().project.name}`;
  const created = await page.request.post(`${ORIGIN}/api/places`, {
    data: { name, region: '广东 · 珠海 · 万山群岛', description: '视觉回归用的固定地点。' },
  });

  let slug: string | undefined;
  let id: string | undefined;

  if (created.status() === 409) {
    const list = await page.request.get(`${ORIGIN}/api/places`);
    const body = await list.json();
    const existing = body.places.find((place: { name: string }) => place.name === name);
    slug = existing?.slug;
    id = existing?.id;
  } else {
    const body = await created.json();
    slug = body.place.slug;
    id = body.place.id;
  }

  if (slug === undefined || id === undefined) throw new Error('visual fixture place missing');

  const uploads: Array<[string, string, string]> = [
    ['landscape.jpg', 'image/jpeg', '从云端经过桂山岛'],
    ['portrait.jpg', 'image/jpeg', '灯塔亮起的时候'],
    ['square.png', 'image/png', '码头上的午后'],
    ['extreme-wide.webp', 'image/webp', '还没靠岸'],
  ];

  const uploaded: string[] = [];
  for (const [file, mime, title] of uploads) {
    const bytes = await fs.readFile(path.join(process.cwd(), 'tests', 'fixtures', file));
    // The idempotency key makes this a no-op once the fixtures are in place.
    const response = await page.request.post(`${ORIGIN}/api/places/${id}/photos`, {
      multipart: {
        file: { name: file, mimeType: mime, buffer: bytes },
        title,
        idempotencyKey: `visual-${id}-${file}`,
      },
    });
    const body = (await response.json()) as { photo?: { id: string } };
    if (body.photo !== undefined) uploaded.push(body.photo.id);
  }

  // Give the photographs distinct scores.
  //
  // The four are uploaded within the same millisecond, so their upload times
  // tie and the order would fall through to the id tie-break -- and cuid ids
  // are not ordered by creation time within a millisecond. The leaderboard would
  // then be laid out differently on every run, and the screenshot would be
  // comparing a random arrangement rather than the layout. Distinct scores
  // decide the order outright, and a leaderboard where the photographs have
  // different scores is more representative anyway.
  for (const [index, photoId] of uploaded.entries()) {
    const votes = uploaded.length - index - 1;
    for (let voter = 0; voter < votes; voter += 1) {
      // A stable token: the same visitor votes again on a later run, so the row
      // is updated rather than added and the totals stay put.
      const token = `visual-voter-${test.info().project.name}-${index}-${voter}`;
      const identity = await page.request.get(`${ORIGIN}/api/visitor`, {
        headers: { cookie: `isle_visitor=${token}` },
      });
      const cookie = (identity.headers()['set-cookie'] ?? '').split(';')[0] ?? '';
      await page.request.put(`${ORIGIN}/api/photos/${photoId}/vote`, {
        headers: { cookie, 'content-type': 'application/json' },
        data: { value: 1 },
      });
    }
  }

  return slug;
}

/**
 * Screenshot options shared by every baseline.
 *
 * The header shows `访客 #xxxxxx`, a random code minted per browser context.
 * Left unmasked it changes every single run, so every comparison would fail on
 * its own baseline. Masking that one element is what makes the rest of the page
 * comparable; the masked box documents where it was.
 */
/** Mask the random visitor code; see the note above. */
function shot(page: Page) {
  return {
    // Every anonymous visitor code has to be masked, not just the one in the
    // header. The fixtures are uploaded without a cookie, so the server mints
    // a fresh identity on every run and the code printed under each photograph
    // would differ from the baseline every time -- the comparison would be
    // measuring a random six-character string rather than the layout.
    mask: [
      page.getByTestId('visitor-label'),
      page.locator('.caption-author'),
      page.locator('.pick-artist'),
      page.locator('.feature-metrics .visitor'),
    ],
    maskColor: '#ffffff',
  };
}

/**
 * Visual regression runs only in its own invocation (`npm run test:visual`).
 *
 * The harness gives every run a private database, but the full E2E run executes
 * five browser projects and several hundred tests against that one database, so
 * place counts, photo counts and vote totals keep shifting underneath a
 * screenshot. A baseline captured during such a run never matches the next one.
 * Isolate the comparison instead of loosening the tolerance.
 */
test.describe('visual regression', () => {
  test.skip(
    process.env.ISLE_VISUAL !== '1',
    'visual regression runs via `npm run test:visual`, which seeds a private, frozen dataset',
  );

  test('VR-01 home hero with the current leader @visual', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await waitForHydration(page);
    await settleImages(page);

    await expect(page).toHaveScreenshot('vr-01-home-hero.png', shot(page));
  });

  test('VR-02 places index @visual', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await deterministicPlace(page);
    await page.goto('/places');
    await waitForHydration(page);
    await settleImages(page);

    await expect(page).toHaveScreenshot('vr-02-places.png', shot(page));
  });

  test('VR-03 justified wall mixing landscape, portrait and square @visual', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const slug = await deterministicPlace(page);
    await page.goto(`/places/${slug}/ranking`);
    await waitForHydration(page);
    await waitForJustifiedWall(page);
    await settleImages(page);

    // Scroll the wall itself into frame: the leader block sits above the fold,
    // so a viewport-sized shot of the top of the page would not capture the
    // thing this baseline exists to protect.
    await page.locator('.photo-row').first().scrollIntoViewIfNeeded();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await settleImages(page);

    await expect(page).toHaveScreenshot('vr-03-justified-wall.png', shot(page));
  });

  test('VR-04 full ranking @visual', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const slug = await deterministicPlace(page);
    await page.goto(`/places/${slug}/ranking`);
    await waitForHydration(page);
    await settleImages(page);

    await expect(page).toHaveScreenshot('vr-04-ranking.png', shot(page));
  });

  test('VR-05 original viewer @visual', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const slug = await deterministicPlace(page);
    await page.goto(`/places/${slug}/ranking`);
    await waitForHydration(page);
    await page.getByTestId('ranking-leader-open').click();
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await expect(page.getByTestId('lightbox-original-image')).toBeVisible();
    await settleImages(page);

    await expect(page).toHaveScreenshot('vr-05-lightbox.png', shot(page));
  });

  test('VR-06 upload page with three queued photos @visual', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const slug = await deterministicPlace(page);
    await page.goto(`/places/${slug}/upload`);
    await waitForHydration(page);

    const fixtures = path.join(process.cwd(), 'tests', 'fixtures');
    await page
      .getByTestId('file-input')
      .setInputFiles([
        path.join(fixtures, 'landscape.jpg'),
        path.join(fixtures, 'portrait.jpg'),
        path.join(fixtures, 'square.png'),
      ]);
    await expect(page.locator('.upload-row')).toHaveCount(3);
    await settleImages(page);

    await expect(page).toHaveScreenshot('vr-06-upload.png', shot(page));
  });

  test('VR-07 home on a phone @visual', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/');
    await waitForHydration(page);
    await settleImages(page);

    await expect(page).toHaveScreenshot('vr-07-home-mobile.png', shot(page));
  });

  test('VR-08 ranking on a phone @visual', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const slug = await deterministicPlace(page);
    await page.goto(`/places/${slug}/ranking`);
    await waitForHydration(page);
    await settleImages(page);

    await expect(page).toHaveScreenshot('vr-08-ranking-mobile.png', shot(page));
  });

  test('VR-10 mist background @visual', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');
    await waitForHydration(page);
    // The cool-grey alternate is a documented design token, so it is part of the
    // visual contract rather than a palette experiment.
    await page.evaluate(() => document.documentElement.setAttribute('data-tone', 'mist'));
    await settleImages(page);

    await expect(page).toHaveScreenshot('vr-10-mist-home.png', shot(page));
  });

  test('VR-11 empty place invents no photographs @visual', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    // Fixed name: a timestamp here would render into the screenshot and make
    // every run differ from its own baseline.
    const name = `空态基线岛 ${process.pid}`;

    const findByName = async (): Promise<string | undefined> => {
      const list = await page.request.get(`${ORIGIN}/api/places`);
      const body = await list.json();
      return body.places.find((place: { name: string }) => place.name === name)?.slug;
    };

    // Look first, create second: the create can fail with 409 (already seeded)
    // or 429 (the per-visitor daily place quota), and either way the place we
    // need already exists.
    let slug = await findByName();
    if (slug === undefined) {
      const created = await page.request.post(`${ORIGIN}/api/places`, {
        data: { name, region: '测试地区' },
      });
      slug = await findByName();
      if (slug === undefined) {
        const detail = await created.text();
        throw new Error(
          `could not obtain the VR-11 empty place "${name}" (status ${created.status()}): ${detail.slice(0, 200)}`,
        );
      }
    }

    await page.goto(`/places/${slug}`);
    await waitForHydration(page);

    await expect(page.getByText('还没有照片')).toBeVisible();
    await expect(page.locator('img')).toHaveCount(0);

    await expect(page).toHaveScreenshot('vr-11-empty-mobile.png', shot(page));
  });

  test('VR-12 upload failure state @visual', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const slug = await deterministicPlace(page);
    await page.goto(`/places/${slug}/upload`);
    await waitForHydration(page);

    const fixtures = path.join(process.cwd(), 'tests', 'fixtures');
    // A text file named .jpg passes the browser's type guess, so it is the
    // server that must refuse it -- the state this baseline pins down.
    await page.getByTestId('file-input').setInputFiles([path.join(fixtures, 'invalid-text.jpg')]);
    await page.getByTestId('exif-consent-input').check();
    await page.getByTestId('upload-submit').click();
    await expect(page.getByTestId('upload-summary')).toContainText('失败', { timeout: 45_000 });
    await expect(page.getByTestId('upload-rows')).toContainText('重试这一张');
    // No image settling here: the preview is a text file, which never decodes,
    // so waiting for naturalWidth would hang forever.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );

    await expect(page).toHaveScreenshot('vr-12-upload-failed.png', shot(page));
  });
});
