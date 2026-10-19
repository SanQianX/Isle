import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * 重启后的持久化（MASTER_PLAN Phase 02「添加新地点后重启服务不丢失」与
 * Phase 03「测试夹具上传、重启后仍在」两条验收项）。
 *
 * 为什么必须由测试自己拉进程：Playwright 的 webServer 由 harness
 * （scripts/run-e2e-isolated.mjs）托管，测试代码拿不到它的进程句柄，也就无法
 * 真正重启它；退而求其次去重启 harness 的进程会连带掀翻同一次运行里的其它
 * 用例。而「重启后不丢」这件事，**只有杀掉真实进程、再用同一个数据库与媒体
 * 目录起一个全新进程**才能证明——复用同一个进程等于什么都没验证。
 *
 * 隔离：数据库、媒体、临时目录全部落在 os.tmpdir() 下由 mkdtemp 现建的目录里。
 * 绝不使用 var/local（用户自己的照片就在那里，测试没有任何理由碰它），也绝不
 * 复用 harness 的沙箱（否则重启验证会和并发跑其它用例的写操作互相干扰）。
 */

const REPO_ROOT = process.cwd();
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures');
const STANDALONE_DIR = path.join(REPO_ROOT, '.next', 'standalone');
const STANDALONE_SERVER = path.join(STANDALONE_DIR, 'server.js');

/** 冷启动 + 迁移 + sharp 出两张预览都要时间，但没有一条路径值得用固定 sleep 等待。 */
const BOOT_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;
const PORT_FREE_TIMEOUT_MS = 15_000;

type ServerHandle = {
  child: ChildProcess;
  baseUrl: string;
  pid: number | undefined;
  readLog: () => string;
  hasExited: () => boolean;
};

let sandbox: string | null = null;
let serverEnv: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
let server: ServerHandle | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 给 Promise 加一个截止时间，同时清掉定时器，免得它把 worker 的事件循环吊住。 */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 在系统临时目录下现建一个一次性沙箱。
 *
 * mkdtemp 保证唯一性，建好之后还要再断言一次位置：万一哪天有人把 TEMP 指到了
 * 真实部署目录上，这个用例必须当场退出，而不是愉快地把测试数据写进去。
 */
async function createSandbox(): Promise<string> {
  const tempRoot = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(tempRoot, 'isle-restart-'));
  const resolved = path.resolve(dir);

  if (!resolved.startsWith(tempRoot + path.sep)) {
    throw new Error(`隔离目录 ${resolved} 不在系统临时目录 ${tempRoot} 内，拒绝继续`);
  }
  for (const forbidden of [path.join(REPO_ROOT, 'var'), path.join(REPO_ROOT, 'media')]) {
    if (resolved.startsWith(path.resolve(forbidden))) {
      throw new Error(`隔离目录 ${resolved} 与仓库内的 ${forbidden} 冲突，拒绝继续`);
    }
  }

  for (const child of ['db', 'media', 'tmp']) {
    await fs.mkdir(path.join(resolved, child), { recursive: true });
  }
  return resolved;
}

/** 向操作系统要一个空闲端口，然后原样交给子进程。 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('无法获取可用端口')));
        return;
      }
      const { port: found } = address;
      probe.close(() => resolve(found));
    });
  });
}

/**
 * 在隔离环境变量下执行项目自带的 CLI。
 *
 * 这里用 `process.execPath` 直接跑 node_modules 里包自己的入口，而不是过一层
 * shell：Windows 上 npx 是 .cmd 批处理，只能靠 `shell: true` 启动，而 shell 会
 * 重新解析命令行——仓库路径 "Server Project" 里带空格，正是参数会被截断的场景。
 * 直接交给 node 就彻底绕开了 shell。函数名沿用 packageName 以表明入参是路径。
 */
function runProjectCli(
  packageEntry: string,
  args: string[],
  label: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [packageEntry, ...args], {
      cwd: REPO_ROOT,
      env: serverEnv,
      stdio: 'pipe',
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${label} 超过 ${timeoutMs}ms 仍未结束\n${output.slice(-2000)}`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${label} 退出码 ${code}\n${output.slice(-2000)}`));
    });
  });
}

/**
 * 拉起 `.next/standalone/server.js` —— 和 systemd 在生产上跑的是同一个产物，
 * 所以被验证的重启路径就是真实部署的路径。
 */
function startServer(port: number): ServerHandle {
  const child = spawn(process.execPath, [STANDALONE_SERVER], {
    cwd: STANDALONE_DIR,
    env: serverEnv,
    stdio: 'pipe',
  });

  let log = '';
  const append = (chunk: Buffer) => {
    log = (log + String(chunk)).slice(-8000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    pid: child.pid,
    readLog: () => log,
    hasExited: () => child.exitCode !== null || child.signalCode !== null,
  };
}

/**
 * 轮询 `/api/health` 直到返回 200，间隔带退避。
 *
 * 固定 sleep 在 Windows 冷启动上要么等不够、要么白白浪费好几秒。轮询还顺带
 * 带来一个好处：子进程一死就立刻能报「进程已退出」，而不是丢给调用方一个
 * 含义不明的超时。
 */
async function waitForHealthy(handle: ServerHandle): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let backoff = 100;
  let lastReason = '尚未尝试';

  while (Date.now() < deadline) {
    if (handle.hasExited()) {
      throw new Error(
        `服务进程在健康检查通过前就退出了（code=${handle.child.exitCode ?? 'null'}）\n${handle.readLog()}`,
      );
    }
    try {
      const response = await fetch(`${handle.baseUrl}/api/health`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.status === 200) return;
      lastReason = `HTTP ${response.status}：${(await response.text()).slice(0, 300)}`;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 1_000);
  }
  throw new Error(`${BOOT_TIMEOUT_MS}ms 内服务始终不健康：${lastReason}\n${handle.readLog()}`);
}

/** Windows 上没有 SIGTERM，走不到优雅退出这条路时按进程树强杀。 */
function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return Promise.resolve();
  if (process.platform !== 'win32') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => resolve());
    killer.once('exit', () => resolve());
  });
}

/** 停掉子进程并**证明**它真的没了——进程还在但端口没释放的话，后面的重启就白测了。 */
async function stopServer(handle: ServerHandle | null): Promise<void> {
  if (handle === null || handle.hasExited()) return;

  const exited = new Promise<void>((resolve) => handle.child.once('exit', () => resolve()));
  handle.child.kill('SIGTERM');

  const graceful = await withDeadline(exited, STOP_TIMEOUT_MS);
  if (graceful === undefined) {
    await killTree(handle.child.pid);
    await withDeadline(exited, STOP_TIMEOUT_MS);
  }
}

async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

/** 第二次启动之前端口必须已经交还，否则这次重启什么也没验证到。 */
async function waitForPortReleased(port: number): Promise<void> {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await isPortListening(port)) === false) return;
    await sleep(150);
  }
  throw new Error(`端口 ${port} 在 ${PORT_FREE_TIMEOUT_MS}ms 内仍未释放`);
}

async function removeSandbox(dir: string): Promise<void> {
  // Windows 上必须重试：服务进程触发 exit 事件之后，SQLite 文件可能还被占着
  // 几百毫秒，此时直接 rm 会撞上 EPERM。
  await fs
    .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    .catch(() => undefined);
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} 返回 ${response.status}：${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}

type PlaceRef = { id: string; slug: string; name: string };
type PhotoRef = { id: string; sha256: string };

test.beforeAll(async () => {
  // 迁移 + 种子 + 冷启动都不该被默认的 90s 卡住，但也不能无限等。
  test.setTimeout(150_000);

  sandbox = await createSandbox();
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  serverEnv = {
    ...process.env,
    NODE_ENV: 'production',
    ISLE_E2E: '1',
    DATABASE_URL: `file:${path.join(sandbox, 'db', 'restart.db').replace(/\\/g, '/')}`,
    MEDIA_ROOT: path.join(sandbox, 'media'),
    UPLOAD_TMP_DIR: path.join(sandbox, 'tmp'),
    PUBLIC_BASE_URL: baseUrl,
    NEXT_PUBLIC_SITE_URL: baseUrl,
    SITE_ACCESS_MODE: 'friends-only',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    NEXT_TELEMETRY_DISABLED: '1',
  };

  await runProjectCli(
    path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js'),
    ['migrate', 'deploy'],
    'prisma migrate deploy',
    90_000,
  );
  // 只种默认地点，不加 --e2e：被上传的照片必须由本用例走真实 API 送上去，
  // 预先塞进库里的种子照片会让「上传后仍在」这件事变得无法证伪。
  await runProjectCli(
    path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    ['scripts/seed.ts'],
    'scripts/seed.ts',
    90_000,
  );

  server = startServer(port);
  await waitForHealthy(server);
});

test.afterAll(async () => {
  // 清理绝不能因为前面的断言失败而被跳过：漏掉的就是一个还在监听端口的
  // 孤儿进程和一个留在磁盘上的沙箱目录。
  test.setTimeout(60_000);
  await stopServer(server);
  server = null;
  if (sandbox !== null) await removeSandbox(sandbox);
  sandbox = null;
});

test('照片、票数和新地点在服务重启后全部还在，原件字节仍然一致', async () => {
  // 两次冷启动 + 一次 25 MiB 以内的真实上传（sharp 出两张预览）都要时间。
  test.setTimeout(150_000);
  if (server === null || sandbox === null) throw new Error('测试服务未启动');

  const baseUrl = server.baseUrl;
  const cookie = await mintVisitorCookie(baseUrl);

  const seeded = (
    await readJson<{ places: PlaceRef[] }>(
      await fetch(`${baseUrl}/api/places`, { headers: { cookie } }),
      'GET /api/places',
    )
  ).places.find((place) => place.slug === 'guishan-island');
  if (seeded === undefined) throw new Error('种子地点 guishan-island 缺失');

  const fixturePath = path.join(FIXTURES, 'landscape.jpg');
  const fixtureBytes = await fs.readFile(fixturePath);
  const fixtureSha = createHash('sha256').update(fixtureBytes).digest('hex');

  const photo = await uploadPhoto(baseUrl, cookie, seeded.id, 'landscape.jpg', fixtureBytes);
  expect(photo.sha256).toBe(fixtureSha);

  // 「添加新地点」：第二个地点同样是重启后必须还在的东西。
  const created = await readJson<{ place: PlaceRef }>(
    await fetch(`${baseUrl}/api/places`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `重启测试岛 ${Date.now()}`, region: '测试地区' }),
    }),
    'POST /api/places',
  );
  const added = created.place;

  const vote = await readJson<{ upCount: number; score: number }>(
    await fetch(`${baseUrl}/api/photos/${photo.id}/vote`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 1 }),
    }),
    'PUT vote',
  );
  expect(vote.upCount).toBe(1);
  expect(vote.score).toBe(1);

  // ---- 真正重启 -------------------------------------------------------
  const first = server;
  await stopServer(first);
  expect(first.hasExited(), '第一个服务进程必须已经退出').toBe(true);
  await waitForPortReleased(Number(serverEnv.PORT));

  // 同一个数据库文件、同一个媒体目录，但必须是**另一个进程**：端口已经释放过，
  // 旧 PID 也已经退出，所以下面这些响应只可能来自新起的这一个进程。
  server = startServer(Number(serverEnv.PORT));
  await waitForHealthy(server);
  expect(server.pid, '重启后必须是一个全新的进程').not.toBe(first.pid);

  // ---- 重启后的断言 ---------------------------------------------------
  const places = (
    await readJson<{ places: PlaceRef[] }>(
      await fetch(`${server.baseUrl}/api/places`, { headers: { cookie } }),
      'GET /api/places (after restart)',
    )
  ).places;
  expect(places.map((place) => place.id)).toContain(seeded.id);
  expect(places.map((place) => place.id)).toContain(added.id);
  expect(places.map((place) => place.slug)).toContain(added.slug);

  const listed = await readJson<{
    items: Array<{
      id: string;
      title: string;
      upCount: number;
      downCount: number;
      score: number;
      currentVisitorVote: number;
    }>;
  }>(
    await fetch(`${server.baseUrl}/api/places/${seeded.id}/photos`, { headers: { cookie } }),
    'GET leaderboard (after restart)',
  );
  expect(listed.items).toHaveLength(1);

  const item = listed.items[0];
  if (item === undefined) throw new Error('重启后榜单为空');
  expect(item.id).toBe(photo.id);
  expect(item.title).toBe('重启前的照片');
  expect(item.upCount).toBe(1);
  expect(item.downCount).toBe(0);
  expect(item.score).toBe(1);
  // 复用的是同一个访客 cookie，所以这张票仍然记在我们头上。
  expect(item.currentVisitorVote).toBe(1);

  // 逐字节相等，而不只是「页面还能显示出点什么」。原件永不改写的意义，
  // 同样包括它在重启之后依然一字节不差。
  const original = await fetch(`${server.baseUrl}/api/photos/${photo.id}/original`, {
    headers: { cookie },
  });
  expect(original.status).toBe(200);
  const served = Buffer.from(await original.arrayBuffer());
  expect(createHash('sha256').update(served).digest('hex')).toBe(fixtureSha);
  expect(served.equals(fixtureBytes)).toBe(true);
});

/** 走真实 API 领取一个访客 cookie，和浏览器拿到的是同一种东西。 */
async function mintVisitorCookie(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/visitor`);
  const raw = response.headers.getSetCookie()[0] ?? '';
  const cookie = raw.split(';')[0] ?? '';
  if (cookie === '') throw new Error('服务端没有签发访客 cookie');
  return cookie;
}

async function uploadPhoto(
  baseUrl: string,
  cookie: string,
  placeId: string,
  fileName: string,
  bytes: Buffer,
): Promise<PhotoRef> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }), fileName);
  form.append('title', '重启前的照片');
  form.append('description', '重启验证');
  form.append('idempotencyKey', `restart-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const body = await readJson<{ photo: PhotoRef }>(
    await fetch(`${baseUrl}/api/places/${placeId}/photos`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    }),
    'POST photos',
  );
  return body.photo;
}
