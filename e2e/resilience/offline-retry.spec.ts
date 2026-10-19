import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForHydration } from '../support';

/**
 * 断网时的逐图失败与重试（MASTER_PLAN Phase 09 验收项「断网有逐图失败重试」）。
 *
 * 故障注入方式：`page.context().setOffline(true)`。这是**浏览器网络层**的故障
 * 注入——请求真的发不出去、真的抛 TypeError: Failed to fetch，和用户在船上、
 * 在电梯里遇到的情况完全一致。
 *
 * 为什么不用 page.route()：拦截本站 API 再伪造成功，等于把要验证的行为换成了
 * 自己写的桩；本项目明令禁止这种做法。setOffline 不碰任何一行产品代码，只是让
 * 真实的 fetch 失败，所以「失败原因」「逐行状态」「重试按钮」全都是产品自己的
 * 反应，而不是测试安排出来的。
 *
 * 一个容易踩的坑：setOffline 只作用于**浏览器上下文**，`page.request` 走的是
 * Playwright 自己的 Node 网络栈，完全不受影响。所以服务端校验放在恢复网络之后
 * 做——放在之前也能通，但那会让人误以为「服务端也断网了」，掩盖掉一个真实的
 * 认知偏差。
 */

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

/** 文件名 → 上传行默认标题（UploadForm 用去掉扩展名的文件名做默认标题）。 */
const BATCH = [
  { file: 'landscape.jpg', title: 'landscape' },
  { file: 'portrait.jpg', title: 'portrait' },
  { file: 'square.png', title: 'square' },
];

async function createPlace(page: Page, label: string): Promise<{ id: string; slug: string }> {
  const name = `${label} ${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  // 用相对路径：baseURL 来自 E2E_BASE_URL，这样换端口时不需要改测试代码。
  const response = await page.request.post('/api/places', {
    data: { name, region: '测试地区' },
  });
  expect(response.status()).toBe(201);
  const body = (await response.json()) as { place: { id: string; slug: string } };
  return body.place;
}

function rows(page: Page): Locator {
  return page.getByTestId('upload-rows').locator('.upload-row');
}

/** 失败原因文本。整块区域里还嵌着「重试这一张」按钮，取文案时必须把它摘掉。 */
async function rowError(row: Locator): Promise<string> {
  const raw = await row.locator('.upload-error').innerText();
  return raw.replace('重试这一张', '').trim();
}

test.afterEach(async ({ context }) => {
  // 必须复位：context 是每个用例新建的，但断言失败时清理仍要跑，
  // 否则这个浏览器上下文会在余下的生命周期里一直处于断网状态。
  await context.setOffline(false);
});

test('断网时逐张失败，恢复网络后只重试的那一张变成功', async ({ page }) => {
  const place = await createPlace(page, '断网重试岛');
  await page.goto(`/places/${place.slug}/upload`);
  await waitForHydration(page);

  await page
    .getByTestId('file-input')
    .setInputFiles(BATCH.map((entry) => path.join(FIXTURES, entry.file)));
  await expect(rows(page)).toHaveCount(BATCH.length);

  const consent = page.getByTestId('exif-consent-input');
  if ((await consent.isChecked()) === false) await consent.check();
  await expect(page.getByTestId('upload-submit')).toBeEnabled();

  // ---- 故障注入：断网后提交 ------------------------------------------
  await page.context().setOffline(true);
  await page.getByTestId('upload-submit').click();

  const summary = page.getByTestId('upload-summary');
  await expect(summary).toContainText('0 张成功', { timeout: 45_000 });
  await expect(summary).toContainText(`${BATCH.length} 张失败`);

  for (let index = 0; index < BATCH.length; index += 1) {
    const row = rows(page).nth(index);
    await expect(row.locator('.upload-status')).toHaveText('失败');

    const reason = await rowError(row);
    // 给的是人话而不是 HTTP 状态码或英文异常：断网时用户看到的就是这句话。
    expect(reason).not.toBe('');
    expect(reason).toMatch(/[一-鿿]/);
    expect(reason).not.toMatch(/上传失败（\d+）/);

    // 逐图重试的前提是每一行都有自己的按钮。
    await expect(row.getByRole('button', { name: '重试这一张' })).toBeVisible();
  }

  // 断网期间一张都没进去——失败不能靠「服务端其实收到了」蒙混过关。
  const duringOutage = await (await page.request.get(`/api/places/${place.id}/photos`)).json();
  expect(duringOutage.items).toHaveLength(0);

  // ---- 恢复网络，只重试其中一张 ---------------------------------------
  await page.context().setOffline(false);

  const retried = rows(page).nth(0);
  await retried.getByRole('button', { name: '重试这一张' }).click();

  await expect(retried.locator('.upload-status')).toHaveText('已上传', { timeout: 45_000 });
  await expect(summary).toContainText('1 张成功');
  await expect(summary).toContainText(`${BATCH.length - 1} 张失败`);

  // 单张重试不得牵动其它行：它们既没有自动成功，也仍然留着重试入口。
  for (let index = 1; index < BATCH.length; index += 1) {
    const row = rows(page).nth(index);
    await expect(row.locator('.upload-status')).toHaveText('失败');
    await expect(row.getByRole('button', { name: '重试这一张' })).toBeVisible();
  }
  await expect(retried.getByRole('button', { name: '重试这一张' })).toHaveCount(0);

  // ---- 剩下的失败行继续逐张重试，直到批次收敛 --------------------------
  for (let index = 1; index < BATCH.length; index += 1) {
    const row = rows(page).nth(index);
    await row.getByRole('button', { name: '重试这一张' }).click();
    await expect(row.locator('.upload-status')).toHaveText('已上传', { timeout: 45_000 });
  }

  await expect(summary).toContainText(`${BATCH.length} 张成功`, { timeout: 15_000 });
  await expect(summary).not.toContainText('张失败');

  // ---- 服务端核对 ------------------------------------------------------
  // page.request 不受 setOffline 影响，所以这一步能在恢复网络之后照常完成；
  // 它查的是真实数据库，而不是页面自己的乐观状态。
  const listed = (await (await page.request.get(`/api/places/${place.id}/photos`)).json()) as {
    items: Array<{ id: string; title: string }>;
  };
  expect(listed.items).toHaveLength(BATCH.length);

  const byTitle = new Map(listed.items.map((item) => [item.title, item.id]));
  for (const entry of BATCH) {
    const photoId = byTitle.get(entry.title);
    if (photoId === undefined) throw new Error(`榜单里找不到 ${entry.title}`);

    const original = await page.request.get(`/api/photos/${photoId}/original`);
    expect(original.status(), entry.file).toBe(200);
    const served = await original.body();
    const expected = await fs.readFile(path.join(FIXTURES, entry.file));
    // 字节一致才算真的上传成功：页面说「已上传」而磁盘上是别的内容，是数据丢失。
    expect(served.byteLength, entry.file).toBe(expected.byteLength);
    expect(served.equals(expected), entry.file).toBe(true);
  }
});
