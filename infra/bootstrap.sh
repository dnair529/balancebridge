#!/usr/bin/env bash
# Balance Bridge VPS bootstrap — run ONCE as root on a fresh Ubuntu Hostinger VPS.
# Usage: bash bootstrap.sh
set -euo pipefail

echo "==> [1/7] System update + essentials"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q && apt-get upgrade -y -q
apt-get install -y -q ca-certificates curl git ufw fail2ban unattended-upgrades rsync

echo "==> [2/7] Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> [3/7] Firewall (SSH, HTTP, HTTPS only)"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> [4/7] SSH hardening (key-only auth)"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl reload ssh || systemctl reload sshd

echo "==> [5/7] fail2ban + auto security updates"
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> [6/7] Directory layout + docker networks"
mkdir -p /srv/balancebridge/{caddy,uat,prod}/ /srv/balancebridge/uat/{site-dist,backups} /srv/balancebridge/prod/{site-dist,backups}
docker network inspect bb-uat >/dev/null 2>&1 || docker network create bb-uat
docker network inspect bb-prod >/dev/null 2>&1 || docker network create bb-prod

echo "==> [7/7] Generate secrets templates (fill in and keep OFF git)"
gen() { openssl rand -base64 48 | tr -d '/+=' | head -c "$1"; }
for env in uat prod; do
  f="/srv/balancebridge/$env/.env"
  if [[ ! -f "$f" ]]; then
    cat > "$f" <<EOF
ENV_NAME=$env
POSTGRES_PASSWORD=$(gen 32)
SESSION_PEPPER=$(gen 48)
DOCUSEAL_SECRET_KEY_BASE=$(gen 64)
DOCUSEAL_PUBLIC_HOST=$([[ $env == prod ]] && echo sign.balancebridge.us || echo sign-uat.balancebridge.us)
DOCUSEAL_URL=http://docuseal-$env:3000
DOCUSEAL_API_KEY=CHANGE_ME_after_docuseal_first_boot
DOCUSEAL_WEBHOOK_SECRET=$(gen 32)
SITE_URL=$([[ $env == prod ]] && echo https://balancebridge.us || echo https://uat.balancebridge.us)
PORTAL_URL=$([[ $env == prod ]] && echo https://portal.balancebridge.us || echo https://portal-uat.balancebridge.us)
ADMIN_EMAIL=deepak529@gmail.com
ADMIN_PASSWORD=$(gen 20)
STRIPE_SECRET_KEY=CHANGE_ME
STRIPE_WEBHOOK_SECRET=CHANGE_ME
SMTP_HOST=CHANGE_ME
SMTP_PORT=587
SMTP_USER=CHANGE_ME
SMTP_PASS=CHANGE_ME
MAIL_FROM="Balance Bridge <hello@balancebridge.us>"
FIRM_NOTIFY_EMAIL=deepak529@gmail.com
SEED_DEMO=$([[ $env == uat ]] && echo 1 || echo 0)
COOKIE_SECURE=1
EOF
    chmod 600 "$f"
    echo "    created $f (ADMIN_PASSWORD inside — save it)"
  fi
done

if [[ ! -f /srv/balancebridge/caddy/.env ]]; then
  UAT_PASS=$(gen 16)
  HASH=$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$UAT_PASS")
  cat > /srv/balancebridge/caddy/.env <<EOF
ACME_EMAIL=deepak529@gmail.com
UAT_BASICAUTH_USER=preview
UAT_BASICAUTH_HASH=$HASH
# UAT preview password (plaintext, for your reference): $UAT_PASS
EOF
  chmod 600 /srv/balancebridge/caddy/.env
  echo "    created caddy/.env — UAT preview login: preview / $UAT_PASS"
fi

echo ""
echo "Bootstrap complete. Next: CI deploys will rsync the repo + site build and run docker compose."
echo "Remember to save the generated passwords printed above."
