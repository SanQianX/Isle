#!/usr/bin/env bash
#
# Verify that every original on disk still matches the SHA-256 recorded in the
# database. Run this after a restore, after a migration, and on a schedule.
#
# This is the check that makes "the original is never altered" an ongoing
# property rather than a claim about the upload path alone.
set -euo pipefail

DATA_ROOT="${DATA_ROOT:-/var/lib/isle}"
APP_ROOT="${APP_ROOT:-/opt/isle}"
MODE="${1:-live}"

log() { printf '[verify] %s\n' "$*"; }

case "${MODE}" in
  live)
    DATABASE="${DATA_ROOT}/db/isle.db"
    MEDIA="${DATA_ROOT}/media"
    ;;
  extracted)
    DATABASE="${2:?usage: verify-media-hashes.sh extracted <dir>}"
    MEDIA="${2}/media"
    ;;
  *)
    echo "usage: verify-media-hashes.sh [live|extracted <dir>]" >&2
    exit 1
    ;;
esac

[ -f "${DATABASE}" ] || { echo "[verify] missing database: ${DATABASE}" >&2; exit 1; }

log "verifying originals in ${MEDIA}"
node "${APP_ROOT}/current/scripts/write-media-manifest.mjs" \
  --database "${DATABASE}" \
  --media-root "${MEDIA}" \
  --out "${TMPDIR:-/tmp}/isle-verify-$$.json"

log "all originals match their recorded hashes"
rm -f "${TMPDIR:-/tmp}/isle-verify-$$.json"
