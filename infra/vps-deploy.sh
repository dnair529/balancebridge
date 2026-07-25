#!/usr/bin/env bash
# Balance Bridge — VPS deploy. Idempotent: this is the deploy command, run it every time.
#
#   bash vps-deploy.sh uat     # uat branch  -> uat.balancebridge.us
#   bash vps-deploy.sh prod    # main branch -> balancebridge.us + www
#
# This box ALREADY runs Traefik (n8n-traefik-1) on :80/:443 plus ~18 other
# containers. This script deliberately does NOT:
#   * publish any host port      * install/modify a reverse proxy
#   * touch ufw or sshd          * change any pre-existing container
# It attaches to the existing `n8n_default` network and routes via Traefik labels.
set -euo pipefail

ENV_NAME="${1:-}"
[[ "$ENV_NAME" == "uat" || "$ENV_NAME" == "prod" ]] || { echo "usage: $0 uat|prod"; exit 1; }
BRANCH=$([[ "$ENV_NAME" == "prod" ]] && echo main || echo uat)
ROOT=/srv/balancebridge
ENV_DIR="$ROOT/$ENV_NAME"
# SSH deploy key (read-only) lives at /root/.ssh/gh_bb — no token is stored on this box
REPO_URL=git@github.com:dnair529/balancebridge.git
EDGE_NET=n8n_default

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31mFATAL: %s\033[0m\n' "$*"; exit 1; }

# ---------- 0. preflight: never run if the edge network or Traefik is missing ----------
docker network inspect "$EDGE_NET" >/dev/null 2>&1 || die "network '$EDGE_NET' not found — is Traefik still running?"
docker ps --format '{{.Names}}' | grep -q traefik || die "no Traefik container running — refusing to deploy"

mkdir -p "$ENV_DIR"/{site-dist,backups}

# ---------- 1. secrets (generated once, never overwritten) ----------
gen() { openssl rand -base64 48 | tr -d '/+=' | head -c "$1"; }

if [[ "$ENV_NAME" == "prod" ]]; then
  SITE_HOST=balancebridge.us;      PORTAL_HOST=portal.balancebridge.us;      SIGN_HOST=sign.balancebridge.us
  SITE_RULE="Host(\`balancebridge.us\`) || Host(\`www.balancebridge.us\`)"
else
  SITE_HOST=uat.balancebridge.us;  PORTAL_HOST=portal-uat.balancebridge.us;  SIGN_HOST=sign-uat.balancebridge.us
  SITE_RULE="Host(\`uat.balancebridge.us\`)"
fi

if [[ ! -f "$ENV_DIR/.env" ]]; then
  log "Generating $ENV_NAME secrets (first run)"
  ADMIN_PW=$(gen 20)
  cat > "$ENV_DIR/.env" <<EOF
ENV_NAME=$ENV_NAME
POSTGRES_PASSWORD=$(gen 32)
SESSION_PEPPER=$(gen 48)
DOCUSEAL_SECRET_KEY_BASE=$(gen 64)
DOCUSEAL_PUBLIC_HOST=$SIGN_HOST
DOCUSEAL_URL=https://$SIGN_HOST
DOCUSEAL_API_KEY=
DOCUSEAL_WEBHOOK_SECRET=$(gen 32)
SITE_URL=https://$SITE_HOST
PORTAL_URL=https://$PORTAL_HOST
PORTAL_HOST=$PORTAL_HOST
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
  printf '%s\n' "$ADMIN_PW" > "$ENV_DIR/.admin-password"; chmod 600 "$ENV_DIR/.admin-password"
  echo "    portal admin: deepak529@gmail.com / $ADMIN_PW"
fi

# UAT sits behind Traefik basic-auth + noindex so it can't be crawled or browsed publicly.
if [[ "$ENV_NAME" == "uat" && ! -f "$ENV_DIR/.preview-password" ]]; then
  PREVIEW_PW=$(gen 16)
  printf '%s\n' "$PREVIEW_PW" > "$ENV_DIR/.preview-password"; chmod 600 "$ENV_DIR/.preview-password"
  HTPASSWD=$(docker run --rm httpd:2-alpine htpasswd -nbB preview "$PREVIEW_PW" | tr -d '\n')
  # '$' must be doubled so compose does not treat it as interpolation
  printf 'UAT_BASICAUTH=%s\n' "${HTPASSWD//$/$$}" >> "$ENV_DIR/.env"
  echo "    uat preview login: preview / $PREVIEW_PW"
fi

# Router wiring differs per env; keep it out of the committed compose file.
{
  echo "SITE_RULE=$SITE_RULE"
  if [[ "$ENV_NAME" == "uat" ]]; then
    echo "SITE_MIDDLEWARES=bb-uatauth-uat@docker,bb-noindex-uat@docker"
  else
    echo "SITE_MIDDLEWARES=bb-noindex-prod@docker"
  fi
} > "$ENV_DIR/.env.routing"

# ---------- 2. source ----------
log "Fetching $BRANCH"
[[ -f /root/.ssh/gh_bb ]] || die "missing /root/.ssh/gh_bb deploy key"
if [[ -d "$ENV_DIR/repo/.git" ]]; then
  git -C "$ENV_DIR/repo" fetch origin "$BRANCH" --depth 1
  git -C "$ENV_DIR/repo" reset --hard "origin/$BRANCH"
  git -C "$ENV_DIR/repo" clean -fd
else
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$ENV_DIR/repo"
fi
COMMIT=$(git -C "$ENV_DIR/repo" rev-parse --short HEAD)

# ---------- 3. build the static site (inside a container — nothing installed on the host) ----------
log "Building marketing site @ $COMMIT"
docker run --rm -v "$ENV_DIR/repo/site":/app -w /app \
  -e SITE_URL="https://$SITE_HOST" -e npm_config_update_notifier=false \
  node:22-alpine sh -c 'npm ci --no-fund --no-audit --loglevel=error && npm run build' \
  || die "site build failed"

rm -rf "$ENV_DIR/site-dist.prev"
[[ -d "$ENV_DIR/site-dist" ]] && mv "$ENV_DIR/site-dist" "$ENV_DIR/site-dist.prev"
cp -r "$ENV_DIR/repo/site/dist" "$ENV_DIR/site-dist"
cp "$ENV_DIR/repo/infra/stack/site-nginx.conf" "$ENV_DIR/site-nginx.conf"
cp "$ENV_DIR/repo/infra/stack/docker-compose.yml" "$ENV_DIR/docker-compose.yml"

# ---------- 4. bring up the stack ----------
log "Starting bb-$ENV_NAME"
cd "$ENV_DIR"
DC="docker compose --env-file .env --env-file .env.routing"

# UAT basic-auth middleware is defined as a label on the site container
if [[ "$ENV_NAME" == "uat" ]]; then
  cat > docker-compose.override.yml <<'OVR'
services:
  site:
    labels:
      traefik.http.middlewares.bb-uatauth-uat.basicauth.users: ${UAT_BASICAUTH}
      traefik.http.middlewares.bb-uatauth-uat.basicauth.realm: Balance Bridge UAT
OVR
else
  rm -f docker-compose.override.yml
fi

$DC build portal
$DC up -d --remove-orphans

log "Waiting for database"
for i in $(seq 1 30); do
  $DC exec -T db pg_isready -U portal -d portal >/dev/null 2>&1 && break
  sleep 2
done

# DocuSeal needs its own database inside the same postgres instance
$DC exec -T db psql -U portal -d portal -tc "SELECT 1 FROM pg_database WHERE datname='docuseal'" \
  | grep -q 1 || $DC exec -T db createdb -U portal docuseal

log "Running migrations"
$DC exec -T portal node dist/db/migrate.js || die "migration failed"
if [[ "$(grep -c '^SEED_DEMO=1' .env || true)" != "0" ]]; then
  $DC exec -T portal node dist/db/seed.js || echo "    (seed skipped — probably already seeded)"
fi

# ---------- 5. verify ----------
log "Deployed $ENV_NAME @ $COMMIT"
docker ps --filter "name=bb-" --format 'table {{.Names}}\t{{.Status}}'
echo
echo "  site   https://$SITE_HOST"
echo "  portal https://$PORTAL_HOST"
echo "  sign   https://$SIGN_HOST"
echo
echo "Credentials (root-only files on this box):"
echo "  $ENV_DIR/.admin-password"
[[ "$ENV_NAME" == "uat" ]] && echo "  $ENV_DIR/.preview-password"
echo
echo "Existing services untouched:"
docker ps --format '{{.Names}}' | grep -v '^bb-' | tr '\n' ' '; echo
