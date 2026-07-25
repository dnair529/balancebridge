#!/usr/bin/env bash
# Balance Bridge — one-shot VPS deploy. Idempotent: safe to re-run for every deploy.
#
#   bash vps-deploy.sh uat     # deploy uat branch  -> uat.balancebridge.us
#   bash vps-deploy.sh prod    # deploy main branch -> balancebridge.us
#
# Requires /srv/balancebridge/.gitcreds (root-only) containing:
#   https://USER:TOKEN@github.com
set -euo pipefail

ENV_NAME="${1:-uat}"
[[ "$ENV_NAME" == "uat" || "$ENV_NAME" == "prod" ]] || { echo "usage: $0 uat|prod"; exit 1; }
BRANCH=$([[ "$ENV_NAME" == "prod" ]] && echo main || echo uat)
ROOT=/srv/balancebridge
ENV_DIR="$ROOT/$ENV_NAME"
REPO_URL=https://github.com/dnair529/balancebridge.git

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

# ---------- 1. host prep (idempotent) ----------
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker + base packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl git ufw fail2ban unattended-upgrades
  curl -fsSL https://get.docker.com | sh
fi

if ! ufw status 2>/dev/null | grep -q "Status: active"; then
  log "Configuring firewall (22/80/443 only)"
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp && ufw allow 80/tcp && ufw allow 443/tcp
  ufw --force enable
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
  systemctl enable --now fail2ban 2>/dev/null || true
fi

mkdir -p "$ROOT"/{caddy,uat,prod} "$ENV_DIR"/{site-dist,backups}
docker network inspect "bb-$ENV_NAME" >/dev/null 2>&1 || docker network create "bb-$ENV_NAME"

# ---------- 2. secrets ----------
gen() { openssl rand -base64 48 | tr -d '/+=' | head -c "$1"; }

if [[ ! -f "$ENV_DIR/.env" ]]; then
  log "Generating $ENV_NAME secrets"
  ADMIN_PW=$(gen 20)
  cat > "$ENV_DIR/.env" <<EOF
ENV_NAME=$ENV_NAME
POSTGRES_PASSWORD=$(gen 32)
SESSION_PEPPER=$(gen 48)
DOCUSEAL_SECRET_KEY_BASE=$(gen 64)
DOCUSEAL_PUBLIC_HOST=$([[ $ENV_NAME == prod ]] && echo sign.balancebridge.us || echo sign-uat.balancebridge.us)
DOCUSEAL_URL=$([[ $ENV_NAME == prod ]] && echo https://sign.balancebridge.us || echo https://sign-uat.balancebridge.us)
DOCUSEAL_API_KEY=CHANGE_ME_after_docuseal_first_boot
DOCUSEAL_WEBHOOK_SECRET=$(gen 32)
SITE_URL=$([[ $ENV_NAME == prod ]] && echo https://balancebridge.us || echo https://uat.balancebridge.us)
PORTAL_URL=$([[ $ENV_NAME == prod ]] && echo https://portal.balancebridge.us || echo https://portal-uat.balancebridge.us)
ADMIN_EMAIL=deepak529@gmail.com
ADMIN_PASSWORD=$ADMIN_PW
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM=Balance Bridge <hello@balancebridge.us>
FIRM_INBOX=deepak529@gmail.com
SEED_DEMO=$([[ $ENV_NAME == uat ]] && echo 1 || echo 0)
COOKIE_SECURE=1
EOF
  chmod 600 "$ENV_DIR/.env"
  echo "    PORTAL ADMIN: deepak529@gmail.com / $ADMIN_PW"
  echo "$ADMIN_PW" > "$ENV_DIR/.admin-password"; chmod 600 "$ENV_DIR/.admin-password"
fi

if [[ ! -f "$ROOT/caddy/.env" ]]; then
  UAT_PASS=${UAT_PASS:-$(gen 16)}
  HASH=$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$UAT_PASS")
  cat > "$ROOT/caddy/.env" <<EOF
ACME_EMAIL=deepak529@gmail.com
UAT_BASICAUTH_USER=preview
UAT_BASICAUTH_HASH=$HASH
EOF
  chmod 600 "$ROOT/caddy/.env"
  echo "    UAT PREVIEW LOGIN: preview / $UAT_PASS"
  echo "$UAT_PASS" > "$ROOT/caddy/.preview-password"; chmod 600 "$ROOT/caddy/.preview-password"
fi

# ---------- 3. source ----------
log "Fetching $BRANCH"
git config --global credential.helper "store --file=$ROOT/.gitcreds"
if [[ -d "$ENV_DIR/repo/.git" ]]; then
  git -C "$ENV_DIR/repo" fetch --depth 1 origin "$BRANCH"
  git -C "$ENV_DIR/repo" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$ENV_DIR/repo"
fi
COMMIT=$(git -C "$ENV_DIR/repo" rev-parse --short HEAD)

# ---------- 4. build marketing site (in a container — no host Node needed) ----------
log "Building marketing site ($COMMIT)"
SITE_URL_VAL=$(grep '^SITE_URL=' "$ENV_DIR/.env" | cut -d= -f2-)
docker run --rm \
  -v "$ENV_DIR/repo/site":/app -w /app \
  -e SITE_URL="$SITE_URL_VAL" \
  node:22-alpine sh -c "npm ci --no-fund --no-audit --silent && npm run build"

rm -rf "$ENV_DIR/site-dist.old"
[[ -d "$ENV_DIR/site-dist" ]] && mv "$ENV_DIR/site-dist" "$ENV_DIR/site-dist.old"
cp -r "$ENV_DIR/repo/site/dist" "$ENV_DIR/site-dist"

# ---------- 5. portal + db + docuseal ----------
log "Starting $ENV_NAME stack"
cp "$ENV_DIR/repo/infra/stack/docker-compose.yml" "$ENV_DIR/docker-compose.yml"
cd "$ENV_DIR"
docker compose --env-file .env build portal
docker compose --env-file .env up -d --remove-orphans
sleep 8
docker compose --env-file .env exec -T portal node dist/db/migrate.js || echo "    (migrate skipped/failed — check logs)"
if [[ "$(grep '^SEED_DEMO=' .env | cut -d= -f2)" == "1" ]]; then
  docker compose --env-file .env exec -T portal node dist/db/seed.js || true
fi

# ---------- 6. edge ----------
log "Reloading Caddy"
cp "$ENV_DIR/repo/infra/caddy/Caddyfile" "$ROOT/caddy/Caddyfile"
cp "$ENV_DIR/repo/infra/caddy/docker-compose.yml" "$ROOT/caddy/docker-compose.yml"
docker network inspect bb-prod >/dev/null 2>&1 || docker network create bb-prod
docker network inspect bb-uat  >/dev/null 2>&1 || docker network create bb-uat
mkdir -p "$ROOT/prod/site-dist" "$ROOT/uat/site-dist"
cd "$ROOT/caddy"
docker compose --env-file .env up -d
docker compose --env-file .env exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || \
  docker compose --env-file .env restart caddy

# ---------- 7. verify ----------
log "Deploy complete — $ENV_NAME @ $COMMIT"
docker ps --format 'table {{.Names}}\t{{.Status}}' | head -20
echo
echo "Credentials on this box (root-only):"
echo "  $ENV_DIR/.admin-password        portal admin"
echo "  $ROOT/caddy/.preview-password   uat basic-auth"
