#!/usr/bin/env bash
#
# ISLE — restore.
#
# Restores into a *target* directory rather than over the live data, by
# default. A restore that overwrites production in place is a restore with no
# way to find out it went wrong.
#
# Usage:
#   scripts/restore.sh <archive.tar.gz>                  # verify into a temp dir
#   scripts/restore.sh <archive.tar.gz> /var/lib/isle    # restore in place
set -euo pipefail

ARCHIVE="${1:?usage: restore.sh <archive.tar.gz> [target-data-root]}"
TARGET="${2:-}"
APP_ROOT="${APP_ROOT:-/opt/isle}"
# The health check after an in-place restore has to reach the service that was
# just pointed at the restored data. It is configurable so a staging restore
# can point at the staging instance, and it can be skipped entirely for a
# restore into a directory that no service is serving yet.
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
SKIP_HEALTH_CHECK="${SKIP_HEALTH_CHECK:-0}"
WORK="$(mktemp -d)"

log() { printf '[restore] %s\n' "$*"; }
fail() { printf '[restore] ERROR: %s\n' "$*" >&2; exit 1; }

# tar wants forward slashes. On Windows a raw path has backslashes, and tar
# does not treat them as separators.
tarpath() { printf '%s' "${1//\\//}"; }

[ -f "${ARCHIVE}" ] || fail "archive not found: ${ARCHIVE}"

log "extracting to ${WORK}"
# The archive is named relatively, for the same reason the backup names it
# that way: tar reads a leading "host:" in the archive operand as a remote
# archive, so an absolute Windows path would make it try to reach a host
# called "C". The directory operand is not affected -- only the archive is.
ARCHIVE_DIR="$(cd "$(tarpath "$(dirname "${ARCHIVE}")")" && pwd)"
ARCHIVE_FILE="$(basename "${ARCHIVE}")"
( cd "${ARCHIVE_DIR}" && tar -xzf "./${ARCHIVE_FILE}" -C "$(tarpath "${WORK}")" )

[ -f "${WORK}/isle.db" ] || fail "archive contains no isle.db"
[ -d "${WORK}/media" ] || fail "archive contains no media directory"

# Verify before installing. Restoring first and checking afterwards means a
# corrupt backup is briefly live.
log "verifying archived originals against their recorded hashes"
node "${APP_ROOT}/current/scripts/write-media-manifest.mjs" \
  --database "${WORK}/isle.db" \
  --media-root "${WORK}/media" \
  --out "${WORK}/MANIFEST.restored.json" \
  || fail "archived media does not match the archived database"

log "verified: every original matches its SHA-256"

if [ -z "${TARGET}" ]; then
  log "dry run complete. Re-run with a target directory to install:"
  log "  scripts/restore.sh ${ARCHIVE} /var/lib/isle"
  log "staged copy kept at ${WORK}"
  exit 0
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet isle; then
  log "stopping the service"
  systemctl stop isle
fi

mkdir -p "${TARGET}/db" "${TARGET}/media"
cp "${WORK}/isle.db" "${TARGET}/db/isle.db"
# Remove -f first: a photo deleted since the backup would otherwise leave an
# orphan file behind that no database row references.
rm -rf "${TARGET}/media/original" "${TARGET}/media/preview"
cp -a "${WORK}/media/original" "${TARGET}/media/original"
cp -a "${WORK}/media/preview" "${TARGET}/media/preview"

# A restored WAL database left behind by the previous run would be replayed
# over the restored file and undo the restore.
rm -f "${TARGET}/db/isle.db-wal" "${TARGET}/db/isle.db-shm"

chown -R isle:isle "${TARGET}" 2>/dev/null || true

if command -v systemctl >/dev/null 2>&1; then
  log "starting the service"
  systemctl start isle
fi

if [ "${SKIP_HEALTH_CHECK}" = "1" ]; then
  log "skipping the post-restore health check (SKIP_HEALTH_CHECK=1)"
  rm -rf "${WORK}"
  exit 0
fi

log "post-restore health check"
for attempt in 1 2 3 4 5; do
  if curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
    log "healthy"
    rm -rf "${WORK}"
    exit 0
  fi
  log "waiting for the service (${attempt}/5)"
  sleep 3
done

fail "the service did not become healthy after the restore; inspect journalctl -u isle"
