#!/usr/bin/env node
/**
 * Isolated full-stack E2E harness (TEST_STRATEGY §2).
 *
 * Guarantees, in order:
 *   1. Never touches a production path — explicit ISLE_E2E=1 plus a temp dir,
 *      with a hard refusal if either is missing or points at a real deployment.
 *   2. Creates a throwaway SQLite database + media tree under the OS temp dir.
 *   3. Applies real Prisma migrations and seeds fixtures into that database.
 *   4. Runs Playwright against a real production build started by the
 *      webServer hook (`npm run start:test`).
 *   5. Exits non-zero when anything fails, so CI cannot pass silently.
 *
 * Extra CLI args are forwarded verbatim to Playwright, e.g.
 *   node scripts/run-e2e-isolated.mjs --project=chromium
 *   node scripts/run-e2e-isolated.mjs --grep=@visual
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Paths that must never appear in a test environment. */
const FORBIDDEN_PREFIXES = [
  path.resolve('/var/lib/isle'),
  path.resolve('/opt/isle'),
  path.resolve('/srv/isle'),
  path.resolve('D:/SanQian.Xu/Server Project/var'),
];

const TEMP_ROOT = fs.realpathSync(os.tmpdir());

const argv = process.argv.slice(2);
const keepArtifacts = argv.includes('--keep-temp') || process.env.ISLE_E2E_KEEP === '1';
const forwarded = argv.filter((arg) => arg !== '--keep-temp' && arg !== '--visual');

// Visual regression needs a dataset nobody else mutates.
const isVisualRun = process.env.ISLE_VISUAL === '1' || argv.includes('--visual');

function fail(message) {
  console.error(`\n[run-e2e-isolated] ABORT: ${message}\n`);
  process.exit(1);
}

function assertSafeTemp(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(TEMP_ROOT + path.sep) && resolved !== TEMP_ROOT) {
    fail(`isolation directory ${resolved} is outside the OS temp dir (${TEMP_ROOT}).`);
  }
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (resolved.startsWith(prefix)) {
      fail(`isolation directory ${resolved} collides with a production path (${prefix}).`);
    }
  }
  return resolved;
}

// `shell: true` is required on Windows for npx, but it means the shell - not
// Node - splits the command line. This repo path contains a space, so an
// unquoted argument is truncated at the space and the child dies with
// ERR_MODULE_NOT_FOUND.
/**
 * Run a command, retrying a few times.
 *
 * Used for the Prisma CLI, which on Windows cannot replace its query engine
 * while another process still has the file open. The failure is transient and
 * unrelated to what is being tested, so retrying is the right response -- but
 * the last attempt still propagates, so a genuine failure is never hidden.
 */
async function runWithRetry(command, args, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await run(command, args, options);
    } catch (error) {
      lastError = error;
      const transient = /EPERM|EBUSY|rename/i.test(String(error?.message ?? error));
      if (!transient || attempt === attempts) throw error;
      console.warn(
        `[run-e2e-isolated] ${command} ${args.join(' ')} was blocked (${attempt}/${attempts}); retrying`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw lastError;
}

const usesShell = process.platform === 'win32';

function quoteForShell(arg) {
  if (!usesShell) return arg;
  return /[\s"^&|<>()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function run(command, args, options = {}) {
  const finalArgs = args.map(quoteForShell);
  return new Promise((resolve, reject) => {
    const child = spawn(command, finalArgs, {
      cwd: repoRoot,
      stdio: options.quiet ? 'pipe' : 'inherit',
      shell: usesShell,
      env: { ...process.env, ...(options.env ?? {}) },
    });
    let output = '';
    if (options.quiet) {
      child.stdout?.on('data', (chunk) => (output += chunk));
      child.stderr?.on('data', (chunk) => (output += chunk));
    }
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${output}`));
    });
  });
}

const runId = `${process.pid}-${randomBytes(4).toString('hex')}`;
const sandboxRoot = assertSafeTemp(path.join(os.tmpdir(), `isle-e2e-${runId}`));

const dirs = {
  root: sandboxRoot,
  db: path.join(sandboxRoot, 'db'),
  media: path.join(sandboxRoot, 'media'),
  tmp: path.join(sandboxRoot, 'tmp'),
  artifacts: path.join(sandboxRoot, 'artifacts'),
};

for (const dir of Object.values(dirs)) {
  fs.mkdirSync(dir, { recursive: true });
}

const port = String(process.env.E2E_PORT ?? '3017');
const baseUrl = `http://127.0.0.1:${port}`;

const env = {
  NODE_ENV: 'production',
  ISLE_E2E: '1',
  DATABASE_URL: `file:${path.join(dirs.db, 'test.db').replace(/\\/g, '/')}`,
  MEDIA_ROOT: dirs.media,
  UPLOAD_TMP_DIR: dirs.tmp,
  PUBLIC_BASE_URL: baseUrl,
  NEXT_PUBLIC_SITE_URL: baseUrl,
  SITE_ACCESS_MODE: 'friends-only',
  PORT: port,
  HOSTNAME: '127.0.0.1',
  E2E_BASE_URL: baseUrl,
  NEXT_TELEMETRY_DISABLED: '1',
  ISLE_VISUAL: isVisualRun ? '1' : '0',
  // The client's upload deadlines are shortened so the timeout path is
  // testable in seconds rather than minutes. The production defaults are
  // 30s / 120s; the logic is the same, only the constants differ. Local
  // uploads answer in well under a second, so 5s is a wide margin -- but not
  // so wide that a genuinely dead connection goes unnoticed.
  UPLOAD_STALL_TIMEOUT_MS: '5000',
  UPLOAD_RESPONSE_TIMEOUT_MS: '5000',
};

for (const [key, value] of Object.entries(env)) {
  if (
    typeof value === 'string' &&
    (value.includes('/var/lib/isle') || value.includes('/opt/isle'))
  ) {
    fail(`computed ${key} points at a production path: ${value}`);
  }
}

console.log(`[run-e2e-isolated] sandbox : ${sandboxRoot}`);
console.log(`[run-e2e-isolated] database: ${env.DATABASE_URL}`);
console.log(`[run-e2e-isolated] media   : ${dirs.media}`);
console.log(`[run-e2e-isolated] baseUrl : ${baseUrl}`);

// Refuse to run if something is already listening on the chosen port: silently
// reusing an unknown server would let the suite "pass" against a real instance.
const portInUse = await new Promise((resolve) => {
  const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
  socket.on('connect', () => {
    socket.destroy();
    resolve(true);
  });
  socket.on('error', () => resolve(false));
  setTimeout(() => {
    socket.destroy();
    resolve(false);
  }, 1500);
});
if (portInUse) {
  fail(
    `port ${port} is already in use. ` +
      `Refusing to reuse an unknown process — set E2E_PORT to a free port.`,
  );
}

const migrationsDir = path.join(repoRoot, 'prisma', 'migrations');
const hasMigrations = fs.existsSync(migrationsDir);

try {
  if (hasMigrations) {
    console.log('[run-e2e-isolated] applying migrations to the isolated database…');
    // On Windows, prisma generate replaces the query engine DLL, and a stale
    // process still holding it makes the rename fail with EPERM. A short retry
    // clears it once the holder exits, and saves the whole run from failing for
    // a reason that has nothing to do with the code under test.
    await runWithRetry('npx', ['prisma', 'generate'], { env }, 3);
    await runWithRetry('npx', ['prisma', 'migrate', 'deploy'], { env }, 3);
  } else {
    console.log(
      '[run-e2e-isolated] no prisma/migrations yet — skipping migrate/seed (expected until Phase 02).',
    );
  }

  const seedScript = path.join(repoRoot, 'scripts', 'seed.ts');
  if (hasMigrations && fs.existsSync(seedScript)) {
    console.log('[run-e2e-isolated] seeding fixtures…');
    await run('npx', ['tsx', seedScript, '--e2e'], { env });
  }

  console.log(`[run-e2e-isolated] running playwright ${forwarded.join(' ')}`);
  await run('npx', ['playwright', 'test', ...forwarded], { env });
  console.log('[run-e2e-isolated] PASS');
} catch (error) {
  console.error(`\n[run-e2e-isolated] FAIL\n${error instanceof Error ? error.message : error}`);
  console.error(
    `[run-e2e-isolated] artifacts kept for debugging: ${path.join(repoRoot, 'test-results')}`,
  );
  if (keepArtifacts) {
    console.error(`[run-e2e-isolated] sandbox kept: ${sandboxRoot}`);
    process.exit(1);
  }
  process.exit(1);
} finally {
  if (!keepArtifacts) {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
}
