import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page, type Request } from '@playwright/test';
import { waitForHydration } from '../support';

/**
 * 批量上传验收（MASTER_PLAN Phase 03「批量 10 张中 1 张错误时另外 9 张可独立成功并反馈」，
 * E2E_SCENARIOS UP-05 / UP-09）。
 *
 * 与 upload-flow.spec.ts 的分工：那边验证 1–3 张的小批次交互（拖拽、重排、重复提交），
 * 这边只钉两条更大的合同——
 *   1. 一批 10 张里单张失败，另外 9 张各自成功，服务端只落 9 条 Photo 行；
 *   2. 同时在途的浏览器上传请求不超过服务端下发的并发上限。
 *
 * 全程不拦截本站 API：文件经真实 file input 进入页面，由真实 fetch 发 multipart，
 * 服务端写真实磁盘，断言读回来的也是服务端真的存下来的字节。
 */

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

/**
 * 坏文件选 corrupt.jpg（合法 JPEG 头 + 被截断的图像数据）而不是 invalid-text.jpg（33 字节纯文本）：
 * 前者的扩展名、MIME 嗅探、甚至前几个字节都是合法 JPEG，前端校验和浏览器都放行，
 * 只有服务端真正解码时才会拒绝——这才证明「服务端按内容判定，而不是相信声明」。
 * 用 invalid-text.jpg 也能失败，但证明不了解码这条路径。
 */
const BAD_FILE = 'corrupt.jpg';

/** 9 张真实照片，恰好凑满「10 张里 1 张坏」，同时覆盖横/竖/方/超宽/超高/极小与带 EXIF 的两种。 */
const GOOD_FILES = [
  'landscape.jpg',
  'landscape-2.jpg',
  'portrait.jpg',
  'square.png',
  'extreme-wide.webp',
  'extreme-tall.jpg',
  'small.jpeg',
  'exif-rotate.jpg',
  'gps-exif.jpg',
];

/** 抽两张做字节比对：一张带 EXIF 的 JPEG、一张 WebP，覆盖两种解码分支。 */
const BYTE_CHECK_FILES = ['gps-exif.jpg', 'extreme-wide.webp'];

/** 每个用例自建地点，避免多个浏览器项目并发写同一个地点的榜单。 */
async function createPlace(page: Page, label: string) {
  // 用相对路径而不是写死 http://127.0.0.1:3017：E2E_PORT 换端口后写死的地址会指向别人的服务，
  // 用例就会对着一个「恰好也在跑」的实例假绿。
  const name = `${label} ${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const response = await page.request.post('/api/places', {
    data: { name, region: '测试地区' },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { place: { id: string; slug: string; name: string } };
  return body.place;
}

async function queueFiles(page: Page, files: string[]): Promise<void> {
  // 夹具名走 FIXTURES 目录，但调用方也可能塞一个绝对路径（临时生成的第 10 张），
  // 无条件 path.join 会把绝对路径拼成 D:\...\fixtures\C:\... 这种废品。
  await page
    .getByTestId('file-input')
    .setInputFiles(files.map((file) => (path.isAbsolute(file) ? file : path.join(FIXTURES, file))));
  await expect(page.getByTestId('upload-rows').locator('.upload-row')).toHaveCount(files.length);
}

async function acceptExifConsent(page: Page): Promise<void> {
  const consent = page.getByTestId('exif-consent-input');
  if ((await consent.isChecked()) === false) await consent.check();
}

/**
 * 统计「浏览器发起」的上传请求的在途峰值。
 *
 * 只有浏览器发起的请求受客户端并发上限约束：`page.request` 走的是另一套 APIRequestContext，
 * 不会触发 page 的网络事件，所以它天然不会混进这个计数——不需要额外过滤。
 *
 * 收尾事件用 response 而不是 requestfinished，这是踩过的坑：UploadForm 在成功分支里
 * 只调 `patch()` 就不管了，只有失败分支才 `response.json()`。Chromium 只有在响应体被读完
 * 或被回收时才发 loadingFinished，于是这些成功上传的 requestfinished 永远不触发——
 * 用它计数会把 10 次上传全部算成「同时在途」。response 在响应头到达时就触发，
 * 正好对应「已经发出、还没拿到服务端答复」这段窗口。
 */
function trackBrowserUploads(page: Page, uploadPath: string) {
  const inFlight = new Set<Request>();
  let peak = 0;
  let started = 0;

  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (new URL(request.url()).pathname !== uploadPath) return;
    inFlight.add(request);
    started += 1;
    peak = Math.max(peak, inFlight.size);
  });
  const settle = (request: Request) => {
    inFlight.delete(request);
  };
  page.on('response', (response) => {
    settle(response.request());
  });
  page.on('requestfailed', settle);

  return { stats: () => ({ peak, started }) };
}

test('10 张里 1 张坏图，另外 9 张各自成功，坏的那张给出中文原因和重试入口', async ({ page }) => {
  // 180 秒：一张照片要过 sharp 的元数据解析、一次完整解码和两张派生图，10 张串起来并不平凡。
  // 用夹具里最小的真实照片（合计约 130 KB）而不是接近 25 MiB 上限的大文件：本条验收的是
  // 「单张失败不拖垮整批」这条语义，不是吞吐；压测是另一件事，不该混进同一个用例。
  test.setTimeout(180_000);

  const place = await createPlace(page, '批量好坏岛');
  const uploadPath = `/api/places/${place.id}/photos`;
  const counter = trackBrowserUploads(page, uploadPath);

  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);
  await queueFiles(page, [...GOOD_FILES, BAD_FILE]);
  await acceptExifConsent(page);

  await page.getByTestId('upload-description').fill('一次十张，只有最后一张是坏的');
  await page.getByTestId('upload-submit').click();

  const summary = page.getByTestId('upload-summary');
  await expect(summary).toContainText('9 张成功', { timeout: 150_000 });
  await expect(summary).toContainText('1 张失败');

  // 十个文件都真的发出去了（坏图不会被前端偷偷丢掉，那正是要验证的部分）。
  expect(counter.stats().started).toBe(10);

  // 失败原因必须是人能看懂的中文，而不是直接甩一个机器错误码给用户。
  const error = page.locator('[data-testid^="upload-error-"]');
  await expect(error).toHaveCount(1);
  const reason = (await error.innerText()).replace(/\s+/g, ' ').trim();
  expect(reason).toMatch(/损坏|无法解析|不完整|不支持/);
  expect(reason).not.toMatch(/INVALID_IMAGE|UNSUPPORTED_MEDIA_TYPE|PHOTO_TOO_LARGE|BAD_REQUEST/);
  await expect(error.getByRole('button', { name: '重试这一张' })).toBeVisible();

  // 服务端只有 9 条 Photo 行：被拒绝的文件没有留下半成品记录。
  const listing = await (await page.request.get(`/api/places/${place.id}/photos?limit=50`)).json();
  expect(listing.items).toHaveLength(9);
  expect(listing.total).toBe(9);

  // 成功的那 9 张字节一致：抽两张把下载回来的原件与 fixture 逐字节比。
  // 只抽样两张而不是全部 9 张，是因为这里要证明的是「存档没被重编码」这个不变量，
  // 一旦成立对每一张都成立；全量比对会让用例时间翻倍却不会增加结论强度。
  for (const file of BYTE_CHECK_FILES) {
    const title = file.replace(/\.[^.]+$/, '');
    const item = (listing.items as Array<{ id: string; title: string }>).find(
      (entry) => entry.title === title,
    );
    expect(item, `${file} 应当出现在榜单里`).toBeDefined();
    if (item === undefined) continue;

    const expected = await fs.readFile(path.join(FIXTURES, file));
    const download = await page.request.get(`/api/photos/${item.id}/download`);
    expect(download.status()).toBe(200);
    const served = await download.body();

    expect(createHash('sha256').update(served).digest('hex')).toBe(
      createHash('sha256').update(expected).digest('hex'),
    );
    expect(served.equals(expected), `${file} 的原件与上传的字节不一致`).toBe(true);
    expect(download.headers()['content-length']).toBe(String(expected.byteLength));
  }

  // UP-09 的另一半：重试只重发失败的那一张，成功的那 9 张不会被重复上传。
  const before = counter.stats().started;
  await page.getByTestId('upload-rows').getByRole('button', { name: '重试这一张' }).click();
  await expect
    .poll(() => counter.stats().started, { timeout: 30_000, message: '重试没有发出新的请求' })
    .toBe(before + 1);
  await expect(summary).toContainText('9 张成功');

  // 重试后仍是 9 条：幂等键相同，服务端没有因此多存一份原件或多建一行。
  await expect
    .poll(
      async () => {
        const after = (await (
          await page.request.get(`/api/places/${place.id}/photos?limit=50`)
        ).json()) as {
          items: unknown[];
        };
        return after.items.length;
      },
      { timeout: 30_000 },
    )
    .toBe(9);
});

test('一次提交 10 张时，同时在途的上传请求不超过服务端下发的并发上限', async ({ page }) => {
  test.setTimeout(180_000);

  // 夹具里只有 9 张合法照片，第 10 张用 landscape.jpg 的字节换个文件名写到临时目录顶上去。
  // 这不是凑数：服务端按 idempotencyKey 而不是按内容去重，所以它是一条独立记录，
  // 而内容寻址的原件在磁盘上仍然只有一份（ADR-015）——顺带把这条语义也钉住。
  // 不落进 tests/fixtures 是为了不污染 fixture 清单（photo-upload.spec.ts 会逐个校验其 sha256）。
  // os.tmpdir(), not process.env.TEMP: TEMP is a Windows variable, and on
  // Linux it is undefined -- so the path came out relative, the helper below
  // then treated it as a fixture name and looked for it under tests/fixtures,
  // where it had never been written. The file did not exist, and the case
  // failed on every Linux runner.
  const duplicate = path.join(os.tmpdir(), `isle-duplicate-${process.pid}-${Date.now()}.jpg`);
  await fs.copyFile(path.join(FIXTURES, 'landscape.jpg'), duplicate);

  const place = await createPlace(page, '批量并发岛');
  const counter = trackBrowserUploads(page, `/api/places/${place.id}/photos`);

  try {
    await page.goto(`/places/${place.slug}/upload`);
    await waitForHydration(page);

    // 并发上限是服务端配置下发的，不在测试代码里写死。先确认页面上展示的就是 2
    // （MAX_CONCURRENT_UPLOADS_PER_CLIENT 的合同默认值），再拿它当断言基准。
    await expect(page.getByTestId('upload-form').locator('.form-bottom p')).toContainText(
      '同时上传 2 张',
    );

    await queueFiles(page, [...GOOD_FILES, duplicate]);
    await acceptExifConsent(page);
    await page.getByTestId('upload-submit').click();

    await expect(page.getByTestId('upload-summary')).toContainText('10 张成功', {
      timeout: 150_000,
    });

    const { peak, started } = counter.stats();
    expect(started, '10 个文件应当各发一次上传请求').toBe(10);

    // UP-05：并发限制必须可证明。
    expect(peak, `同时在途的上传请求达到了 ${peak} 个`).toBeLessThanOrEqual(2);
    // 反向断言：峰值不能是 0 或 1，否则说明计数器根本没看到并发，用例就是空转。
    expect(peak, '计数器没有观察到并发，用例失去意义').toBeGreaterThanOrEqual(2);

    // 限流不是为了少传照片：服务端最终确实拿到了 10 张 READY。
    const listing = await (
      await page.request.get(`/api/places/${place.id}/photos?limit=50`)
    ).json();
    expect(listing.items).toHaveLength(10);
    expect(listing.total).toBe(10);

    // 同一份字节传了两次，两条记录各自取回的原件都仍然是原始字节——没有被合并，也没有被重编码。
    const landscapeBytes = await fs.readFile(path.join(FIXTURES, 'landscape.jpg'));
    const duplicateTitle = path.basename(duplicate, path.extname(duplicate));
    const sameBytes = (listing.items as Array<{ title: string; id: string }>).filter(
      (item) => item.title === 'landscape' || item.title === duplicateTitle,
    );
    expect(sameBytes, '两次上传同一份字节应当产生两条独立记录').toHaveLength(2);
    for (const item of sameBytes) {
      const original = await page.request.get(`/api/photos/${item.id}/original`);
      expect(original.status()).toBe(200);
      expect((await original.body()).equals(landscapeBytes)).toBe(true);
    }
  } finally {
    await fs.rm(duplicate, { force: true });
  }
});
