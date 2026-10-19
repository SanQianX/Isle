#!/usr/bin/env bash
#
# ISLE — backup.
#
# Produces a *consistent* snapshot: the database is copied with SQLite's online
# backup API while writes are briefly paused, never by copying a live WAL file
# (DEPLOY_RUNBOOK §8). A plain `cp isle.db` taken while the service is writing
# produces a file that may be missing recent transactions — a backup that
# restores to a broken state is worse than no backup.
#
# Usage: scripts/backup.sh [destination-root]
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/isle}"
DATA_ROOT="${DATA_ROOT:-/var/lib/isle}"
BACKUP_ROOT="${1:-${BACKUP_ROOT:-/var/backups/isle}}"
PRISMA_CLI="${PRISMA_CLI:-/opt/isle/current/node_modules/.bin/prisma}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_ROOT}/${STAMP}"

log() { printf '[backup] %s\n' "$*"; }
fail() { printf '[backup] ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "${DATA_ROOT}/db" ] || fail "data root not found: ${DATA_ROOT}/db"
command -v systemctl >/dev/null 2>&1 || true

mkdir -p "${DEST}"
chmod 700 "${BACKUP_ROOT}" "${DEST}"

# 1. Pause writes. Uploads in flight are allowed to finish; a request that
#    arrives during the window gets a clean 503 from the pause middleware
#    rather than being killed mid-write.
PAUSED=0
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet isle; then
  log "pausing writes"
  systemctl reload isle 2>/dev/null || true
  curl -fsS -X POST "http://127.0.0.1:3000/api/health?pause-writes=1" >/dev/null 2>&1 || true
  PAUSED=1
fi

cleanup() {
  if [ "${PAUSED}" = "1" ]; then
    log "resuming writes"
    curl -fsS -X POST "http://127.0.0.1:3000/api/health?pause-writes=0" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 2. Consistent database snapshot.
if command -v sqlite3 >/dev/null 2>&1; then
  log "snapshotting database with sqlite3 .backup"
  sqlite3 "${DATA_ROOT}/db/isle.db" ".backup '${DEST}/isle.db'"
elif [ -x "${PRISMA_CLI}" ]; then
  # No sqlite3 on the host: fall back to a stopped service, which is the other
  # way to get a consistent copy.
  log "sqlite3 unavailable; stopping the service for the snapshot"
  systemctl stop isle
  cp "${DATA_ROOT}/db/isle.db" "${DEST}/isle.db"
  systemctl start isle
  PAUSED=0
else
  fail "neither sqlite3 nor the Prisma CLI is available"
fi

[ -s "${DEST}/isle.db" ] || fail "database snapshot is empty"

# 3. Media. Originals are immutable, so a plain copy is consistent; the checksums
#    below are what prove it.
log "copying media"
mkdir -p "${DEST}/media"
if [ -d "${DATA_ROOT}/media/original" ]; then
  cp -a "${DATA_ROOT}/media/original" "${DEST}/media/original"
fi
if [ -d "${DATA_ROOT}/media/preview" ]; then
  cp -a "${DATA_ROOT}/media/preview" "${DEST}/media/preview"
fi

# 4. Manifest tying database rows to the bytes on disk. This is the artifact the
#    restore drill verifies, and it is what catches silent media corruption.
log "writing manifest"
node "${APP_ROOT}/current/scripts/write-media-manifest.mjs" \
  --database "${DEST}/isle.db" \
  --media-root "${DEST}/media" \
  --out "${DEST}/MANIFEST.json"

# 5. Record what was deployed, so a restore knows which code to pair with it.
if [ -f "${APP_ROOT}/current/RELEASE" ]; then
  cp "${APP_ROOT}/current/RELEASE" "${DEST}/RELEASE"
fi

tar -C "${DEST}" -czf "${BACKUP_ROOT}/isle-${STAMP}.tar.gz" .
rm -rf "${DEST}"

log "wrote ${BACKUP_ROOT}/isle-${STAMP}.tar.gz"
du -h "${BACKUP_ROOT}/isle-${STAMP}.tar.gz"
