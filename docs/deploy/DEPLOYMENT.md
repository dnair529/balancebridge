# Balance Bridge — Deployment & Operations Runbook

Everything runs on **one Hostinger VPS** (IP `187.124.241.41`). Two fully isolated stacks — **UAT** and **production** — plus one shared Caddy reverse proxy that terminates TLS for all hostnames. Deploys are done by GitHub Actions over SSH; you never build anything on your laptop.

Sources: `infra/bootstrap.sh`, `infra/caddy/`, `infra/stack/docker-compose.yml`, `.github/workflows/*.yml`.

---

## 1. Architecture overview

- **Caddy** (`bb-caddy` compose project): the only thing listening on ports 80/443. Gets TLS certificates from Let's Encrypt automatically. Serves the static marketing site from disk and proxies portal/DocuSeal traffic into the right stack's Docker network.
- **Two identical stacks** (`bb-uat`, `bb-prod` compose projects), each with its own `.env`, its own Postgres, its own uploads volume, its own DocuSeal, and its own nightly backup container. They share nothing — a UAT mistake cannot touch production data.
- Postgres is **never exposed to the internet** — no host port; only containers on the same internal network can reach it.

```
                     Internet (80/443)
                            │
                    ┌───────▼────────┐
                    │  Caddy (TLS)   │  bb-caddy
                    │  Let's Encrypt │  serves /srv/balancebridge/{prod,uat}/site-dist
                    └──┬──────────┬──┘
        bb-prod network│          │bb-uat network
   ┌───────────────────▼──┐    ┌──▼───────────────────┐
   │ PROD stack (bb-prod) │    │ UAT stack (bb-uat)   │
   │  portal-prod :3000   │    │  portal-uat :3000    │
   │  docuseal-prod :3000 │    │  docuseal-uat :3000  │
   │  db-prod (pg16)      │    │  db-uat (pg16)       │
   │  backup-prod         │    │  backup-uat          │
   │  vols: pgdata,       │    │  vols: pgdata,       │
   │   uploads, docuseal  │    │   uploads, docuseal  │
   └──────────────────────┘    └──────────────────────┘

 Hostnames → what Caddy does with them
   balancebridge.us         → static site + /api/* → portal-prod
   www.balancebridge.us     → 301 → balancebridge.us
   portal.balancebridge.us  → portal-prod
   sign.balancebridge.us    → docuseal-prod
   uat.balancebridge.us     → static site (basic-auth) + /api/* → portal-uat
   portal-uat.balancebridge.us → portal-uat
   sign-uat.balancebridge.us   → docuseal-uat
```

All UAT hostnames send `X-Robots-Tag: noindex, nofollow`, and the UAT site is behind basic auth.

---

## 2. DNS at Hostinger

Create these records for `balancebridge.us` (Hostinger hPanel → Domains → DNS Zone). All are **A records** pointing at the VPS:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | `187.124.241.41` | 3600 |
| A | `www` | `187.124.241.41` | 3600 |
| A | `uat` | `187.124.241.41` | 3600 |
| A | `portal` | `187.124.241.41` | 3600 |
| A | `portal-uat` | `187.124.241.41` | 3600 |
| A | `sign` | `187.124.241.41` | 3600 |
| A | `sign-uat` | `187.124.241.41` | 3600 |

TTL guidance: 3600 (1 hour) is fine day-to-day. If you ever plan to move servers, drop TTL to 300 a day beforehand, move, then raise it back. **DNS must resolve before the first deploy** — Caddy can't obtain Let's Encrypt certificates for names that don't point at the box yet.

---

## 3. One-time VPS bootstrap

Run once, as **root**, on a fresh Ubuntu VPS. Either open **Hostinger hPanel → VPS → Browser Terminal**, or SSH in (`ssh root@187.124.241.41`).

```bash
# get the script onto the box (either copy-paste it into a file, or:)
git clone https://github.com/<your-org>/balancebridge.git /tmp/bb
bash /tmp/bb/infra/bootstrap.sh
```

What `infra/bootstrap.sh` does (safe to re-run; it skips anything that exists):

1. `apt upgrade` + installs ca-certificates, curl, git, **ufw**, **fail2ban**, unattended-upgrades, rsync.
2. Installs Docker (get.docker.com) if missing.
3. Firewall: deny all inbound except **22, 80, 443**.
4. SSH hardening: `PasswordAuthentication no`, `PermitRootLogin prohibit-password` (key-only).
5. Enables fail2ban and automatic security updates.
6. Creates the directory layout `/srv/balancebridge/{caddy,uat,prod}` (each stack gets `site-dist/` and `backups/`) and the external Docker networks `bb-uat` and `bb-prod`.
7. Generates `/srv/balancebridge/uat/.env` and `/srv/balancebridge/prod/.env` (chmod 600) with **random** `POSTGRES_PASSWORD`, `SESSION_PEPPER`, `DOCUSEAL_SECRET_KEY_BASE`, `DOCUSEAL_WEBHOOK_SECRET`, and `ADMIN_PASSWORD` — plus `CHANGE_ME` placeholders for Stripe and SMTP you fill in later. Also generates `/srv/balancebridge/caddy/.env` with the ACME email and a **UAT basic-auth password** (user `preview`).

**Passwords to save immediately** (they are printed once and live only in those files):

- `ADMIN_PASSWORD` from `/srv/balancebridge/prod/.env` and `/srv/balancebridge/uat/.env` — the portal admin seed password.
- The UAT preview password printed as `preview / <password>` (also stored as a comment in `/srv/balancebridge/caddy/.env`). You need it in the plain `user:pass` form for the `UAT_BASICAUTH` GitHub secret.

> **Two known gaps to fix while you're in the .env files:**
> 1. The generated `.env` sets `DOCUSEAL_URL=http://docuseal-<env>:3000` (internal Docker DNS). The portal uses `DOCUSEAL_URL` for the **browser-facing signing iframe and its CSP**, so signing pages will not load with the internal name. Set it to the public origin instead: `DOCUSEAL_URL=https://sign.balancebridge.us` (prod) / `https://sign-uat.balancebridge.us` (UAT).
> 2. The generated `.env` sets `FIRM_NOTIFY_EMAIL`, but the portal reads **`FIRM_INBOX`** (see `portal/src/config.ts`). Add `FIRM_INBOX=<your real inbox>` or lead alerts fall back to the default `hello@balancebridge.us`.

---

## 4. GitHub repository setup

**Branches**

- `main` → deploys to **production** (`.github/workflows/deploy-prod.yml`)
- `uat` → deploys to **UAT** (`.github/workflows/deploy-uat.yml`)
- `ci.yml` builds the site and type-checks the portal on every PR and push to either branch.

**Repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `VPS_HOST` | `187.124.241.41` |
| `VPS_USER` | the SSH user CI deploys as (e.g. `root`, or a dedicated deploy user with Docker access) |
| `VPS_SSH_KEY` | private key (ed25519) whose public half is in that user's `~/.ssh/authorized_keys` on the VPS |
| `UAT_BASICAUTH` | `preview:<uat-password>` — used by the UAT smoke test (`curl -u`) |

**Environments** (Settings → Environments):

- Create `uat` — no protection rules needed.
- Create `production` — add a **required reviewer** (you). Every push to `main` will then pause the deploy job until you click *Approve* in the Actions run. This is the production gate; don't skip it.

**What a deploy does** (both workflows, identical shape):

1. Build the Astro marketing site with the environment's `SITE_URL`.
2. `rsync` the site build to `/srv/balancebridge/<env>/site-dist/` and the repo to `/srv/balancebridge/<env>/repo/`.
3. Over SSH: copy `infra/stack/docker-compose.yml` into the env dir, `docker compose build portal`, `up -d --remove-orphans`, run DB migrations, then copy the Caddyfile + Caddy compose into `/srv/balancebridge/caddy/` and `up -d` + `caddy reload` (idempotent — first run starts Caddy, later runs just reload config).
4. Smoke test: site must return 200 and `…/healthz` must return 200, or the run fails.

---

## 5. Post-first-deploy configuration

Do these once after the first successful deploy of each environment (order below assumes prod; repeat with `-uat` names for UAT).

### 5.1 DocuSeal first boot

1. Open `https://sign.balancebridge.us` — DocuSeal shows its first-run setup. Create the admin account (use the firm email + a password manager entry).
2. In DocuSeal: **Settings → API** → copy the API key.
3. On the VPS, edit `/srv/balancebridge/prod/.env`: set `DOCUSEAL_API_KEY=<the key>` (replacing `CHANGE_ME_after_docuseal_first_boot`) and confirm `DOCUSEAL_URL` is the public origin (see gap #1 above).
4. In DocuSeal: **Settings → Webhooks** → add `https://portal.balancebridge.us/webhooks/docuseal`, and configure it to send the header `X-Docuseal-Secret: <DOCUSEAL_WEBHOOK_SECRET from the same .env>`. Enable the submission/form **completed** event.
5. Restart the portal to pick up the env change:
   `cd /srv/balancebridge/prod && docker compose --env-file .env up -d portal`

### 5.2 Stripe

1. In the Stripe dashboard, get the **secret key** (live mode for prod, test mode for UAT) and put it in the env file: `STRIPE_SECRET_KEY=sk_live_...`.
2. Developers → Webhooks → **Add endpoint**: `https://portal.balancebridge.us/webhooks/stripe`. Select exactly these events (the only ones the portal handles — see `portal/src/routes/webhooks.ts`):
   - `invoice.finalized`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `invoice.voided`
3. Copy the endpoint's **signing secret** into `STRIPE_WEBHOOK_SECRET=whsec_...`.
4. Restart the portal (same command as above).
5. For each client you bill: create the Customer in Stripe, paste its `cus_...` id into the client record in the portal admin, and use **Admin → Sync invoices** for the initial pull. New invoice activity arrives via webhook after that.

### 5.3 SMTP

Pick a transactional provider (Postmark, Resend, Amazon SES, Brevo — anything with SMTP). Set in the env file: `SMTP_HOST`, `SMTP_PORT` (587 STARTTLS, or 465 with `SMTP_SECURE=1`), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, and `FIRM_INBOX` (see gap #2). Also set up SPF/DKIM in DNS per your provider's instructions so invite and reset emails don't land in spam. Restart the portal. Until SMTP is configured the portal logs emails to the console instead of sending — fine for UAT, not for prod.

### 5.4 Seed the first real admin user

The Docker image runs migrations on boot but **not** the seed. Run it once per environment:

```bash
cd /srv/balancebridge/prod
docker compose --env-file .env exec -T portal node dist/db/seed.js
```

It idempotently creates the admin user from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in the env file (bootstrap set `ADMIN_EMAIL=deepak529@gmail.com` and a random password — that's what you log in with). On UAT, `SEED_DEMO=1` also creates the demo client "Lonestar Coffee Co." with sample data.

First login: go to `https://portal.balancebridge.us`, sign in, **immediately enable two-step verification** in Settings, then invite real staff/clients from Admin → Invites.

---

## 6. UAT → production promotion flow

1. All work merges to the **`uat`** branch (PRs run CI). Push → automatic UAT deploy.
2. Test on `https://uat.balancebridge.us` (basic auth: `preview / <password>`) and `https://portal-uat.balancebridge.us`. UAT has demo data and test-mode Stripe.
3. When it's signed off: open a PR **`uat` → `main`**, merge it.
4. The production workflow starts and **waits for your approval** (the `production` environment's required reviewer). Approve in the Actions tab.
5. The workflow deploys and smoke-tests `https://balancebridge.us/` and `https://portal.balancebridge.us/healthz`. A failed smoke test fails the run — check it before walking away.

---

## 7. Rollback

Two options, in order of preference:

**A. Re-run a previous good workflow run.** GitHub → Actions → *Deploy Production* → pick the last green run → **Re-run all jobs**. It rebuilds and redeploys that commit exactly. (Approval gate applies again.)

**B. Git revert.** `git revert <bad-commit>` (or revert the merge commit) on `main`, push — that triggers a fresh deploy of the reverted state. Prefer revert over force-push so history stays honest.

Notes:
- Database migrations are forward-only. If a bad release included a migration, rolling back the code usually still works (old code ignores new columns), but check `portal/drizzle/` for what changed before assuming.
- Deploys don't touch data: Postgres and uploads live in named Docker volumes and survive rebuilds.

---

## 8. Backups

**What runs automatically:** each stack has a `backup` container (see `infra/stack/docker-compose.yml`) that wakes at **03:15 UTC nightly** and writes to `/srv/balancebridge/<env>/backups/`:

- `portal-<timestamp>.sql.gz` — `pg_dump` of the portal database
- `docuseal-<timestamp>.sql.gz` — `pg_dump` of the DocuSeal database
- `uploads-<timestamp>.tar.gz` — tarball of the uploads volume

Files older than **14 days** are deleted automatically.

### Restore, step by step

```bash
# 0. Stop the app so nothing writes during restore
cd /srv/balancebridge/prod
docker compose --env-file .env stop portal docuseal

# 1. Restore the portal database (plain-SQL dump → psql)
gunzip -c backups/portal-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose --env-file .env exec -T db psql -U portal -d portal

# If you need a clean slate first:
#   docker compose --env-file .env exec -T db psql -U portal -d postgres \
#     -c "DROP DATABASE portal;" -c "CREATE DATABASE portal;"
# then run the gunzip|psql line.

# 2. Restore DocuSeal's database the same way
gunzip -c backups/docuseal-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose --env-file .env exec -T db psql -U portal -d docuseal

# 3. Restore uploads into the volume (tar was created with -C /data uploads)
docker run --rm \
  -v bb-prod_uploads:/data/uploads \
  -v /srv/balancebridge/prod/backups:/backups:ro \
  alpine sh -c "cd /data && rm -rf uploads/* && tar xzf /backups/uploads-YYYYMMDD-HHMMSS.tar.gz"

# 4. Start everything and verify
docker compose --env-file .env up -d
curl -fsS https://portal.balancebridge.us/healthz
```

(The dumps are plain SQL, so `psql` is the restore tool; `pg_restore` is only for custom-format dumps.)

### Copy backups off the box

On-box backups don't survive a dead VPS. Two layers:

1. **Hostinger VPS snapshots** — hPanel → VPS → Snapshots & Backups. Enable the automatic weekly backup (or take a manual snapshot before risky changes). This captures the whole disk, including volumes.
2. **Optional but recommended — rclone to Backblaze B2** (or any S3-compatible bucket):
   ```bash
   apt-get install -y rclone
   rclone config          # create remote "b2" with your B2 key
   crontab -e             # add:
   30 4 * * * rclone sync /srv/balancebridge/prod/backups b2:bb-backups/prod --min-age 1h -q
   35 4 * * * rclone sync /srv/balancebridge/uat/backups  b2:bb-backups/uat  --min-age 1h -q
   ```
   That's an off-site copy of every nightly dump for pennies a month. Test a restore from B2 once — a backup you've never restored is a hope, not a backup.

---

## 9. Monitoring

- **UptimeRobot (free tier):** add HTTP(S) monitors for
  - `https://balancebridge.us/` (expect 200)
  - `https://portal.balancebridge.us/healthz` (expect 200 — this one also proves the database is up)
  - optionally `https://sign.balancebridge.us/` and the UAT portal `/healthz`.
  Alert to your phone/email. 5-minute checks are plenty.
- **Logs:** `docker logs -f portal-prod` (portal, structured JSON via pino), `docker logs caddy` from `/srv/balancebridge/caddy`, `docker logs db-prod`. The portal redacts cookies/auth headers from logs.
- **Container health:** `docker ps` shows the portal's built-in `HEALTHCHECK` status (`healthy`/`unhealthy`).
- **Disk hygiene:** old images pile up because every deploy rebuilds the portal. Weekly:
  ```bash
  docker system prune -f
  ```
  (add it to root's crontab: `0 5 * * 0 docker system prune -f`). Keep an eye on `df -h` — backups + Docker images are the usual disk eaters.

---

## 10. Security notes

- **What bootstrap hardened:** ufw (only 22/80/443 in), fail2ban on SSH, key-only SSH (`PasswordAuthentication no`, root by key only), unattended security upgrades.
- **Secrets live only in `/srv/balancebridge/{caddy,uat,prod}/.env`**, all `chmod 600`, never in git and never in GitHub. The repo's `portal/.env.example` documents the shape; the deploy pipeline never writes secrets.
- Postgres has no published port; portal and DocuSeal are reachable only through Caddy.
- The portal container runs as a non-root user and only Caddy terminates TLS.
- Rotating `SESSION_PEPPER` in an env file signs every user out and voids outstanding invite/reset links — it's the "revoke everything" lever after a suspected compromise (restart the portal after changing it).
- GitHub `production` environment approval is part of the security posture: nobody — including CI — changes prod without a human click.
