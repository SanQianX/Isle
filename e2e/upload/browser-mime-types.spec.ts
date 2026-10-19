import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { waitForHydration } from '../support';

/**
 * Browsers do not agree on a file's MIME type.
 *
 * WebKit leaves `File.type` empty for `.webp` files, so the multipart part
 * arrives as `application/octet-stream`. A check that trusts the declared type
 * therefore rejects a photo the server handles perfectly -- and locks Safari
 * users out of a format the product supports.
 *
 * The rule this file pins down: the *bytes* decide. A missing or generic
 * declared type is no reason to refuse anything.
 */

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

/** Every format the product accepts, across all three container types. */
const ACCEPTED: Array<{ file: string; mime: string }> = [
  { file: 'landscape.jpg', mime: 'image/jpeg' },
  { file: 'square.png', mime: 'image/png' },
  { file: 'extreme-wide.webp', mime: 'image/webp' },
];

test('every accepted format uploads regardless of what the browser reports', async ({ page }) => {
  const name = `格式兼容岛 ${process.pid}-${Date.now()}`;
  const created = await page.request.post('/api/places', {
    data: { name, region: '测试地区' },
  });
  expect(created.status()).toBe(201);
  const place = (await created.json()) as { place: { id: string; slug: string } };

  await page.goto(`/places/${place.place.slug}/upload`);
  await waitForHydration(page);

  // What the browser actually claims about each file. Recorded, not asserted:
  // the point of the test is that the *outcome* does not depend on it.
  const claimed: string[] = [];
  await page.evaluate(() => {
    const w = window as unknown as { __mime: string[] };
    w.__mime = [];
    const input = document.querySelector('[data-testid="file-input"]') as HTMLInputElement;
    input.addEventListener('change', () => {
      for (const file of Array.from(input.files ?? [])) {
        w.__mime.push(`${file.name}=${file.type || '(empty)'}`);
      }
    });
  });

  await page
    .getByTestId('file-input')
    .setInputFiles(ACCEPTED.map((entry) => path.join(FIXTURES, entry.file)));
  await page.getByTestId('exif-consent-input').check();
  await page.getByTestId('upload-submit').click();

  await expect(page.getByTestId('upload-summary')).toContainText('3 张成功', { timeout: 60_000 });

  const mime = await page.evaluate(() => (window as unknown as { __mime: string[] }).__mime);
  claimed.push(...mime);

  // The server stored all three, and each original is byte-identical.
  const listing = await (await page.request.get(`/api/places/${place.place.id}/photos`)).json();
  expect(listing.items).toHaveLength(3);

  for (const entry of ACCEPTED) {
    const stored = listing.items.find(
      (item: { title: string }) => item.title === entry.file.replace(/\.[^.]+$/, ''),
    );
    expect(stored, `${entry.file} was not stored`).toBeTruthy();
    expect(stored.mime).toBe(entry.mime);

    const bytes = await (await page.request.get(stored.originalUrl)).body();
    const expected = await fs.readFile(path.join(FIXTURES, entry.file));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      createHash('sha256').update(expected).digest('hex'),
    );
  }
});
