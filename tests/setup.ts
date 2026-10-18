import '@testing-library/jest-dom/vitest';

/**
 * Unit + integration test bootstrap.
 *
 * Hard guard: nothing may run against a production-looking path. The isolated
 * E2E/integration harness points MEDIA_ROOT and UPLOAD_TMP_DIR at a temp dir;
 * if someone forgets, these tests fail loudly instead of writing into
 * /var/lib/isle (TEST_STRATEGY §2, MASTER_PLAN §D).
 */
import os from 'node:os';
import path from 'node:path';

const FORBIDDEN_PREFIXES = ['/var/lib/isle', '/opt/isle', '/srv/isle'];

const mediaRoot = process.env.MEDIA_ROOT ?? '';
const tmpDir = process.env.UPLOAD_TMP_DIR ?? '';

for (const [label, value] of [
  ['MEDIA_ROOT', mediaRoot],
  ['UPLOAD_TMP_DIR', tmpDir],
] as const) {
  if (value === '') continue;
  const resolved = path.resolve(value);
  if (FORBIDDEN_PREFIXES.some((prefix) => resolved.startsWith(prefix))) {
    throw new Error(
      `Refusing to run tests against a production path: ${label}=${resolved}. ` +
        `Tests must use an isolated temp directory.`,
    );
  }
}

if (process.env.DATABASE_URL) {
  const dbPath = process.env.DATABASE_URL.replace(/^file:/, '');
  const resolved = path.resolve(dbPath);
  if (FORBIDDEN_PREFIXES.some((prefix) => resolved.startsWith(prefix))) {
    throw new Error(`Refusing to run tests against a production database: ${resolved}`);
  }
}

if (process.platform !== 'win32' && !tmpDir.startsWith(os.tmpdir()) && !mediaRoot) {
  throw new Error('UPLOAD_TMP_DIR should live under the OS temp directory for tests.');
}
