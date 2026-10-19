import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { ORIGIN } from '../support';

/**
 * Upload over a real browser (E2E_SCENARIOS UP-01, UP-07, UP-08, UP-11, UP-12,
 * LB-02, LB-03).
 *
 * Files are posted as genuine multipart bodies to the running Next server, which
 * writes real bytes to the isolated media directory. Nothing is mocked.
 */

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

type Manifest = {
  generatedBy: string;
  fixtures: Record<string, { bytes: number; sha256: string; note?: string }>;
};

let manifest: Manifest;
let cookies = '';

test.beforeAll(async () => {
  manifest = JSON.parse(await fs.readFile(path.join(FIXTURES, 'MANIFEST.json'), 'utf8'));
});

async function placeId(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${ORIGIN}/api/places`);
  const body = (await response.json()) as { places: Array<{ id: string; slug: string }> };
  const guishan = body.places.find((place) => place.slug === 'guishan-island');
  if (guishan === undefined) throw new Error('default place missing');
  return guishan.id;
}

async function uploadPhoto(
  request: APIRequestContext,
  place: string,
  fileName: string,
  mime: string,
  fields: Record<string, string>,
) {
  const buffer = await fs.readFile(path.join(FIXTURES, fileName));
  const response = await request.post(`${ORIGIN}/api/places/${place}/photos`, {
    headers: { cookie: cookies },
    multipart: {
      file: { name: fileName, mimeType: mime, buffer },
      ...fields,
    },
  });
  return { response, buffer };
}

test.beforeEach(async ({ request }) => {
  // One shared visitor cookie for upload tests, established through the real API.
  if (cookies !== '') return;
  const response = await request.get(`${ORIGIN}/api/visitor`);
  const setCookie = response.headers()['set-cookie'] ?? '';
  cookies = setCookie.split(';')[0] ?? '';
  expect(cookies).not.toBe('');
});

test('a real multipart upload round-trips the original bytes exactly', async ({ request }) => {
  const place = await placeId(request);
  const { response, buffer } = await uploadPhoto(request, place, 'landscape.jpg', 'image/jpeg', {
    title: '从云端经过桂山岛',
    description: '傍晚从码头走回来',
    idempotencyKey: `e2e-${Date.now()}-a`,
  });

  expect(response.status()).toBe(201);
  const created = (await response.json()) as { photo: { id: string; sha256: string } };

  // 1. The server reports the hash of what we sent.
  const inputSha = createHash('sha256').update(buffer).digest('hex');
  expect(created.photo.sha256).toBe(inputSha);

  // 2. Downloading the original returns those exact bytes.
  const download = await request.get(`${ORIGIN}/api/photos/${created.photo.id}/original`, {
    headers: { cookie: cookies },
  });
  expect(download.status()).toBe(200);

  const downloaded = await download.body();
  expect(createHash('sha256').update(downloaded).digest('hex')).toBe(inputSha);
  expect(downloaded.byteLength).toBe(buffer.byteLength);
  expect(downloaded.equals(buffer)).toBe(true);
  expect(download.headers()['content-length']).toBe(String(buffer.byteLength));
});

test('a second visitor sees the uploaded photo', async ({ browser, request }) => {
  const place = await placeId(request);
  const title = `第二个访客可见 ${Date.now()}`;

  const { response } = await uploadPhoto(request, place, 'portrait.jpg', 'image/jpeg', {
    title,
    idempotencyKey: `e2e-${Date.now()}-b`,
  });
  expect(response.status()).toBe(201);

  // A completely separate browser context, with its own cookie.
  const bobContext = await browser.newContext();
  try {
    const bob = await bobContext.request.get(`${ORIGIN}/api/places/${place}/photos`);
    expect(bob.status()).toBe(200);
    const list = (await bob.json()) as { items: Array<{ title: string }> };
    expect(list.items.map((item) => item.title)).toContain(title);
  } finally {
    await bobContext.close();
  }
});

test('an idempotency replay returns 200 and does not create a second photo', async ({
  request,
}) => {
  const place = await placeId(request);
  const idempotencyKey = `e2e-${Date.now()}-c`;

  const first = await uploadPhoto(request, place, 'square.png', 'image/png', {
    title: '幂等测试',
    idempotencyKey,
  });
  expect(first.response.status()).toBe(201);
  const firstBody = (await first.response.json()) as { photo: { id: string } };

  const second = await uploadPhoto(request, place, 'square.png', 'image/png', {
    title: '幂等测试',
    idempotencyKey,
  });
  // A replay is a success, not a fresh creation.
  expect(second.response.status()).toBe(200);
  const secondBody = (await second.response.json()) as { photo: { id: string; reused: boolean } };
  expect(secondBody.photo.id).toBe(firstBody.photo.id);
  expect(secondBody.photo.reused).toBe(true);
});

test('a text file wearing an image extension is refused with 415', async ({ request }) => {
  const place = await placeId(request);
  const { response } = await uploadPhoto(request, place, 'invalid-text.jpg', 'image/jpeg', {
    idempotencyKey: `e2e-${Date.now()}-d`,
  });

  expect(response.status()).toBe(415);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
    'UNSUPPORTED_MEDIA_TYPE',
  );
});

test('a corrupt JPEG is refused and nothing is left on the leaderboard', async ({ request }) => {
  const place = await placeId(request);
  const { response } = await uploadPhoto(request, place, 'corrupt.jpg', 'image/jpeg', {
    idempotencyKey: `e2e-${Date.now()}-e`,
  });

  expect(response.status()).toBeGreaterThanOrEqual(400);
  const body = (await response.json()) as { error: { code: string } };
  expect(['INVALID_IMAGE', 'UNSUPPORTED_MEDIA_TYPE']).toContain(body.error.code);
});

test('an SVG is refused outright', async ({ request }) => {
  const place = await placeId(request);
  const { response } = await uploadPhoto(request, place, 'script.svg', 'image/svg+xml', {
    idempotencyKey: `e2e-${Date.now()}-f`,
  });

  expect(response.status()).toBe(415);
});

test('an oversize upload is refused with 413', async ({ request }) => {
  const place = await placeId(request);
  const buffer = Buffer.alloc(26 * 1024 * 1024, 0x41); // 26 MiB of 'A'

  const response = await request.post(`${ORIGIN}/api/places/${place}/photos`, {
    headers: { cookie: cookies },
    multipart: {
      file: { name: 'huge.jpg', mimeType: 'image/jpeg', buffer },
      idempotencyKey: `e2e-${Date.now()}-g`,
    },
    // Playwright would otherwise wait for a 25 MiB body to finish uploading.
    failOnStatusCode: false,
  });

  expect(response.status()).toBe(413);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
    'PHOTO_TOO_LARGE',
  );
});

test('previews are generated at both widths and the original is not re-encoded', async ({
  request,
}) => {
  const place = await placeId(request);
  const { response } = await uploadPhoto(request, place, 'extreme-wide.webp', 'image/webp', {
    title: '超宽海平线',
    idempotencyKey: `e2e-${Date.now()}-h`,
  });
  expect(response.status()).toBe(201);
  const { photo } = (await response.json()) as { photo: { id: string } };

  for (const size of [400, 1200]) {
    const preview = await request.get(`${ORIGIN}/api/photos/${photo.id}/preview/${size}`, {
      headers: { cookie: cookies },
    });
    expect(preview.status(), `preview ${size}`).toBe(200);
    expect(preview.headers()['content-type']).toBe('image/webp');
  }

  // The original keeps its own format rather than becoming a WebP.
  const original = await request.get(`${ORIGIN}/api/photos/${photo.id}/original`, {
    headers: { cookie: cookies },
  });
  expect(original.headers()['content-type']).toBe('image/webp');
  expect(
    (await original.body()).equals(await fs.readFile(path.join(FIXTURES, 'extreme-wide.webp'))),
  ).toBe(true);
});

test('a download response carries a safe filename and attachment disposition', async ({
  request,
}) => {
  const place = await placeId(request);
  const { response } = await uploadPhoto(request, place, 'landscape-2.jpg', 'image/jpeg', {
    title: '下载测试',
    idempotencyKey: `e2e-${Date.now()}-i`,
  });
  expect(response.status()).toBe(201);
  const { photo } = (await response.json()) as { photo: { id: string } };

  const download = await request.get(`${ORIGIN}/api/photos/${photo.id}/download`, {
    headers: { cookie: cookies },
  });

  expect(download.status()).toBe(200);
  const disposition = download.headers()['content-disposition'] ?? '';
  expect(disposition).toContain('attachment');
  expect(disposition).toContain('landscape-2.jpg');
  expect(disposition).not.toContain('..');
});

test('the generated fixtures match their recorded manifest', async () => {
  // Guards the visual-regression and byte-exactness suites against a fixture
  // being regenerated with different bytes.
  for (const [name, entry] of Object.entries(manifest.fixtures)) {
    const bytes = await fs.readFile(path.join(FIXTURES, name));
    expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(entry.sha256);
    expect(bytes.byteLength, name).toBe(entry.bytes);
  }
});
