import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { waitForHydration } from '../support';

/**
 * 每图真实进度，以及连接断了以后还能重试
 * （FRONTEND_UX §3.5「按每图维持 queued/uploading/success/failed 和进度」，
 * E2E_SCENARIOS UP-05「进度与并发限制可证明」，MASTER_PLAN Phase 03
 * 「单图进度/失败重试」）。
 *
 * 之前这里只有一句「上传中…」，没有百分比，也没有超时：
 *   - 「进度」这条验收项其实没实现，只是有了一个状态；
 *   - fetch 没有上传进度事件，也就无从谈起「可测进度」；
 *   - 更要命的是，一个永远不返回的请求会让这一行永远停在「上传中」——
 *     既不会变成「失败」，也就永远不出现「重试这一张」按钮。用户被卡死在
 *     一个转圈里，只能刷新页面。
 *
 * 故障注入方式：page.route 拦下上传请求，延迟之后再失败。这是**网络层**的
 * 故障注入——请求真的发不出去、真的不返回。和 setOffline 一样，它不碰任何
 * 一行产品代码，被验证的是产品自己的超时与重试逻辑，而不是测试写好的桩。
 * （本站 API 的响应内容从不伪造：这里根本没有响应，只有沉默。）
 */

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

/** 每个用例自建地点，避免多个浏览器项目并发写同一个地点的榜单。 */
async function createPlace(page: Page, label: string) {
  const name = `${label} ${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const response = await page.request.post('/api/places', {
    data: { name, region: '测试地区' },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { place: { id: string; slug: string } };
  return body.place;
}

async function queueFiles(page: Page, files: string[]): Promise<void> {
  await page
    .getByTestId('file-input')
    .setInputFiles(files.map((file) => path.join(FIXTURES, file)));
  await expect(page.getByTestId('upload-rows').locator('.upload-row')).toHaveCount(files.length);
}

async function acceptExifConsent(page: Page): Promise<void> {
  const consent = page.getByTestId('exif-consent-input');
  if ((await consent.isChecked()) === false) await consent.check();
}

/** A photograph big enough that the browser reports it in several pieces. */
async function makeLargePhoto(): Promise<string> {
  const sharp = (await import('sharp')).default;
  // os.tmpdir(), not process.env.TEMP -- see batch-upload.spec.ts: TEMP is a
  // Windows variable and is undefined on Linux.
  const file = path.join(
    os.tmpdir(),
    `isle-progress-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.jpg`,
  );
  // Random noise does not compress, so the file is genuinely large.
  const noise = Buffer.alloc(3200 * 2100 * 3);
  for (let index = 0; index < noise.length; index += 1) {
    noise[index] = Math.floor(Math.random() * 256);
  }
  await sharp(noise, { raw: { width: 3200, height: 2100, channels: 3 } })
    .jpeg({ quality: 100 })
    .toFile(file);
  return file;
}

test('上传时逐图显示进度条，读屏能拿到百分比', async ({ page }) => {
  test.setTimeout(120_000);

  const place = await createPlace(page, '进度岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await queueFiles(page, ['landscape.jpg']);
  await acceptExifConsent(page);
  await page.getByTestId('upload-submit').click();

  const bar = page.getByRole('progressbar');
  await expect(bar).toBeVisible({ timeout: 60_000 });
  await expect(bar).toHaveAttribute('aria-valuemin', '0');
  await expect(bar).toHaveAttribute('aria-valuemax', '100');

  // The accessible value and the visible number must be the same number.
  const shown = await page.locator('[data-testid^="upload-progress-"]').first().innerText();
  const value = Number(shown.replace('%', '').trim());
  expect(Number.isFinite(value)).toBe(true);
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(100);
  await expect(bar).toHaveAttribute('aria-valuenow', String(value));

  await expect(page.getByTestId('upload-summary')).toContainText('1 张成功', { timeout: 90_000 });
  // 成功之后进度条不再占位。
  await expect(page.getByRole('progressbar')).toHaveCount(0);
});

test('百分比是浏览器真实上报的字节比例，不是一个假装的计时器', async ({ page, browserName }) => {
  // Chromium only: the throttling below is a CDP capability. The other
  // browsers get the semantics test above, which does not need a slow link.
  test.skip(browserName !== 'chromium', 'throttling the upload uses a Chromium CDP session');

  test.setTimeout(180_000);

  const place = await createPlace(page, '真实进度岛');
  const large = await makeLargePhoto();

  try {
    await page.goto(`/places/${place.slug}/upload`);
    await waitForHydration(page);

    // Record the browser's own upload events. This is observation only: the
    // product code is not touched, and nothing is faked. The point is to
    // compare what the browser reported against what the page displayed.
    await page.evaluate(() => {
      const recorder = { events: [] as Array<{ loaded: number; total: number }> };
      (window as unknown as { __isleProgress: typeof recorder }).__isleProgress = recorder;
      const original = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function patched(this: XMLHttpRequest, ...args: unknown[]) {
        this.upload.addEventListener('progress', (event) => {
          recorder.events.push({ loaded: event.loaded, total: event.total });
        });
        return original.apply(this, args as never);
      };
    });

    // Throttle the upload. On loopback a 9 MB body leaves in under 50 ms and
    // the browser coalesces the whole thing into a single event, so there is
    // nothing to observe without a slow link. This is network-layer
    // conditioning, the same kind of thing a phone on a weak signal sees.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 20,
      downloadThroughput: -1,
      uploadThroughput: 400 * 1024,
    });

    await page.getByTestId('file-input').setInputFiles([large]);
    await acceptExifConsent(page);

    // Sample what the page shows while the upload is running.
    const shown: number[] = [];
    const sampler = setInterval(async () => {
      const texts = await page.locator('[data-testid^="upload-progress-"]').allInnerTexts();
      for (const text of texts) {
        const parsed = Number(text.replace('%', '').trim());
        if (Number.isFinite(parsed)) shown.push(parsed);
      }
    }, 40);

    await page.getByTestId('upload-submit').click();
    await expect(page.getByTestId('upload-summary')).toContainText('1 张成功', {
      timeout: 150_000,
    });
    clearInterval(sampler);

    const events = await page.evaluate(
      () =>
        (
          window as unknown as {
            __isleProgress: { events: Array<{ loaded: number; total: number }> };
          }
        ).__isleProgress.events,
    );

    // The browser really did report progress in pieces.
    expect(events.length, '浏览器没有分批上报上传进度').toBeGreaterThan(2);

    // Every percentage the page displayed must be one the browser actually
    // reported. A progress bar driven by a clock would show values that
    // correspond to no byte count at all, and this assertion is what rules
    // that out.
    //
    // 0% and 100% are exempt: 0% is the state the row is put in when the
    // upload starts, before a single byte has gone out, and 100% is the
    // state it is put in when the upload finishes. Those are the two ends of
    // the bar, not measurements. Everything in between has to be a real ratio.
    const reported = new Set(
      events.map((event) =>
        event.total > 0 ? Math.min(100, Math.round((event.loaded / event.total) * 100)) : 0,
      ),
    );
    const uniqueShown = [...new Set(shown)];
    expect(uniqueShown.length, '页面上没有出现过任何进度值').toBeGreaterThan(0);
    for (const value of uniqueShown) {
      if (value === 0 || value === 100) continue;
      expect(reported.has(value), `页面显示了 ${value}%，但浏览器从未上报过这个比例`).toBe(true);
    }

    // At least one value strictly between 0 and 100: the bar is not just
    // jumping straight from nothing to done.
    const intermediates = uniqueShown.filter((value) => value > 0 && value < 100);
    expect(
      intermediates.length,
      `没有观察到中间进度值：${JSON.stringify(uniqueShown)}`,
    ).toBeGreaterThan(0);

    // And the value never goes backwards.
    const firstIndex = shown.indexOf(intermediates[0] ?? -1);
    expect(
      shown
        .slice(firstIndex)
        .every((value, index, list) => index === 0 || value >= list[index - 1]!),
    ).toBe(true);
  } finally {
    await fs.rm(large, { force: true }).catch(() => undefined);
  }
});

/**
 * A request that may land on a stale keep-alive socket.
 *
 * The server closes an idle connection after its keep-alive timeout, and this
 * case waits longer than that between two requests -- the twelve seconds of
 * the injected delay plus the five seconds of the client timeout. If the
 * client then reuses the closed socket, the request fails with ECONNRESET
 * before a byte is sent. That is a race between the client and the server's
 * idle timeout, not a product fault: the browser's own requests are not
 * affected, and every real HTTP client retries it. This retries it too, and
 * only that -- a genuine failure still fails.
 */
async function getWithStaleSocketRetry(page: Page, url: string): Promise<APIResponse> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.request.get(url);
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';
      const message = (error as Error).message ?? '';
      const stale = code === 'ECONNRESET' || code === 'EPIPE' || message.includes('ECONNRESET');
      if (!stale || attempt === 2) throw error;
    }
  }
  throw new Error('unreachable');
}

test('连接一直不返回时，这一行会失败并给出重试入口', async ({ page }) => {
  test.setTimeout(120_000);

  const place = await createPlace(page, '超时岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await queueFiles(page, ['landscape.jpg']);
  await acceptExifConsent(page);

  // ---- 故障注入：请求发出去，但服务器永远不回答 ------------------------
  // 延迟要长过客户端的应答超时（e2e 环境里是 5 秒），这样测到的确实是
  // 「客户端等不到答案，自己收手」，而不是「服务端拒收」。
  await page.route('**/api/places/*/photos', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    await route.abort('failed').catch(() => undefined);
  });

  await page.getByTestId('upload-submit').click();

  const row = page.getByTestId('upload-rows').locator('.upload-row').first();

  // 关键断言：这一行不能永远停在「上传中」。
  await expect(row.locator('.upload-status')).toHaveText('失败', { timeout: 60_000 });

  // 原因是人话，不是状态码。
  const reason = (await row.locator('.upload-error').innerText()).replace(/\s+/g, ' ').trim();
  expect(reason).toMatch(/连接|网络|重试/);
  expect(reason).not.toMatch(/上传失败（\d+）/);

  // 而且必须留下重试入口——用户得能自己把这张再发一次。
  await expect(row.getByRole('button', { name: '重试这一张' })).toBeVisible();

  await page.unroute('**/api/places/*/photos');
});

test('超时之后重试能成功，服务端只落一张', async ({ page }) => {
  test.setTimeout(120_000);

  const place = await createPlace(page, '超时重试岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await queueFiles(page, ['landscape.jpg']);
  await acceptExifConsent(page);

  await page.route('**/api/places/*/photos', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    await route.abort('failed').catch(() => undefined);
  });

  await page.getByTestId('upload-submit').click();

  const row = page.getByTestId('upload-rows').locator('.upload-row').first();
  await expect(row.locator('.upload-status')).toHaveText('失败', { timeout: 60_000 });

  // ---- 恢复：这一次请求照常送到真实服务器 ----------------------------
  await page.unroute('**/api/places/*/photos');

  await row.getByRole('button', { name: '重试这一张' }).click();
  await expect(row.locator('.upload-status')).toHaveText('已上传', { timeout: 60_000 });

  // 服务端只有一张：超时的那次没有留下半成品记录。
  const listing = (await (
    await getWithStaleSocketRetry(page, `/api/places/${place.id}/photos`)
  ).json()) as {
    items: Array<{ id: string }>;
    total: number;
  };
  expect(listing.items).toHaveLength(1);
  expect(listing.total).toBe(1);

  // 而且存下来的确实是原始字节。
  const item = listing.items[0];
  const original = await page.request.get(`/api/photos/${item?.id ?? ''}/original`);
  expect(original.status()).toBe(200);
  const expected = await fs.readFile(path.join(FIXTURES, 'landscape.jpg'));
  expect((await original.body()).equals(expected)).toBe(true);
});
