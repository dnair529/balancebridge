#!/usr/bin/env bash
# =============================================================================
# Balance Bridge — encrypted off-box backup.
#
#   bash backup.sh uat|prod            # take a backup and ship it off-box
#   bash backup.sh uat|prod --verify   # prove the newest REMOTE backup restores
#   bash backup.sh uat|prod --dry-run  # show what would happen, touch nothing
#
# -----------------------------------------------------------------------------
# WHY THIS EXISTS (the gap it closes)
# -----------------------------------------------------------------------------
# The stack's built-in `backup` service (infra/stack/docker-compose.tpl.yml)
# writes pg_dumps and an uploads tarball to ./backups — a bind mount on the SAME
# VPS DISK as the Postgres data volume and the uploads volume it is backing up.
# That protects against exactly one failure mode: "someone ran DELETE by
# accident". It protects against NONE of the ones that actually end firms:
#
#   * disk or filesystem failure          -> data and backup die together
#   * VPS/provider loss or account lockout-> data and backup die together
#   * ransomware / host compromise        -> the attacker encrypts both
#   * a stolen disk image                 -> plaintext dumps, every client's books
#
# This script fixes all four: the dump never touches the disk unencrypted (it is
# piped straight through openssl), and the ciphertext is shipped to an
# S3-compatible bucket in a different failure domain. The local copy is kept for
# 14 days for fast restores; the remote copy for 90.
#
# -----------------------------------------------------------------------------
# TOOL CHOICES
# -----------------------------------------------------------------------------
# * rclone, not aws-cli. One statically linked binary (`curl https://rclone.org/
#   install.sh | sudo bash`), no Python runtime, and it is configured ENTIRELY
#   from environment variables here — no config file with credentials at rest.
#   aws-cli v2 wants a ~60MB bundled install and its own credentials file.
# * openssl enc -aes-256-cbc -pbkdf2, not age. openssl is already on the box
#   (bootstrap.sh installs ca-certificates/curl/git; openssl ships with Ubuntu
#   and vps-deploy.sh already uses it to mint secrets). age would be one more
#   thing to install and keep current on a single-operator box.
#
#   CAVEAT, stated plainly: AES-256-CBC gives CONFIDENTIALITY, not AUTHENTICITY.
#   A malicious bucket could tamper with the ciphertext and openssl would not
#   notice. We mitigate with a sha256 manifest written at backup time and
#   checked by --verify, which is tamper-EVIDENT as long as the manifest itself
#   is trustworthy. If the threat model grows to include a hostile storage
#   provider, switch to `age` (authenticated) — the only change is the
#   encrypt_stdin/decrypt_stdin functions below.
#
# -----------------------------------------------------------------------------
# CONFIGURATION  ($ENV_DIR/.env.backup, chmod 600, NEVER committed)
# -----------------------------------------------------------------------------
#   BACKUP_PASSPHRASE=...                  # long random; LOSING IT LOSES THE BACKUPS
#   BACKUP_REMOTE=bb:balancebridge-backups # rclone remote:bucket[/prefix]
#   RCLONE_CONFIG_BB_TYPE=s3
#   RCLONE_CONFIG_BB_PROVIDER=Other        # AWS | Wasabi | Backblaze | Other …
#   RCLONE_CONFIG_BB_ACCESS_KEY_ID=...
#   RCLONE_CONFIG_BB_SECRET_ACCESS_KEY=...
#   RCLONE_CONFIG_BB_ENDPOINT=https://...  # omit for real AWS S3
#   RCLONE_CONFIG_BB_REGION=us-east-1
#   # optional overrides
#   BACKUP_LOCAL_RETENTION_DAYS=14
#   BACKUP_REMOTE_RETENTION_DAYS=90
#
# Store BACKUP_PASSPHRASE in the password manager, NOT only on this VPS. A
# backup you cannot decrypt is not a backup. See docs/SECURITY.md for the
# restore runbook.
#
# Cron (root):  15 3 * * *  bash /srv/balancebridge/prod/repo/infra/backup.sh prod  >> /var/log/bb-backup.log 2>&1
#               30 4 * * 0  bash /srv/balancebridge/prod/repo/infra/backup.sh prod --verify >> /var/log/bb-backup.log 2>&1
#
# Exits non-zero on ANY failure — a silent backup failure is worse than none.
# =============================================================================
set -euo pipefail

# ---------- args ----------
ENV_NAME="${1:-}"
MODE="${2:-backup}"
[[ "$ENV_NAME" == "uat" || "$ENV_NAME" == "prod" ]] || {
  echo "usage: $0 uat|prod [--verify|--dry-run]" >&2; exit 2; }
case "$MODE" in
  backup|--backup) MODE=backup ;;
  --verify)        MODE=verify ;;
  --dry-run)       MODE=dryrun ;;
  *) echo "usage: $0 uat|prod [--verify|--dry-run]" >&2; exit 2 ;;
esac

ROOT=/srv/balancebridge
ENV_DIR="${BB_ENV_DIR:-$ROOT/$ENV_NAME}"
LOCAL_DIR="$ENV_DIR/backups"
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"
WORK=""
SET_DIR=""
# Flipped to 1 once every file in the set is written and hashed. Until then the
# set is partial and gets deleted on failure; after it, a failed UPLOAD keeps
# the local copy so you can retry the shipping step without re-dumping.
SET_COMPLETE=0

log()  { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\n\033[1;31mFATAL: %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  local rc=$?
  [[ -n "$WORK" && -d "$WORK" ]] && rm -rf "$WORK"
  # Never leave a half-written set behind to be mistaken for a good backup.
  # (Once the upload is confirmed the script exits 0, so this only fires on failure.)
  if (( rc != 0 )) && (( SET_COMPLETE == 0 )) && [[ -n "$SET_DIR" && -d "$SET_DIR" ]]; then
    rm -rf "$SET_DIR"
    printf '\033[1;31mbackup FAILED (exit %s) — partial set %s removed\033[0m\n' "$rc" "$STAMP" >&2
  elif (( rc != 0 )); then
    printf '\033[1;31m%s FAILED (exit %s)\033[0m\n' "$MODE" "$rc" >&2
  fi
  exit $rc
}
trap cleanup EXIT

# ---------- config ----------
[[ -d "$ENV_DIR" ]] || die "environment dir $ENV_DIR not found (run vps-deploy.sh first)"
CONF="$ENV_DIR/.env.backup"
[[ -f "$CONF" ]] || die "missing $CONF — see the CONFIGURATION block at the top of this script"
# shellcheck disable=SC1090
set -a; source "$CONF"; set +a

: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is not set in $CONF}"
: "${BACKUP_REMOTE:?BACKUP_REMOTE is not set in $CONF}"
LOCAL_RETENTION_DAYS="${BACKUP_LOCAL_RETENTION_DAYS:-14}"
REMOTE_RETENTION_DAYS="${BACKUP_REMOTE_RETENTION_DAYS:-90}"
PBKDF2_ITER="${BACKUP_PBKDF2_ITER:-600000}"
REMOTE_BASE="${BACKUP_REMOTE%/}/$ENV_NAME"

# Compose project is `bb-<env>`; its named volume `uploads` is `bb-<env>_uploads`.
COMPOSE_PROJECT="bb-$ENV_NAME"
UPLOADS_VOLUME="${BACKUP_UPLOADS_VOLUME:-${COMPOSE_PROJECT}_uploads}"
DB_CONTAINER="bb-db-$ENV_NAME"
PG_IMAGE="${BACKUP_PG_IMAGE:-postgres:16-alpine}"
DB_USER="${BACKUP_DB_USER:-portal}"

# ---------- preflight ----------
for bin in docker openssl rclone; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin is not installed (rclone: curl https://rclone.org/install.sh | sudo bash)"
done
docker inspect "$DB_CONTAINER" >/dev/null 2>&1 || die "container $DB_CONTAINER is not running"
docker volume inspect "$UPLOADS_VOLUME" >/dev/null 2>&1 || die "docker volume $UPLOADS_VOLUME not found"
rclone lsd "$BACKUP_REMOTE" >/dev/null 2>&1 || die "cannot reach rclone remote $BACKUP_REMOTE (check credentials/endpoint)"
mkdir -p "$LOCAL_DIR"; chmod 700 "$LOCAL_DIR"

# ---------- crypto helpers (swap these two for `age` if you move to AEAD) ----------
encrypt_stdin() { openssl enc -aes-256-cbc -pbkdf2 -iter "$PBKDF2_ITER" -salt -pass env:BACKUP_PASSPHRASE; }
decrypt_stdin() { openssl enc -d -aes-256-cbc -pbkdf2 -iter "$PBKDF2_ITER" -pass env:BACKUP_PASSPHRASE; }

sha_of() { sha256sum "$1" | awk '{print $1}'; }

# =============================================================================
# VERIFY — download the newest REMOTE backup and prove it is restorable.
# An unverified backup is a hope, not a control.
# =============================================================================
if [[ "$MODE" == "verify" ]]; then
  log "Verifying newest remote backup under $REMOTE_BASE"
  NEWEST="$(rclone lsf --dirs-only "$REMOTE_BASE" 2>/dev/null | sed 's:/$::' | sort | tail -n1)"
  [[ -n "$NEWEST" ]] || die "no backup sets found at $REMOTE_BASE"
  info "newest set: $NEWEST"

  WORK="$(mktemp -d)"; chmod 700 "$WORK"
  rclone copy "$REMOTE_BASE/$NEWEST" "$WORK" --transfers 4 >/dev/null \
    || die "download of $NEWEST failed"
  [[ -f "$WORK/MANIFEST.sha256" ]] || die "set $NEWEST has no MANIFEST.sha256"

  log "Checking ciphertext integrity against the manifest"
  ( cd "$WORK" && sha256sum -c MANIFEST.sha256 ) || die "sha256 mismatch — the remote copy is corrupt or tampered with"

  log "Decrypting and parsing the portal dump"
  PORTAL_ENC="$WORK/portal.dump.enc"
  [[ -f "$PORTAL_ENC" ]] || die "set $NEWEST is missing portal.dump.enc"
  decrypt_stdin < "$PORTAL_ENC" > "$WORK/portal.dump" || die "decryption failed — wrong BACKUP_PASSPHRASE?"
  [[ -s "$WORK/portal.dump" ]] || die "decrypted portal dump is empty"

  # pg_restore --list parses the custom-format archive's TOC. If this succeeds
  # the archive header, compression and TOC are intact and restorable.
  TOC_LINES="$(docker run --rm -v "$WORK":/v:ro "$PG_IMAGE" pg_restore --list /v/portal.dump | grep -c . )" \
    || die "pg_restore --list could not parse the decrypted dump"
  (( TOC_LINES > 10 )) || die "pg_restore TOC looks empty ($TOC_LINES lines)"
  info "portal.dump OK — $TOC_LINES TOC entries"

  if [[ -f "$WORK/docuseal.dump.enc" ]]; then
    decrypt_stdin < "$WORK/docuseal.dump.enc" > "$WORK/docuseal.dump" || die "docuseal decryption failed"
    docker run --rm -v "$WORK":/v:ro "$PG_IMAGE" pg_restore --list /v/docuseal.dump >/dev/null \
      || die "pg_restore --list failed on docuseal.dump"
    info "docuseal.dump OK"
  fi

  log "Decrypting and listing the uploads tarball"
  UPLOADS_ENC="$WORK/uploads.tar.gz.enc"
  [[ -f "$UPLOADS_ENC" ]] || die "set $NEWEST is missing uploads.tar.gz.enc"
  FILE_COUNT="$(decrypt_stdin < "$UPLOADS_ENC" | tar -tzf - | grep -c . )" \
    || die "uploads tarball failed to decrypt or is not a valid tar.gz"
  info "uploads.tar.gz OK — $FILE_COUNT entries"
  info "(entries are AES-256-GCM envelopes; FILE_ENCRYPTION_KEY is needed on top of this to read them)"

  log "VERIFY PASSED for $NEWEST"
  exit 0
fi

# =============================================================================
# BACKUP
# =============================================================================
if [[ "$MODE" == "dryrun" ]]; then
  log "DRY RUN — nothing will be written"
  info "would dump      : $DB_CONTAINER -> portal, docuseal (pg_dump -Fc)"
  info "would archive   : docker volume $UPLOADS_VOLUME"
  info "would encrypt   : openssl aes-256-cbc, pbkdf2 iter=$PBKDF2_ITER"
  info "would write to  : $LOCAL_DIR/*-$STAMP.enc"
  info "would upload to : $REMOTE_BASE/$STAMP/"
  info "local retention : ${LOCAL_RETENTION_DAYS}d    remote retention: ${REMOTE_RETENTION_DAYS}d"
  exit 0
fi

log "Backup $ENV_NAME @ $STAMP"
SET_DIR="$LOCAL_DIR/$STAMP"
mkdir -p "$SET_DIR"; chmod 700 "$SET_DIR"

dump_db() {
  local dbname="$1" out="$SET_DIR/$2"
  info "pg_dump $dbname -> $(basename "$out")"
  # -Fc: custom format. Compressed, and the only format pg_restore --list can
  # parse — which is what makes --verify a real check instead of a file-size check.
  # PIPEFAIL matters here: without it a failed pg_dump would still produce a
  # perfectly valid encryption of nothing.
  docker exec -i "$DB_CONTAINER" pg_dump -U "$DB_USER" -Fc --no-owner --no-privileges "$dbname" \
    | encrypt_stdin > "$out"
  [[ -s "$out" ]] || die "$dbname dump produced an empty file"
}

dump_db portal portal.dump.enc
# DocuSeal's database is optional — it is created lazily by vps-deploy.sh.
if docker exec -i "$DB_CONTAINER" psql -U "$DB_USER" -d postgres -tAc \
     "SELECT 1 FROM pg_database WHERE datname='docuseal'" | grep -q 1; then
  dump_db docuseal docuseal.dump.enc
else
  info "docuseal database absent — skipping"
fi

log "Archiving uploads volume"
# Read-only mount, streamed straight into openssl: the tarball never exists on
# disk in the clear. The FILES inside are already AES-256-GCM envelopes from
# src/lib/crypto.ts, so this is the second of two independent layers.
docker run --rm -v "$UPLOADS_VOLUME":/data:ro "$PG_IMAGE" \
  tar czf - -C /data . | encrypt_stdin > "$SET_DIR/uploads.tar.gz.enc"
[[ -s "$SET_DIR/uploads.tar.gz.enc" ]] || die "uploads archive is empty"

log "Writing manifest"
( cd "$SET_DIR" && sha256sum ./*.enc | sed 's: \./: :' > MANIFEST.sha256 )
{
  echo "env=$ENV_NAME"
  echo "stamp=$STAMP"
  echo "host=$(hostname)"
  echo "cipher=aes-256-cbc/pbkdf2-$PBKDF2_ITER"
  echo "pg_dump_format=custom"
} > "$SET_DIR/META"
chmod 600 "$SET_DIR"/*
for f in "$SET_DIR"/*.enc; do info "$(basename "$f")  $(du -h "$f" | cut -f1)  $(sha_of "$f" | cut -c1-16)…"; done
SET_COMPLETE=1

log "Uploading to $REMOTE_BASE/$STAMP/"
rclone copy "$SET_DIR" "$REMOTE_BASE/$STAMP" --transfers 2 --retries 3 --stats-one-line \
  || die "upload failed — the local copy in $SET_DIR was kept"

# Read it back: an upload that "succeeded" but stored nothing is a real failure mode.
REMOTE_COUNT="$(rclone lsf "$REMOTE_BASE/$STAMP" | grep -c . || true)"
LOCAL_COUNT="$(find "$SET_DIR" -maxdepth 1 -type f | wc -l)"
[[ "$REMOTE_COUNT" == "$LOCAL_COUNT" ]] \
  || die "remote has $REMOTE_COUNT files, local set has $LOCAL_COUNT — upload incomplete"
info "$REMOTE_COUNT objects confirmed remote"

log "Retention"
# Local: keep 14 days of fast-restore copies.
find "$LOCAL_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$LOCAL_RETENTION_DAYS" -print -exec rm -rf {} + \
  | sed 's/^/    pruned local /' || true
# Also sweep the legacy flat files written by the compose `backup` service.
find "$LOCAL_DIR" -maxdepth 1 -type f -name '*.gz' -mtime "+$LOCAL_RETENTION_DAYS" -delete || true
# Remote: 90 days. --min-age is measured on the object's modification time.
rclone delete "$REMOTE_BASE" --min-age "${REMOTE_RETENTION_DAYS}d" --rmdirs \
  || die "remote retention sweep failed"
info "local >${LOCAL_RETENTION_DAYS}d and remote >${REMOTE_RETENTION_DAYS}d pruned"

log "Backup OK — $REMOTE_BASE/$STAMP"
info "verify it with: bash $0 $ENV_NAME --verify"
