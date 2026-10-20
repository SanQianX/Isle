#!/usr/bin/env bash
#
# ISLE — release a version.
#
# Builds from a pinned commit, assembles the standalone release, applies
# migrations, and swaps the `current` symlink atomically.
#
# Usage:
#   scripts/deploy.sh <git-sha> [--skip-migrate]
#
# This script assumes a Linux host. It refuses to run anywhere the standalone
# layout or systemctl does not exist, rather than half-deploying.
set -euo pipefail

RELEASE="${1:?usage: deploy.sh <git-sha> [--skip-migrate]}"
SKIP_MIGRATE="${2:-}"
APP_ROOT="${APP_ROOT:-/opt/isle}"
DATA_ROOT="${DATA_ROOT:-/var/lib/isle}"
BUILD_ROOT="${APP_ROOT}/builds"
RELEASE_DIR="${APP_ROOT}/releases/${RELEASE}"

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || fail "deploy.sh only runs on Linux; found $(uname -s)"
command -v systemctl >/dev/null 2>&1 || fail "systemctl not found"

# A first deployment has no previous release and no database: both are created
# *by* this script. The old precondition -- "a database must already exist" --
# made the first deployment impossible, and the operations manual tells the
# operator to run exactly this script to perform it. So the two cases are
# separated here:
#
#   no release and no database  -> first deployment, nothing to back up
#   a release but no database   -> the data directory was wiped; refuse
#   a database                  -> an ordinary deployment, back up first
FIRST_DEPLOY=0
if [ ! -e "${APP_ROOT}/current" ] && [ ! -f "${DATA_ROOT}/db/isle.db" ]; then
  FIRST_DEPLOY=1
  log "first deployment: no previous release, and no data to back up"
elif [ ! -f "${DATA_ROOT}/db/isle.db" ]; then
  fail "a previous release is live but ${DATA_ROOT}/db/isle.db is missing; restore it before deploying"
fi

# 1. Back up before touching anything. A release you cannot roll back is not a
#    release.
if [ "${FIRST_DEPLOY}" = "0" ]; then
  log "creating a pre-deploy backup"
  "${APP_ROOT}/current/scripts/backup.sh" >/dev/null || fail "pre-deploy backup failed"
fi

# 2. Build from the pinned commit.
BUILD_DIR="${BUILD_ROOT}/${RELEASE}"
rm -rf "${BUILD_DIR}"
mkdir -p "${BUILD_DIR}"
log "building ${RELEASE}"
git -C "${APP_ROOT}/source" archive "${RELEASE}" | tar -x -C "${BUILD_DIR}"

pushd "${BUILD_DIR}" >/dev/null
log "npm ci"
npm ci --no-audit --no-fund
log "prisma generate"
npx prisma generate
log "next build"
npm run build
popd >/dev/null

# 3. Assemble the release. next/standalone omits public and .next/static by
#    design; copying them in afterwards is a documented step, not an extra.
log "assembling release directory"
rm -rf "${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"
cp -a "${BUILD_DIR}/.next/standalone/." "${RELEASE_DIR}/"
mkdir -p "${RELEASE_DIR}/.next"
cp -a "${BUILD_DIR}/.next/static" "${RELEASE_DIR}/.next/static"
if [ -d "${BUILD_DIR}/public" ]; then
  cp -a "${BUILD_DIR}/public" "${RELEASE_DIR}/public"
fi
cp -a "${BUILD_DIR}/scripts" "${RELEASE_DIR}/scripts"
cp -a "${BUILD_DIR}/prisma" "${RELEASE_DIR}/prisma"
cp -a "${BUILD_DIR}/node_modules/.prisma" "${RELEASE_DIR}/node_modules/.prisma" 2>/dev/null || true
printf '%s\n' "${RELEASE}" > "${RELEASE_DIR}/RELEASE"
echo "${RELEASE}" > "${RELEASE_DIR}/.build-info"

# 4. Migrate before the swap, against a backup that exists.
if [ "${SKIP_MIGRATE}" != "--skip-migrate" ]; then
  log "applying migrations"
  # Prisma creates the database *file*, but not the directory it lives in, and
  # on a first deployment that directory is the one thing the operator had to
  # create by hand.
  mkdir -p "${DATA_ROOT}/db"
  (cd "${RELEASE_DIR}" && DATABASE_URL="file:${DATA_ROOT}/db/isle.db" npx prisma migrate deploy) \
    || fail "migrations failed; the previous release is still live"
else
  log "skipping migrations as requested"
fi

# 5. Swap atomically.
#
# The previous release is read *before* the swap. Reading it afterwards finds
# the release that was just installed -- the one that is failing -- and the
# rollback command then points at the broken release, which is a rollback
# that rolls nothing back.
PREVIOUS_RELEASE="$(readlink "${APP_ROOT}/current" || true)"
log "switching current -> ${RELEASE}"
ln -sfn "${RELEASE_DIR}" "${APP_ROOT}/current.new"
mv -Tf "${APP_ROOT}/current.new" "${APP_ROOT}/current"

log "restarting the service"
# The unit has Restart=on-failure with StartLimitBurst=5, so a service that
# was enabled before its first release existed has already failed five times
# and systemd has stopped trying. `restart` on a unit in that state is
# refused with "start request repeated too quickly", which would turn a
# perfectly good deployment into a failure at the last step.
systemctl reset-failed isle 2>/dev/null || true
systemctl restart isle

# 6. Verify, and roll back if it is not healthy.
for attempt in 1 2 3 4 5; do
  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    log "healthy; deployed ${RELEASE}"
    exit 0
  fi
  log "waiting for health (${attempt}/5)"
  sleep 3
done

if [ "${FIRST_DEPLOY}" = "1" ]; then
  # Nothing to roll back to: this was the first deployment.
  fail "the first deployment did not become healthy; nothing to roll back to. Read: journalctl -u isle"
fi

log "the new release did not become healthy; rolling back"
log "previous release was ${PREVIOUS_RELEASE}"
fail "roll back with: systemctl stop isle && ln -sfn ${PREVIOUS_RELEASE} ${APP_ROOT}/current && systemctl start isle"
