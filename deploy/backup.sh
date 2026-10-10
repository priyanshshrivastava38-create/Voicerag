#!/usr/bin/env bash
# Nightly backup for the Docker Compose deployment (docs/DEPLOY.md#backups).
#
#   deploy/backup.sh                 # run from anywhere; uses the repo this script lives in
#   BACKUP_DIR=/srv/backups RETENTION_DAYS=14 deploy/backup.sh
#
# Writes   $BACKUP_DIR/YYYY-mm-dd_HHMMSS/{db.dump,storage.tar.gz,SHA256SUMS}
#   db.dump         pg_dump custom format (restore with pg_restore)
#   storage.tar.gz  the app-storage volume (uploaded documents)
# and deletes backup directories older than RETENTION_DAYS.
# Copy BACKUP_DIR off the VM (object storage, another host): a backup on the same disk is not a backup.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vih-voicerag}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
ENV_FILE="${ENV_FILE:-$REPO_DIR/.env.production}"

[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || { echo "RETENTION_DAYS must be a whole number" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Env file not found: $ENV_FILE" >&2; exit 1; }

dc() { docker compose -f "$REPO_DIR/deploy/docker-compose.yml" --env-file "$ENV_FILE" "$@"; }

umask 077
STAMP="$(date +%Y-%m-%d_%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"
mkdir -p "$DEST"
# Remove a half-written backup if anything below fails.
trap 'rc=$?; if [ "$rc" -ne 0 ]; then rm -rf "$DEST"; echo "backup FAILED (rc=$rc)" >&2; fi' EXIT

echo "[$(date -Is)] backing up to $DEST"

# 1. Database. Credentials come from the db container's own environment.
dc exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' >"$DEST/db.dump"
[ -s "$DEST/db.dump" ] || { echo "pg_dump produced an empty file" >&2; exit 1; }

# 2. Document storage volume, read through the app image (works whether or not app is running).
dc run --rm --no-deps -T app tar -czf - -C /app/storage . >"$DEST/storage.tar.gz"
[ -s "$DEST/storage.tar.gz" ] || { echo "storage archive is empty" >&2; exit 1; }

(cd "$DEST" && sha256sum db.dump storage.tar.gz >SHA256SUMS)

# 3. Retention: delete dated backup directories older than RETENTION_DAYS.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20[0-9][0-9]-*' -mtime "+$RETENTION_DAYS" -print -exec rm -rf {} +

echo "[$(date -Is)] backup OK: $(du -sh "$DEST" | cut -f1)"
