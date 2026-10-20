import { expect, test, type Page } from '@playwright/test';
import { waitForHydration } from '../support';

/**
 * 维护模式下的真实行为（DEPLOY_RUNBOOK §8「暂停写入后备份」）。
 *
 * 备份脚本一直以为站点有一个可以暂停写入的接口，其实没有：它 POST 到一个只有
 * GET 的路由，带一个没有实现的参数，还用 `|| true` 吞掉了失败。于是备份期间
 * 写入照旧发生——而媒体目录的复制不是原子的，一张在备份窗口里传上去的照片会让
 * 快照出现「有行无文件」。
 *
 * 现在暂停是真的了，于是必须钉住它在真实服务上的行为：
 *   1. 暂停时写入失败，且是 503；
 *   2. 读取照常工作——维护窗口只该让数据稳定；
 *   3. 界面给出**看得见**的反馈，而不是只让读屏软件听见（FRONTEND_UX §3.3
 *      要求投票按钮有「成功/错误反馈」）；
 *   4. 恢复之后一切照旧。
 *
 * 这个用例会和整套 E2E 共用同一个服务，所以暂停必须在每个用例结束时恢复，
 * 否则后面所有用例都会写不进去。
 */

const RANKING = '/places/guishan-island/ranking';

/** Pause or resume writes, as the backup script does. */
async function setPause(page: Page, paused: 0 | 1): Promise<void> {
  const response = await page.request.post(`/api/health?pause-writes=${paused}`);
  expect(response.status(), '维护模式开关没有生效').toBe(200);
  const body = (await response.json()) as { writesPaused: boolean };
  expect(body.writesPaused).toBe(paused === 1);
}

test.afterEach(async ({ page }) => {
  // Always put the site back. A test that leaves writes paused would take
  // every later test in the run down with it.
  await page.request.post('/api/health?pause-writes=0').catch(() => undefined);
});

test('暂停写入时，投票被明确拒绝，而浏览照常', async ({ page }) => {
  await page.goto(RANKING);
  await waitForHydration(page);

  const list = await page.request.get('/api/places/guishan-island/photos');
  const body = (await list.json()) as { items: Array<{ id: string }> };
  const photoId = body.items[0]?.id;
  expect(photoId).toBeTruthy();

  await setPause(page, 1);

  // The API says 503, not 500: this is a temporary condition, and a client
  // that sees 500 will not retry.
  const vote = await page.request.put(`/api/photos/${photoId ?? ''}/vote`, {
    data: { value: 1 },
  });
  expect(vote.status()).toBe(503);
  const payload = (await vote.json()) as { error: { code: string; message: string } };
  expect(payload.error.code).toBe('SERVICE_UNAVAILABLE');
  expect(payload.error.message).toMatch(/[一-鿿]/);

  // Reading still works. A maintenance window that took the site down would
  // turn a two-minute backup into an outage.
  const stillReadable = await page.request.get('/api/places/guishan-island/photos');
  expect(stillReadable.status()).toBe(200);

  await setPause(page, 0);
});

test('暂停期间投票失败，界面上看得见', async ({ page }) => {
  await page.goto(RANKING);
  await waitForHydration(page);

  const list = await page.request.get('/api/places/guishan-island/photos');
  const body = (await list.json()) as { items: Array<{ id: string }> };
  const photoId = body.items[0]?.id;
  expect(photoId).toBeTruthy();

  const up = page.getByTestId(`vote-up-${photoId ?? ''}`);
  await expect(up).toBeVisible();

  await setPause(page, 1);

  await up.click();

  // The failure has to be *visible*. It used to live only in a screen-reader
  // live region, so a sighted user saw the score snap back and nothing else.
  const error = page.getByTestId(`vote-error-${photoId ?? ''}`);
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText(/维护|不可用|失败/);

  // And the score is rolled back rather than left showing a vote that was
  // never recorded.
  const score = page.getByTestId(`photo-score-${photoId ?? ''}`);
  const after = await score.innerText();
  const before = await page.request
    .get('/api/places/guishan-island/photos')
    .then(async (response) => {
      const payload = (await response.json()) as {
        items: Array<{ id: string; score: number }>;
      };
      return payload.items.find((item) => item.id === photoId)?.score ?? 0;
    });
  expect(after.replace('+', '').trim()).toBe(String(before));

  await setPause(page, 0);
});

test('恢复写入之后，投票立刻重新生效', async ({ page }) => {
  await page.goto(RANKING);
  await waitForHydration(page);

  const list = await page.request.get('/api/places/guishan-island/photos');
  const body = (await list.json()) as { items: Array<{ id: string }> };
  const photoId = body.items[0]?.id;
  expect(photoId).toBeTruthy();

  await setPause(page, 1);
  const refused = await page.request.put(`/api/photos/${photoId ?? ''}/vote`, {
    data: { value: 1 },
  });
  expect(refused.status()).toBe(503);

  await setPause(page, 0);
  const accepted = await page.request.put(`/api/photos/${photoId ?? ''}/vote`, {
    data: { value: 1 },
  });
  expect(accepted.status()).toBe(200);
});
