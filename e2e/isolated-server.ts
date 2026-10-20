import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * A real server, in a real sandbox, that the test owns.
 *
 * Two e2e cases need this and cannot use the harness's shared webServer:
 *
 *   - the restart case, which has to kill the process and start a new one on
 *     the same database, and
 *   - the maintenance case, which pauses writes for the whole process. The
 *     harness serves every browser project from one server, so a pause there
 *     would refuse the uploads of every other test running at the same time.
 *
 * The server is the same artefact systemd runs in production --
 * `.next/standalone/server.js` -- so what is exercised here is the real
 * deployment path, not a stand-in.
 *
 * Isolation: the database, the media directory and the scratch directory all
 * live in a directory created under the OS temp directory. `var/local`, where
 * the owner's own photographs live, is never touched.
 */

export const REPO_ROOT = process.cwd();
export const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures');
export const STANDALONE_DIR = path.join(REPO_ROOT, '.next', 'standalone');
export const STANDALONE_SERVER = path.join(STANDALONE_DIR, 'server.js');

/** Booting a server means migrating, seeding and decoding a photograph. */
export const BOOT_TIMEOUT_MS = 60_000;
export const STOP_TIMEOUT_MS = 15_000;
export const PORT_FREE_TIMEOUT_MS = 15_000;

export type ServerHandle = {
  child: ChildProcess;
  baseUrl: string;
  pid: number | undefined;
  readLog: () => string;
  hasExited: () => boolean;
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Give a promise a deadline, and clear the timer so it cannot hold the worker open. */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
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
 * A throwaway directory under the OS temp directory.
 *
 * mkdtemp guarantees uniqueness, and the location is checked afterwards: if
 * TEMP were ever pointed at a real deployment directory, this must stop
 * rather than cheerfully write test data into it.
 */
export async function createSandbox(prefix: string): Promise<string> {
  const tempRoot = await fs.realpath(os.tmpdir());
  const dir = await fs.mkdtemp(path.join(tempRoot, prefix));
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

/** Ask the operating system for a free port and hand it to the child process. */
export function findFreePort(): Promise<number> {
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
 * Run one of the project's own CLIs under the sandbox environment.
 *
 * `process.execPath` runs the entry point directly instead of going through a
 * shell. On Windows `npx` is a .cmd shim that can only be started with
 * `shell: true`, and the shell re-splits the arguments -- which is exactly
 * where a repository path containing a space ("Server Project") breaks.
 */
export function runProjectCli(
  packageEntry: string,
  args: string[],
  label: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [packageEntry, ...args], {
      cwd: REPO_ROOT,
      env,
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

/** Start `.next/standalone/server.js` -- the same artefact systemd runs. */
export function startServer(port: number, env: NodeJS.ProcessEnv): ServerHandle {
  const child = spawn(process.execPath, [STANDALONE_SERVER], {
    cwd: STANDALONE_DIR,
    env,
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
 * Poll `/api/health` until it answers 200, with a backoff.
 *
 * A fixed sleep either waits too little on a cold Windows start or wastes
 * seconds every time. Polling also gives a better failure: a child that died
 * is reported as "the process exited", not as an opaque timeout.
 */
export async function waitForHealthy(handle: ServerHandle): Promise<void> {
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

/** Windows has no SIGTERM, so the process tree is killed when it will not go. */
export function killTree(pid: number | undefined): Promise<void> {
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

/** Stop the child process and *prove* it is gone. */
export async function stopServer(handle: ServerHandle | null): Promise<void> {
  if (handle === null || handle.hasExited()) return;

  const exited = new Promise<void>((resolve) => handle.child.once('exit', () => resolve()));
  handle.child.kill('SIGTERM');

  const graceful = await withDeadline(exited, STOP_TIMEOUT_MS);
  if (graceful === undefined) {
    await killTree(handle.child.pid);
    await withDeadline(exited, STOP_TIMEOUT_MS);
  }
}

export async function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

/** The port must be back before a second start, or the restart proved nothing. */
export async function waitForPortReleased(port: number): Promise<void> {
  const deadline = Date.now() + PORT_FREE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await isPortListening(port)) === false) return;
    await sleep(150);
  }
  throw new Error(`端口 ${port} 在 ${PORT_FREE_TIMEOUT_MS}ms 内仍未释放`);
}

export async function removeSandbox(dir: string): Promise<void> {
  // Windows needs the retry: after the process exits, the SQLite file can
  // still be held for a few hundred milliseconds, and an unlink that races it
  // fails with EPERM.
  await fs
    .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    .catch(() => undefined);
}

/** The environment an isolated server runs under. */
export function sandboxEnv(sandbox: string, port: number): NodeJS.ProcessEnv {
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    ...process.env,
    NODE_ENV: 'production',
    ISLE_E2E: '1',
    DATABASE_URL: `file:${path.join(sandbox, 'db', 'test.db').replace(/\\/g, '/')}`,
    MEDIA_ROOT: path.join(sandbox, 'media'),
    UPLOAD_TMP_DIR: path.join(sandbox, 'tmp'),
    PUBLIC_BASE_URL: baseUrl,
    NEXT_PUBLIC_SITE_URL: baseUrl,
    SITE_ACCESS_MODE: 'friends-only',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    NEXT_TELEMETRY_DISABLED: '1',
  };
}

/** Apply the migrations to the sandbox database. */
export async function migrateSandbox(env: NodeJS.ProcessEnv): Promise<void> {
  await runProjectCli(
    path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js'),
    ['migrate', 'deploy'],
    'prisma migrate deploy',
    90_000,
    env,
  );
}

/** Seed the default place, and nothing else. */
export async function seedDefaultPlaceOnly(env: NodeJS.ProcessEnv): Promise<void> {
  await runProjectCli(
    path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    ['scripts/seed.ts'],
    'scripts/seed.ts',
    90_000,
    env,
  );
}

export async function readJson<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} 返回 ${response.status}：${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as T;
}
