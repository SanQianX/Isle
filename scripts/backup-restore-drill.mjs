#!/usr/bin/env node
/**
 * ISLE — backup and restore drill.
 *
 * DEPLOY_RUNBOOK §8 makes a restore rehearsal a release gate: "备份集 → 新隔离目录
 * → 校验原图 SHA 清单 → 启动同版本应用连恢复 DB → Playwright 打开桂山岛榜单…"
 * Until now nothing ran those scripts, so they were unverified code sitting in
 * the release path.
 *
 * This drill exercises the parts that do not need a running service:
 *
 *   1. build a real data directory (real SQLite file, real original files,
 *      real rows),
 *   2. run scripts/backup.sh against it,
 *   3. check the archive really contains the database, the media and the
 *      manifest,
 *   4. run scripts/restore.sh as a dry run,
 *   5. restore into a fresh directory and compare every original byte for
 *      byte and every row for row,
 *   6. corrupt one byte of an archived original and prove the restore
 *      *refuses* rather than installing broken data.
 *
 * Step 6 is the one that matters. A restore that installs a corrupted archive
 * and reports success is worse than a restore that fails loudly.
 *
 * Nothing here touches a production path: the whole drill runs in a temporary
 * directory.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fsSync, { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const repoRoot = process.cwd();
const sandbox = path.join(
  os.tmpdir(),
  `isle-drill-${process.pid}-${Math.random().toString(36).slice(2, 7)}`,
);
const dataRoot = path.join(sandbox, 'data');
const appRoot = path.join(sandbox, 'app');
const backupRoot = path.join(sandbox, 'backups');
const restoreTarget = path.join(sandbox, 'restored');

const steps = [];
let failed = false;

function record(label, ok, detail = '') {
  steps.push({ label, ok, detail });
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

function run(command, args, env = {}, cwd = undefined) {
  return execFileSync(command, args, {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd === undefined ? {} : { cwd }),
  });
}

/**
 * Run tar against an archive without naming it absolutely.
 *
 * tar reads a leading "host:" in the archive operand as a remote archive, so
 * "C:/backups/x.tar.gz" makes it try to reach a host called "C". The drill
 * hits the same problem the scripts did, which is a good sign: the drill is
 * exercising the real behaviour rather than a convenient one.
 */
function tarWithArchive(archive, tarArgs) {
  const dir = path.dirname(archive);
  const file = path.basename(archive);
  return run('bash', ['-c', 'tar "$@"', '--', ...tarArgs, file], {}, dir);
}

/**
 * Extract an archive into a directory, using only relative names.
 *
 * MSYS tar does not understand "C:/..." as a path at all, and a leading
 * "host:" in the archive operand is read as a remote archive. Copying the
 * archive next to its destination and naming it "./archive.tar.gz" sidesteps
 * both.
 */
function extractArchive(archive, into) {
  const local = path.join(into, 'archive.tar.gz');
  fsSync.copyFileSync(archive, local);
  return run('bash', ['-c', 'tar "$@"', '--', '-xzf', './archive.tar.gz'], {}, into);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

console.log(`[drill] sandbox ${sandbox}`);

try {
  // --- 1. A real data directory ------------------------------------------
  await fs.mkdir(path.join(dataRoot, 'db'), { recursive: true });
  await fs.mkdir(path.join(dataRoot, 'media', 'original'), { recursive: true });
  await fs.mkdir(path.join(dataRoot, 'media', 'preview'), { recursive: true });
  await fs.mkdir(backupRoot, { recursive: true });

  // The release layout the scripts expect: APP_ROOT/current/scripts/...
  //
  // The node_modules entries matter as much as the scripts. Both
  // write-media-manifest.mjs and sqlite-snapshot.mjs import @prisma/client,
  // and Node resolves that by walking up from the script's own directory --
  // so a release assembled without it cannot take a snapshot or verify one.
  // deploy.sh copies the same two things, so the drill mirrors it.
  await fs.mkdir(path.join(appRoot, 'current'), { recursive: true });
  await fs.cp(path.join(repoRoot, 'scripts'), path.join(appRoot, 'current', 'scripts'), {
    recursive: true,
  });
  await fs.mkdir(path.join(appRoot, 'current', 'node_modules'), { recursive: true });
  await fs.cp(
    path.join(repoRoot, 'node_modules', '@prisma', 'client'),
    path.join(appRoot, 'current', 'node_modules', '@prisma', 'client'),
    { recursive: true },
  );
  await fs.cp(
    path.join(repoRoot, 'node_modules', '.prisma'),
    path.join(appRoot, 'current', 'node_modules', '.prisma'),
    { recursive: true },
  );

  const databaseFile = path.join(dataRoot, 'db', 'isle.db');
  const databaseUrl = `file:${databaseFile.replace(/\\/g, '/')}`;

  // Migrate the real schema into it.
  const prismaCli = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');
  run(process.execPath, [prismaCli, 'migrate', 'deploy'], { DATABASE_URL: databaseUrl });

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  const visitor = await prisma.visitor.create({
    data: { tokenHash: `drill-${Date.now()}`, displayCode: 'dr001' },
  });
  const place = await prisma.place.create({
    data: {
      name: '演练岛',
      slug: 'yanlian-island',
      // The duplicate constraint lives on this column, so it is not optional.
      normalizedName: '演练岛',
      region: '测试地区',
      description: '备份恢复演练',
    },
  });

  // Three real photographs, written to disk exactly as the application writes
  // them: content-addressed name, bytes that hash to the recorded digest.
  const fixture = await fs.readFile(path.join(repoRoot, 'tests', 'fixtures', 'landscape.jpg'));
  const expected = new Map();
  for (let index = 0; index < 3; index += 1) {
    const bytes = Buffer.concat([fixture, Buffer.from([index])]);
    const digest = sha256(bytes);
    const key = `original/${digest.slice(0, 2)}/${digest.slice(2)}.jpg`;
    const absolute = path.join(dataRoot, 'media', key);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, bytes);
    expected.set(digest, bytes);

    await prisma.photo.create({
      data: {
        placeId: place.id,
        visitorId: visitor.id,
        title: `照片 ${index}`,
        description: '',
        status: 'READY',
        originalKey: key,
        originalSha256: digest,
        originalByteLength: bytes.byteLength,
        originalMime: 'image/jpeg',
        originalFileName: `photo-${index}.jpg`,
        width: 800,
        height: 600,
        preview400Key: `preview/400/${digest}.webp`,
        preview1200Key: `preview/1200/${digest}.webp`,
      },
    });
  }
  await prisma.$disconnect();
  record('built a real data directory', true, '1 place, 3 photos, 3 originals on disk');

  // --- 2. Run the backup --------------------------------------------------
  console.log('\n=== backup ===');
  let backupOutput = '';
  let backupOk = true;
  try {
    backupOutput = run('bash', [path.join(repoRoot, 'scripts', 'backup.sh'), backupRoot], {
      APP_ROOT: appRoot,
      DATA_ROOT: dataRoot,
      BACKUP_ROOT: backupRoot,
    });
  } catch (error) {
    backupOk = false;
    backupOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  console.log(backupOutput.trim());
  record('scripts/backup.sh completed', backupOk);

  const archives = existsSync(backupRoot)
    ? (await fs.readdir(backupRoot)).filter((name) => name.endsWith('.tar.gz'))
    : [];
  record('backup produced exactly one archive', archives.length === 1, archives.join(', '));

  if (archives.length !== 1) throw new Error('no archive to restore');

  const archive = path.join(backupRoot, archives[0]);

  // --- 3. What is in the archive -----------------------------------------
  console.log('\n=== archive contents ===');
  const listing = tarWithArchive(archive, ['-tzf']);
  const entries = listing.split('\n').filter((line) => line !== '');
  const hasDatabase = entries.some((entry) => entry.endsWith('isle.db'));
  const hasManifest = entries.some((entry) => entry.endsWith('MANIFEST.json'));
  // tar lists directories too, and the originals are sharded into two-level
  // directories, so the count includes the shard folders themselves. Only the
  // files count.
  const originalEntries = entries.filter(
    (entry) => entry.includes('media/original/') && !entry.endsWith('/'),
  );
  record('the archive contains the database', hasDatabase);
  record('the archive contains the manifest', hasManifest);
  record(
    'the archive contains every original',
    originalEntries.length === 3,
    `${originalEntries.length} found`,
  );

  // --- 4. Dry run ---------------------------------------------------------
  console.log('\n=== restore: dry run ===');
  let dryOk = true;
  let dryOutput = '';
  try {
    dryOutput = run('bash', [path.join(repoRoot, 'scripts', 'restore.sh'), archive], {
      APP_ROOT: appRoot,
    });
  } catch (error) {
    dryOk = false;
    dryOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  console.log(dryOutput.trim());
  record('scripts/restore.sh verifies a good archive', dryOk);

  // --- 5. Restore into a fresh directory ---------------------------------
  console.log('\n=== restore: into an isolated directory ===');
  let restoreOk = true;
  let restoreOutput = '';
  try {
    restoreOutput = run(
      'bash',
      [path.join(repoRoot, 'scripts', 'restore.sh'), archive, restoreTarget],
      { APP_ROOT: appRoot, SKIP_HEALTH_CHECK: '1' },
    );
  } catch (error) {
    restoreOk = false;
    restoreOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  console.log(restoreOutput.trim());
  record('scripts/restore.sh installs into a target directory', restoreOk);

  if (restoreOk) {
    // The restored database must hold the same rows.
    const restoredDb = path.join(restoreTarget, 'db', 'isle.db');
    const restored = new PrismaClient({
      datasources: { db: { url: `file:${restoredDb.replace(/\\/g, '/')}` } },
    });
    const photoCount = await restored.photo.count();
    const placeCount = await restored.place.count();
    const voteCount = await restored.vote.count();
    await restored.$disconnect();
    record('the restored database holds every photo', photoCount === 3, `${photoCount} photos`);
    record('the restored database holds every place', placeCount === 1, `${placeCount} places`);
    record('the restored database holds the votes', voteCount === 0, `${voteCount} votes`);

    // And every original must be byte-identical.
    let identical = 0;
    for (const [digest, bytes] of expected) {
      const restoredOriginal = path.join(
        restoreTarget,
        'media',
        'original',
        digest.slice(0, 2),
        `${digest.slice(2)}.jpg`,
      );
      if (!existsSync(restoredOriginal)) continue;
      const got = await fs.readFile(restoredOriginal);
      if (got.equals(bytes)) identical += 1;
    }
    record(
      'every restored original is byte-identical',
      identical === expected.size,
      `${identical}/${expected.size}`,
    );
  }

  // --- 6. A corrupted archive must be refused -----------------------------
  console.log('\n=== restore: a corrupted archive must be refused ===');
  const corruptWork = path.join(sandbox, 'corrupt');
  await fs.mkdir(corruptWork, { recursive: true });
  extractArchive(archive, corruptWork);
  // The copy made for the extraction is not part of the data; take it back out
  // so the corrupted archive holds only what the real one held.
  await fs.rm(path.join(corruptWork, 'archive.tar.gz'), { force: true });
  const victim = expected.keys().next().value;
  const victimPath = path.join(
    corruptWork,
    'media',
    'original',
    victim.slice(0, 2),
    `${victim.slice(2)}.jpg`,
  );
  const original = await fs.readFile(victimPath);
  const corrupted = Buffer.from(original);
  corrupted[0] = corrupted[0] ^ 0xff;
  await fs.writeFile(victimPath, corrupted);

  // The archive is written one level up, outside the tree it archives: an
  // archive written inside the tree it is reading makes tar report "file
  // changed as we read it" about the archive itself.
  const corruptArchive = path.join(sandbox, 'corrupt.tar.gz');
  run('bash', ['-c', 'tar "$@"', '--', '-czf', '../corrupt.tar.gz', '.'], {}, corruptWork);

  let corruptOk = true;
  let corruptOutput = '';
  try {
    corruptOutput = run('bash', [path.join(repoRoot, 'scripts', 'restore.sh'), corruptArchive], {
      APP_ROOT: appRoot,
    });
    corruptOk = false;
  } catch (error) {
    corruptOutput = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  console.log(corruptOutput.trim());
  record('a corrupted archive is refused', corruptOk);
  record(
    'the refusal says the media does not match',
    /does not match|不匹配|hash/i.test(corruptOutput),
  );
} catch (error) {
  failed = true;
  console.error('[drill] error:', error);
} finally {
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined);
}

const passed = steps.filter((step) => step.ok).length;
console.log(`\n[drill] ${passed}/${steps.length} checks passed`);
if (failed) {
  console.error('[drill] FAILED');
  process.exit(1);
}
console.log('[drill] OK');
