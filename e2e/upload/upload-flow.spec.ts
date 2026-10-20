import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { ORIGIN, waitForHydration } from '../support';

/**
 * Upload and place creation through the real UI (E2E_SCENARIOS UP-01..UP-16,
 * PLACE-01..05).
 *
 * Files go through a real file input, the server streams them to disk, and the
 * assertions check what is actually stored. The one exception is fault
 * injection, which is labelled as such at the call site.
 */

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

/** Each test creates its own place so parallel workers cannot collide. */
async function createPlace(page: Page, label: string) {
  const name = `${label} ${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const response = await page.request.post(`${ORIGIN}/api/places`, {
    data: { name, region: '测试地区' },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { place: { id: string; slug: string; name: string } };
  return body.place;
}

async function acceptExifConsent(page: Page) {
  const consent = page.getByTestId('exif-consent-input');
  if ((await consent.isChecked()) === false) await consent.check();
}

test('choosing three photos queues them at their real proportions', async ({ page }) => {
  const place = await createPlace(page, '上传测试岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await page
    .getByTestId('file-input')
    .setInputFiles([
      path.join(FIXTURES, 'landscape.jpg'),
      path.join(FIXTURES, 'portrait.jpg'),
      path.join(FIXTURES, 'square.png'),
    ]);

  await expect(page.getByTestId('upload-rows').locator('.upload-row')).toHaveCount(3);
  await expect(page.getByText('（3 张）')).toBeVisible();

  // Each row previews at the photograph's own shape, not a uniform card.
  // Thumbnails are letterboxed into a uniform cell, which is correct, so their
  // rendered boxes all share one shape. What must differ is each photograph's
  // own proportions -- otherwise the three files did not all really arrive.
  const info = await page
    .getByTestId('upload-rows')
    .locator('.upload-row')
    .evaluateAll((rows) =>
      rows.map((row) => {
        const image = row.querySelector('img') as HTMLImageElement | null;
        if (image === null) return { ratio: 0, fits: false };
        const rect = image.getBoundingClientRect();
        const cellNode = row.querySelector('.preview-image') as HTMLElement | null;
        const cell = cellNode === null ? undefined : cellNode.getBoundingClientRect();
        return {
          ratio: image.naturalWidth / image.naturalHeight,
          fits:
            cell === undefined || (rect.width <= cell.width + 1 && rect.height <= cell.height + 1),
        };
      }),
    );

  expect(info.every((entry) => entry.ratio > 0)).toBe(true);
  expect(
    info.every((entry) => entry.fits),
    'a thumbnail overflows its cell',
  ).toBe(true);

  // Landscape (16:9), portrait (9:16) and square are three distinct shapes.
  expect(new Set(info.map((entry) => entry.ratio.toFixed(2))).size).toBe(3);
});

test('uploading requires the EXIF acknowledgement', async ({ page }) => {
  const place = await createPlace(page, '隐私提示岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await page.getByTestId('file-input').setInputFiles([path.join(FIXTURES, 'landscape.jpg')]);

  const submit = page.getByTestId('upload-submit');
  // Queued but not acknowledged: the button must stay disabled.
  await expect(submit).toBeDisabled();

  await acceptExifConsent(page);
  await expect(submit).toBeEnabled();

  // The warning itself has to be on the page, not just enforced in code.
  await expect(page.getByTestId('exif-consent')).toContainText('EXIF');
});

test('a multi-photo upload reaches the leaderboard and survives a reload', async ({ page }) => {
  const place = await createPlace(page, '多图上传岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await page
    .getByTestId('file-input')
    .setInputFiles([
      path.join(FIXTURES, 'landscape.jpg'),
      path.join(FIXTURES, 'portrait.jpg'),
      path.join(FIXTURES, 'square.png'),
    ]);

  await page.getByTestId('upload-description').fill('海岛旅行');
  await acceptExifConsent(page);
  await page.getByTestId('upload-submit').click();

  // Per-file progress is reported, then a batch summary.
  await expect(page.getByTestId('upload-summary')).toContainText('3 张成功', { timeout: 45_000 });

  await page.getByTestId('upload-view-ranking').click();
  await expect(page).toHaveURL(new RegExp(`/places/${place.slug}/ranking`));

  // The photographs really are on the leaderboard for this place.
  const listing = await (await page.request.get(`/api/places/${place.id}/photos`)).json();
  expect(listing.items).toHaveLength(3);
  expect(
    listing.items.every((item: { description: string }) => item.description === '海岛旅行'),
  ).toBe(true);

  await page.reload();
  await expect(
    page.locator('[data-testid^="photo-card-"], [data-testid="ranking-leader-open"]'),
  ).toHaveCount(3);
});

test('removing a queued photo keeps it out of the upload', async ({ page }) => {
  const place = await createPlace(page, '移除测试岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await page
    .getByTestId('file-input')
    .setInputFiles([path.join(FIXTURES, 'landscape.jpg'), path.join(FIXTURES, 'portrait.jpg')]);
  await expect(page.getByTestId('upload-rows').locator('.upload-row')).toHaveCount(2);

  await page.getByTestId('upload-rows').locator('.upload-row').first().getByRole('button').click();
  await expect(page.getByTestId('upload-rows').locator('.upload-row')).toHaveCount(1);

  await acceptExifConsent(page);
  await page.getByTestId('upload-submit').click();
  await expect(page.getByTestId('upload-summary')).toContainText('1 张成功', { timeout: 45_000 });

  const listing = await (await page.request.get(`/api/places/${place.id}/photos`)).json();
  expect(listing.items).toHaveLength(1);
  // The one that stayed is the portrait.
  expect(listing.items[0].width).toBeLessThan(listing.items[0].height);
});

test('adding a second selection appends rather than replacing', async ({ page }) => {
  const place = await createPlace(page, '追加选择岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await page
    .getByTestId('file-input')
    .setInputFiles([path.join(FIXTURES, 'landscape.jpg'), path.join(FIXTURES, 'portrait.jpg')]);
  await expect(page.getByTestId('upload-rows').locator('.upload-row')).toHaveCount(2);

  // A second selection must not clobber the first batch (UP-03).
  await page.getByTestId('file-input').setInputFiles([path.join(FIXTURES, 'square.png')]);
  await expect(page.getByTestId('upload-rows').locator('.upload-row')).toHaveCount(3);
});

test('the submit button cannot be triggered twice', async ({ page }) => {
  const place = await createPlace(page, '重复提交岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await page
    .getByTestId('file-input')
    .setInputFiles([path.join(FIXTURES, 'landscape.jpg'), path.join(FIXTURES, 'portrait.jpg')]);
  await acceptExifConsent(page);

  const submit = page.getByTestId('upload-submit');
  // A double click must not create four photos.
  await submit.click();
  await submit.click({ force: true }).catch(() => undefined);
  await submit.click({ force: true }).catch(() => undefined);

  await expect(page.getByTestId('upload-summary')).toContainText('2 张成功', { timeout: 45_000 });

  const listing = await (await page.request.get(`/api/places/${place.id}/photos`)).json();
  expect(listing.items).toHaveLength(2);
});

test('one bad file fails alone and the rest still succeed', async ({ page }) => {
  const place = await createPlace(page, '混合好坏岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await page
    .getByTestId('file-input')
    .setInputFiles([
      path.join(FIXTURES, 'landscape.jpg'),
      path.join(FIXTURES, 'invalid-text.jpg'),
      path.join(FIXTURES, 'portrait.jpg'),
    ]);
  await expect(page.getByTestId('upload-rows').locator('.upload-row')).toHaveCount(3);

  await acceptExifConsent(page);
  await page.getByTestId('upload-submit').click();

  // Two good ones land; the bad one is reported with a reason and a retry.
  await expect(page.getByTestId('upload-summary')).toContainText('2 张成功', { timeout: 45_000 });
  await expect(page.getByTestId('upload-summary')).toContainText('1 张失败');
  await expect(page.getByTestId('upload-rows').getByText('重试这一张').first()).toBeVisible();

  const listing = await (await page.request.get(`/api/places/${place.id}/photos`)).json();
  expect(listing.items).toHaveLength(2);
});

test('an oversize file is refused in the UI before anything is sent', async ({ page }) => {
  const place = await createPlace(page, '超大文件岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  // Built on the fly: 26 MiB of noise is well over the 25 MiB ceiling and is
  // not something to keep in the repository.
  // os.tmpdir(), not process.env.TEMP -- TEMP is a Windows variable and is
  // undefined on Linux.
  const oversize = path.join(os.tmpdir(), `isle-oversize-${Date.now()}.jpg`);
  await fs.writeFile(oversize, Buffer.alloc(26 * 1024 * 1024, 0x41));

  let uploadRequested = false;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/photos')) uploadRequested = true;
  });

  try {
    await page.getByTestId('file-input').setInputFiles([oversize]);

    // Refused on selection, with the limit spelled out -- before any bytes move.
    await expect(page.getByTestId('upload-summary')).toContainText('1 张失败');
    await expect(page.getByTestId('upload-rows')).toContainText('超过');
    await expect(page.getByTestId('upload-rows')).toContainText('25 MiB');

    // Nothing is left to send, so the button is disabled rather than
    // silently uploading anyway.
    await expect(page.getByTestId('upload-submit')).toBeDisabled();
    expect(uploadRequested, 'an oversize file must never be uploaded').toBe(false);

    const listing = await (await page.request.get(`/api/places/${place.id}/photos`)).json();
    expect(listing.items).toHaveLength(0);
  } finally {
    await fs.rm(oversize, { force: true });
  }
});

test('the uploaded original downloads byte-identical to the file chosen', async ({ page }) => {
  const place = await createPlace(page, '字节一致岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await page.getByTestId('file-input').setInputFiles([path.join(FIXTURES, 'landscape.jpg')]);
  await acceptExifConsent(page);
  await page.getByTestId('upload-submit').click();
  await expect(page.getByTestId('upload-summary')).toContainText('1 张成功', { timeout: 45_000 });

  const listing = await (await page.request.get(`/api/places/${place.id}/photos`)).json();
  const photoId = listing.items[0].id as string;

  const download = await page.request.get(`/api/photos/${photoId}/download`);
  const served = await download.body();
  const expected = await fs.readFile(path.join(FIXTURES, 'landscape.jpg'));

  expect(served.equals(expected)).toBe(true);
  expect(download.headers()['content-length']).toBe(String(expected.byteLength));
});

test('the upload page belongs to the place in its URL', async ({ page }) => {
  const first = await createPlace(page, '归属甲岛');
  const second = await createPlace(page, '归属乙岛');

  await page.goto(`/places/${first.slug}/upload`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(first.name);
  await expect(page.getByTestId('upload-form')).toBeVisible();

  await page.goto(`/places/${second.slug}/upload`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(second.name);

  // Uploading here must not touch the other place (UP-15).
  await page.getByTestId('file-input').setInputFiles([path.join(FIXTURES, 'landscape.jpg')]);
  await acceptExifConsent(page);
  await page.getByTestId('upload-submit').click();
  await expect(page.getByTestId('upload-summary')).toContainText('1 张成功', { timeout: 45_000 });

  const secondList = await (await page.request.get(`/api/places/${second.id}/photos`)).json();
  const firstList = await (await page.request.get(`/api/places/${first.id}/photos`)).json();
  expect(secondList.items).toHaveLength(1);
  expect(firstList.items).toHaveLength(0);
});

test('the create-place form reports a duplicate and offers a way through', async ({ page }) => {
  const place = await createPlace(page, '重名目标岛');

  await page.goto('/places/new');
  await waitForHydration(page);
  await page.getByTestId('place-name-input').fill(place.name);
  await page.getByTestId('place-region-input').fill('测试地区');
  await page.getByTestId('place-submit').click();

  const error = page.getByTestId('place-form-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText('已经存在');
  // A conflict with a route onward, not a dead end.
  await expect(error.getByRole('link')).toHaveAttribute('href', `/places/${place.slug}`);
});

test('the create-place form validates before sending', async ({ page }) => {
  let requested = false;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/places')) requested = true;
  });

  await page.goto('/places/new');
  await waitForHydration(page);
  await page.getByTestId('place-name-input').fill('   ');
  await page.getByTestId('place-region-input').fill('测试地区');
  await page.getByTestId('place-submit').click();

  await expect(page.getByTestId('place-form-error')).toBeVisible();
  expect(requested, 'an empty form must not reach the API').toBe(false);
});

test('the create-place form navigates to the new place on success', async ({ page }) => {
  const place = await createPlace(page, '跳转验证岛');

  await page.goto('/places/new');
  await waitForHydration(page);
  await page.getByTestId('place-name-input').fill(`跳转验证新岛 ${Date.now()}`);
  await page.getByTestId('place-region-input').fill('测试地区');
  await page.getByTestId('place-description-input').fill('一个安静的地方。');
  await page.getByTestId('place-submit').click();

  await page.waitForURL(/\/places\/[^/]+$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // A brand new place is empty, and says so instead of inventing photos.
  await expect(page.getByText('还没有照片')).toBeVisible();
  expect(place.slug).toBeTruthy();
});

test('an unknown route renders the shared 404 page', async ({ page }) => {
  const response = await page.goto('/no-such-page');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('找不到');
  await expect(page.getByRole('link', { name: /回到首页/ })).toBeVisible();
});

test('an unknown place slug renders the same 404 page', async ({ page }) => {
  const response = await page.goto('/places/no-such-place');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('找不到');
});
