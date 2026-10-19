#!/usr/bin/env node
/**
 * Start the production build for tests.
 *
 * Playwright's `webServer` runs this. It boots the *standalone* server from
 * `.next/standalone/server.js` — the exact artifact systemd runs in production
 * (DEPLOY_RUNBOOK §4/§6) — so the suite exercises the release path rather than
 * a different one.
 *
 * All configuration arrives through the environment, which
 * scripts/run-e2e-isolated.mjs has already pointed at an isolated database and
 * media directory. We refuse to start without that isolation, so a stray
 * `npm run test:e2e` can never write into a real deployment.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const nextDir = path.join(repoRoot, '.next');
const standaloneDir = path.join(nextDir, 'standalone');

function refuse(message) {
  console.error(`[start-test-server] refusing to start: ${message}`);
  process.exit(1);
}

for (const key of ['DATABASE_URL', 'MEDIA_ROOT', 'UPLOAD_TMP_DIR', 'ISLE_E2E']) {
  if (!process.env[key]) refuse(`missing ${key}. Use "npm run test:e2e".`);
}
if (process.env.ISLE_E2E !== '1') refuse('ISLE_E2E must be exactly "1".');
if (process.env.NODE_ENV !== 'production') refuse('NODE_ENV must be "production".');
if (!fs.existsSync(standaloneDir)) refuse('no .next/standalone — run "npm run build" first.');

/**
 * Next's standalone output deliberately omits these two directories; the deploy
 * script copies them into the release, so the test server must do the same or
 * the page renders without CSS and every visual assertion becomes meaningless.
 */
function copyInto(from, to) {
  if (!fs.existsSync(from)) return false;
  fs.cpSync(from, to, { recursive: true });
  return true;
}

const copiedStatic = copyInto(
  path.join(nextDir, 'static'),
  path.join(standaloneDir, '.next', 'static'),
);
const copiedPublic = copyInto(path.join(repoRoot, 'public'), path.join(standaloneDir, 'public'));

/**
 * Verify that the stylesheet the build produced is present in the release, and
 * that its bytes match the build output.
 *
 * This guards a failure that is otherwise invisible: the server boots, every
 * route answers 200, and the page renders as unstyled HTML. Nothing crashes and
 * no test fails -- the site just looks broken, and only a human looking at it
 * would notice.
 *
 * Comparing content hashes also catches the subtle version: a release holding a
 * *stale* stylesheet from an earlier build, whose filename no longer matches
 * the one the page asks for.
 */
function assertStaticAssetsPresent() {
  const buildCssDir = path.join(nextDir, 'static', 'css');
  const releaseCssDir = path.join(standaloneDir, '.next', 'static', 'css');

  if (!fs.existsSync(buildCssDir)) {
    refuse('the build produced no CSS — nothing to serve.');
  }

  const expected = fs.readdirSync(buildCssDir).filter((name) => name.endsWith('.css'));
  if (expected.length === 0) {
    refuse('the build produced no CSS files.');
  }

  for (const name of expected) {
    const releasePath = path.join(releaseCssDir, name);
    if (!fs.existsSync(releasePath)) {
      refuse(`stylesheet ${name} is missing from the release — copy .next/static before starting.`);
    }

    const buildHash = createHash('sha256')
      .update(fs.readFileSync(path.join(buildCssDir, name)))
      .digest('hex');
    const releaseHash = createHash('sha256').update(fs.readFileSync(releasePath)).digest('hex');
    if (buildHash !== releaseHash) {
      refuse(
        `stylesheet ${name} in the release is stale (content differs from the build). ` +
          `Re-copy .next/static before starting.`,
      );
    }
  }

  return expected;
}

const stylesheets = assertStaticAssetsPresent();

const port = process.env.PORT ?? '3017';
const host = process.env.HOSTNAME ?? '127.0.0.1';

console.log(`[start-test-server] standalone server on http://${host}:${port}`);
console.log(
  `[start-test-server] static copied: ${copiedStatic}, public copied: ${copiedPublic}, ` +
    `stylesheets verified: ${stylesheets.length}`,
);

const child = spawn(process.execPath, [path.join(standaloneDir, 'server.js')], {
  cwd: standaloneDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: port,
    HOSTNAME: host,
  },
});

const shutdown = () => {
  if (child.exitCode === null) child.kill('SIGTERM');
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, shutdown);
}

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});

process.on('exit', shutdown);
