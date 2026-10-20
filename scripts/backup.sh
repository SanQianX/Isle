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
APP_PORT="${APP_PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${APP_PORT}/api/health"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${BACKUP_ROOT}/${STAMP}"

log() { printf '[backup] %s\n' "$*"; }
fail() { printf '[backup] ERROR: %s\n' "$*" >&2; exit 1; }

# tar wants forward slashes. On Windows a raw path has backslashes, and tar
# does not treat them as separators.
tarpath() { printf '%s' "${1//\\//}"; }

[ -d "${DATA_ROOT}/db" ] || fail "data root not found: ${DATA_ROOT}/db"
command -v systemctl >/dev/null 2>&1 || true

mkdir -p "${DEST}"
chmod 700 "${BACKUP_ROOT}" "${DEST}"

# 1. Pause writes.
#
#    The pause has to be *verified*, not assumed. This script used to call an
#    endpoint that did not exist, with a method the route did not implement,
#    and swallow the failure with `|| true` -- so the backup ran with writes
#    still flowing, which is the one thing a backup must not do. A photograph
#    uploaded between the database snapshot and the media copy leaves the
#    snapshot with a row and no file: a backup that restores into a broken
#    state is worse than no backup at all.
#
#    Uploads already in flight are allowed to finish; a request that arrives
#    during the window gets a clean 503 rather than being killed mid-write.
PAUSED=0
SERVICE_STOPPED=0

service_is_running() {
  command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet isle
}

pause_writes() {
  curl -fsS --max-time 10 -X POST "${HEALTH_URL}?pause-writes=$1" 2>/dev/null
}

writes_confirmed_paused() {
  curl -fsS --max-time 10 "${HEALTH_URL}" 2>/dev/null | grep -q '"writesPaused":true'
}

if pause_writes 1 >/dev/null 2>&1 && writes_confirmed_paused; then
  PAUSED=1
  log "writes paused"
elif service_is_running; then
  # The service is up but the pause could not be confirmed. Stopping the
  # service is the other way to get a consistent copy, and it is always
  # available when systemd is.
  log "write pause unavailable; stopping the service for the backup"
  systemctl stop isle
  SERVICE_STOPPED=1
else
  # Nothing is running, so nothing can be writing to the data directory.
  log "no running service; the data directory is not being written to"
fi

cleanup() {
  if [ "${PAUSED}" = "1" ]; then
    log "resuming writes"
    pause_writes 0 >/dev/null 2>&1 || true
  fi
  if [ "${SERVICE_STOPPED}" = "1" ]; then
    log "restarting the service"
    systemctl start isle || true
  fi
}
trap cleanup EXIT

# 2. Consistent database snapshot.
#
#    Three ways to get one, in order of preference:
#
#      a. VACUUM INTO, through Node. It reads the database under a read
#         transaction and writes a complete copy, while the service keeps
#         serving. Node is on the host by definition -- the application runs
#         on it -- so this path has no dependency the deployment does not
#         already have.
#      b. sqlite3's .backup, which does the same thing, when the CLI happens
#         to be installed.
#      c. A stopped service, which is the fallback but turns the window into
#         a visible outage.
SNAPSHOT_SCRIPT="${APP_ROOT}/current/scripts/sqlite-snapshot.mjs"
if [ -f "${SNAPSHOT_SCRIPT}" ] && command -v node >/dev/null 2>&1; then
  log "snapshotting database with VACUUM INTO"
  node "${SNAPSHOT_SCRIPT}" \
    --source "${DATA_ROOT}/db/isle.db" \
    --dest "${DEST}/isle.db" \
    || fail "the database snapshot failed"
elif command -v sqlite3 >/dev/null 2>&1; then
  log "snapshotting database with sqlite3 .backup"
  sqlite3 "${DATA_ROOT}/db/isle.db" ".backup '${DEST}/isle.db'"
elif [ "${SERVICE_STOPPED}" = "1" ]; then
  # The service is already stopped, so the file on disk is the whole truth.
  log "no snapshot tool available; copying the database with the service stopped"
  cp "${DATA_ROOT}/db/isle.db" "${DEST}/isle.db"
elif service_is_running; then
  # No snapshot tool and the service is up. Stopping it is the only way to
  # get a consistent copy.
  log "no snapshot tool available; stopping the service for the snapshot"
  systemctl stop isle
  SERVICE_STOPPED=1
  cp "${DATA_ROOT}/db/isle.db" "${DEST}/isle.db"
else
  fail "no snapshot tool is available and there is no service to stop; cannot take a consistent snapshot"
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

# 6. The archive.
#
#    Two details, both found by actually running this script.
#
#    The archive is named relatively and written outside the tree it archives.
#    tar reads a leading "host:" in the archive operand as a remote archive,
#    so an absolute path ("C:/backups/isle-....tar.gz") makes it try to reach
#    a host called "C" and fail with "Cannot connect to C: resolve failed". A
#    relative "./name" has no colon. And an archive written *inside* the tree
#    it is reading makes tar report "file changed as we read it" about the
#    archive itself, so the temporary file goes to the backup root and is
#    renamed afterwards.
ARCHIVE_NAME="isle-${STAMP}.tar.gz"
( cd "$(tarpath "${BACKUP_ROOT}")" && tar -czf "./${ARCHIVE_NAME}.tmp" -C "$(tarpath "${DEST}")" . )
mv "$(tarpath "${BACKUP_ROOT}/${ARCHIVE_NAME}.tmp")" "$(tarpath "${BACKUP_ROOT}/${ARCHIVE_NAME}")"
rm -rf "${DEST}"

log "wrote ${BACKUP_ROOT}/${ARCHIVE_NAME}"
du -h "${BACKUP_ROOT}/${ARCHIVE_NAME}"
