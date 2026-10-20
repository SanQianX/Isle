import path from 'node:path';
import { expect, test } from '@playwright/test';
import { waitForHydration } from '../support';
import {
  createSandbox,
  FIXTURES,
  findFreePort,
  migrateSandbox,
  readJson,
  removeSandbox,
  sandboxEnv,
  seedDefaultPlaceOnly,
  startServer,
  stopServer,
  waitForHealthy,
  type ServerHandle,
} from '../isolated-server';

/**
 * 维护模式下的真实行为（DEPLOY_RUNBOOK §8「暂停写入后备份」）。
 *
 * 备份脚本一直以为站点有一个可以暂停写入的接口，其实没有：它 POST 到一个只有
 * GET 的路由，带一个没有实现的参数，还用 `|| true` 吞掉了失败。于是备份期间
 * 写入照旧发生——而媒体目录的复制不是原子的，一张在备份窗口里传上去的照片会让
 * 快照出现「有行无文件」。
 *
 * 现在暂停是真的了，于是必须钉住它在真实服务上的行为：
 *   1. 暂停时写入失败，且是 503 而不是 500；
 *   2. 读取照常工作——维护窗口只该让数据稳定；
 *   3. 界面上给出**看得见**的反馈，而不是只让读屏软件听见（FRONTEND_UX §3.3
 *      要求投票按钮有「成功/错误反馈」）；
 *   4. 恢复之后一切照旧。
 *
 * **这个用例必须自己拉服务。** 暂停是整个进程级的状态，而 harness 用一个服务
 * 同时供五个浏览器项目使用：在这里暂停一次，同一时刻正在跑的其它用例的上传
 * 全部会收到 503。所以它像「重启持久化」那条用例一样，自己在临时目录里起一个
 * 隔离的服务——同一份 `.next/standalone` 产物，和 systemd 跑的是同一个。
 */

let sandbox: string | null = null;
let server: ServerHandle | null = null;

test.beforeAll(async () => {
  // 迁移 + 冷启动都要时间。
  test.setTimeout(180_000);

  sandbox = await createSandbox('isle-maintenance-');
  const port = await findFreePort();
  const env = sandboxEnv(sandbox, port);

  await migrateSandbox(env);
  await seedDefaultPlaceOnly(env);

  server = startServer(port, env);
  await waitForHealthy(server);
});

test.afterAll(async () => {
  // 清理不能因为前面的断言失败而被跳过：漏掉的就是一个还在监听端口的孤儿
  // 进程和一个留在磁盘上的沙箱目录。
  test.setTimeout(60_000);
  await stopServer(server);
  server = null;
  if (sandbox !== null) await removeSandbox(sandbox);
  sandbox = null;
});

/** Pause or resume writes, as the backup script does. */
async function setPause(paused: 0 | 1): Promise<void> {
  const baseUrl = server?.baseUrl ?? '';
  const response = await fetch(`${baseUrl}/api/health?pause-writes=${paused}`, {
    method: 'POST',
  });
  expect(response.status, '维护模式开关没有生效').toBe(200);
  const body = (await response.json()) as { writesPaused: boolean };
  expect(body.writesPaused).toBe(paused === 1);
}

/**
 * Upload one photograph.
 *
 * The idempotency key is not optional -- the server refuses a duplicate
 * without one, and a retry after a timeout has to be safe.
 */
async function uploadOne(title: string, expectedStatus = 201): Promise<Response> {
  const baseUrl = server?.baseUrl ?? '';
  const bytes = await (
    await import('node:fs/promises')
  ).readFile(path.join(FIXTURES, 'landscape.jpg'));
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), 'a.jpg');
  form.append('title', title);
  form.append('idempotencyKey', `maintenance-${title}-${Math.random()}`);
  const response = await fetch(`${baseUrl}/api/places/guishan-island/photos`, {
    method: 'POST',
    body: form,
  });
  if (response.status !== expectedStatus) {
    throw new Error(
      `上传 ${title} 返回 ${response.status}（期望 ${expectedStatus}）：${(await response.text()).slice(0, 400)}`,
    );
  }
  return response;
}

test('暂停写入时，写入被明确拒绝，而读取照常', async () => {
  const baseUrl = server?.baseUrl ?? '';

  // A photograph to vote on and to upload.
  const uploaded = await uploadOne('维护岛');
  const created = (await uploaded.json()) as { photo: { id: string } };

  await setPause(1);

  // 503, not 500: this is a temporary condition, and a client that sees 500
  // will not retry.
  const vote = await fetch(`${baseUrl}/api/photos/${created.photo.id}/vote`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 1 }),
  });
  expect(vote.status).toBe(503);
  const payload = (await vote.json()) as { error: { code: string; message: string } };
  expect(payload.error.code).toBe('SERVICE_UNAVAILABLE');
  expect(payload.error.message).toMatch(/[一-鿿]/);

  await uploadOne('维护期间的第二张', 503);

  // Reading still works. A maintenance window that took the site down would
  // turn a two-minute backup into an outage.
  const stillReadable = await fetch(`${baseUrl}/api/places/guishan-island/photos`);
  expect(stillReadable.status).toBe(200);

  await setPause(0);
});

test('暂停期间投票失败，界面上看得见', async ({ page }) => {
  const baseUrl = server?.baseUrl ?? '';
  const uploaded = await uploadOne('看得见的失败');
  const created = (await uploaded.json()) as { photo: { id: string } };
  const photoId = created.photo.id;

  await setPause(1);

  // The browser navigates to the isolated server by absolute URL, so each
  // browser project exercises the real interface on its own engine.
  await page.goto(`${baseUrl}/places/guishan-island/ranking`);
  await waitForHydration(page);

  const up = page.getByTestId(`vote-up-${photoId}`);
  await expect(up).toBeVisible({ timeout: 30_000 });
  await up.click();

  // The failure has to be *visible*. It used to live only in a screen-reader
  // live region, so a sighted user saw the score snap back and nothing else.
  const error = page.getByTestId(`vote-error-${photoId}`);
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toContainText(/维护|不可用|失败/);

  await setPause(0);
});

test('恢复写入之后，投票立刻重新生效', async () => {
  const baseUrl = server?.baseUrl ?? '';
  const uploaded = await uploadOne('恢复之后');
  const created = (await uploaded.json()) as { photo: { id: string } };
  const photoId = created.photo.id;

  await setPause(1);
  const refused = await fetch(`${baseUrl}/api/photos/${photoId}/vote`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 1 }),
  });
  expect(refused.status).toBe(503);

  await setPause(0);
  const accepted = await fetch(`${baseUrl}/api/photos/${photoId}/vote`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: 1 }),
  });
  expect(accepted.status).toBe(200);
});

test('暂停不会留下任何写入的痕迹', async () => {
  const baseUrl = server?.baseUrl ?? '';
  const before = await readJson<{ total: number }>(
    await fetch(`${baseUrl}/api/places/guishan-island/photos?limit=100`),
    '榜单',
  );

  await setPause(1);
  await uploadOne('不该出现的照片', 503);
  await setPause(0);

  const after = await readJson<{ total: number }>(
    await fetch(`${baseUrl}/api/places/guishan-island/photos?limit=100`),
    '榜单',
  );
  expect(after.total).toBe(before.total);
});
