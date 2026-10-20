import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * A damaged photograph must produce a message a visitor can act on.
 *
 * The failure used to be a generic "服务器开小差了", and whether it appeared at
 * all depended on which browser sent the file -- the decode failed at a
 * different point on each engine. This pins the behaviour down: whatever the
 * engine, the visitor is told their photograph is damaged and is offered a
 * retry.
 */

test('a damaged photograph is reported as damaged, not as a server error', async ({
  page,
  request,
}) => {
  const place = await request.post('http://127.0.0.1:3017/api/places', {
    data: { name: `损坏照片岛 ${Date.now()}`, region: '测试地区' },
  });
  expect(place.status()).toBe(201);
  const body = (await place.json()) as { place: { id: string; slug: string } };

  await page.goto(`/places/${body.place.slug}/upload`);
  await page.waitForSelector('html[data-hydrated="true"]');

  // A JPEG header followed by truncated data: valid magic bytes, undecodable
  // pixels. This is the case that used to reach the user as a 500.
  const truncated = await fs.readFile(path.join(process.cwd(), 'tests', 'fixtures', 'corrupt.jpg'));
  await page.getByTestId('file-input').setInputFiles({
    name: 'corrupt.jpg',
    mimeType: 'image/jpeg',
    buffer: truncated,
  });

  await page.getByTestId('exif-consent-input').check();
  await page.getByTestId('upload-submit').click();

  const error = page.locator('[data-testid^="upload-error-"]');
  await expect(error).toHaveCount(1, { timeout: 30_000 });

  const reason = (await error.innerText()).replace(/\s+/g, ' ').trim();
  expect(reason).toMatch(/损坏|不完整|无法解析|无法解码/);
  // A machine code is not something a visitor can act on.
  expect(reason).not.toMatch(/INVALID_IMAGE|INTERNAL_ERROR|SQLITE/);
  // And it must not be the catch-all.
  expect(reason).not.toContain('服务器开小差了');

  // A retry is offered rather than a dead end.
  await expect(error.getByRole('button', { name: '重试这一张' })).toBeVisible();
});

test('a file that is not an image at all is refused before it is stored', async ({ request }) => {
  const place = await request.post('http://127.0.0.1:3017/api/places', {
    data: { name: `非图片岛 ${Date.now()}`, region: '测试地区' },
  });
  const body = (await place.json()) as { place: { id: string } };

  const response = await request.post(`http://127.0.0.1:3017/api/places/${body.place.id}/photos`, {
    multipart: {
      file: {
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('this is not a photograph'),
      },
      idempotencyKey: `not-an-image-${Date.now()}`,
    },
  });

  expect(response.status()).toBe(415);
  const error = (await response.json()) as { error: { code: string; message: string } };
  expect(error.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  expect(error.error.message.length).toBeGreaterThan(0);
});
