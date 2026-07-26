# Balance Bridge — Security

How the portal protects client financial records, what is actually implemented today, and what is still missing before real client books live in it.

Sources: `portal/src/lib/crypto.ts`, `portal/src/lib/storage.ts`, `portal/src/lib/retention.ts`, `portal/src/lib/mfa-policy.ts`, `portal/src/db/rls.sql`, `portal/src/db/apply-rls.ts`, `infra/backup.sh`, `docs/architecture/PORTAL-SPEC.md` §"Security requirements".

---

## 1. Threat model

What we hold: bank statements, payroll files, tax documents, transaction ledgers, and the identity of every client's business. Nothing here is card data (Stripe holds that) and nothing is medical. The realistic adversaries, in rough order of likelihood:

| # | Threat | Realistic path | Primary control |
|---|--------|----------------|-----------------|
| T1 | Credential theft on a **client** account | phishing, password reuse | argon2id, invite-only accounts, login rate limit, optional TOTP, server-side `client_id` scoping |
| T2 | Credential theft on a **staff/admin** account | same, but the blast radius is *every* client | **mandatory TOTP for staff/admin** (`REQUIRE_STAFF_MFA`), audit log, session revocation |
| T3 | A scoping bug in a new route leaks another client's data | one forgotten `where client_id = …` | `resolveClientId()` choke point **plus** Postgres row-level security as a second, independent check |
| T4 | Host / disk compromise, stolen VPS image, provider snapshot | attacker reads the uploads volume directly | **AES-256-GCM envelope encryption at rest**; files on disk are opaque without `FILE_ENCRYPTION_KEY` |
| T5 | Backup exposure | dumps sitting in plaintext next to the database | encrypted, off-box backups (`infra/backup.sh`) |
| T6 | Ransomware / accidental destruction | attacker or operator deletes the volume | off-box copies in a different failure domain, 90-day remote retention, `--verify` restore drills |
| T7 | Data hoarding | we keep everything forever, so every breach is maximal | retention windows with an automated purge |
| T8 | Web attacks (CSRF, XSS, path traversal, upload abuse) | any browser | double-submit CSRF, server-rendered templates, uuid-only file names, extension allowlist + 25MB cap, `nosniff` + `attachment` downloads, CSP/HSTS at the proxy |
| T9 | Webhook forgery | anyone who can POST | Stripe signature verification, DocuSeal shared-secret header, idempotent handlers |

**Explicitly out of scope.** An attacker who can execute arbitrary SQL on the application's database connection, or arbitrary code in the portal container, defeats RLS (they can call `app.set_context('admin', …)`) and can read the file encryption key from the process environment. RLS and at-rest encryption defend against *scoping bugs* and *offline data access*, not against code execution. Reducing that blast radius is a pen-test / hardening question, not a config question.

---

## 2. What is implemented

### Already in place (spec §"Security requirements")

- **Auth** — argon2id (19 MiB / t=2 / p=1), invite-only account creation, TOTP (RFC 6238, ±1 step), 10 logins / 15 min per IP+email, constant-time token compare, dummy-hash verify so a bad email and a bad password take the same time.
- **Sessions** — 256-bit random token, only `sha256(token + SESSION_PEPPER)` stored, `__Host-session` cookie (httpOnly / Secure / SameSite=Lax), 24 h idle + 14 d absolute lifetime, server-side revocation, rotation on login and privilege change.
- **CSRF** — double-submit token on every state-changing post, including a manual check inside the multipart upload handler (the global hook cannot read multipart bodies).
- **Access control** — `resolveClientId()` in `src/auth/guards.ts` is the single choke point; a `client` user's scope always comes from their session row, never from a request parameter.
- **Files** — stored outside the web root under a random uuid, original name only in the DB, extension allowlist, 25 MB cap, sha256 recorded, authenticated streaming download with `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`.
- **Audit log** — append-only record of logins, file and message activity, and admin actions. No application code updates or deletes it.
- **Secrets** — environment only, `.env` never committed, fail-fast zod validation at boot with hard refusals for dev placeholders in production.
- **Transport** — TLS via Traefik/Let's Encrypt, HSTS, `X-Frame-Options: DENY`, nosniff, strict referrer policy. Postgres publishes no host port.

### Added in this hardening pass

| Control | Where | What it does |
|---|---|---|
| **Envelope encryption at rest** | `src/lib/crypto.ts`, wired into `src/lib/storage.ts` | Every uploaded byte is AES-256-GCM encrypted before it touches the disk. Per-file random data key (DEK), wrapped by a master key (KEK) from `FILE_ENCRYPTION_KEY`. Streaming both directions, so a 25 MB upload never buffers. |
| **Key rotation support** | same | `FILE_ENCRYPTION_KEY_PREVIOUS` stays readable during a rotation window; a 4-byte key id in each file header says which KEK sealed it. `reencryptStored()` rewraps files in place. |
| **Row-level security** | `src/db/rls.sql`, `src/db/apply-rls.ts`, applied by `src/db/migrate.ts` | 22 client-scoped tables get an RLS policy keyed off `app.current_client_id` / `app.current_role_name`. Staff/admin/service bypass; a `client` sees only its own rows; an unset GUC sees **nothing**. |
| **Restricted DB role** | `app.ensure_app_role()` in `rls.sql` | Creates `portal_app`: `NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`, DML-only, and **no UPDATE/DELETE/TRUNCATE on `audit_log`** — append-only enforced by grants, not just convention. |
| **Mandatory staff MFA** | `src/lib/mfa-policy.ts` | `mfaRequired(user)` and the `enforceMfaSetup` preHandler. Not wired into routes yet (see §7). |
| **Retention + purge** | `src/lib/retention.ts` | Windowed deletion with a dry-run default and a per-bucket report. Purging quarantined intake items removes their encrypted blobs too. |
| **Encrypted off-box backups** | `infra/backup.sh` | pg_dump (custom format) of both databases + the uploads volume, piped straight through `openssl enc`, shipped to S3-compatible storage with `rclone`. 14-day local / 90-day remote retention, `--verify` restore drill. |

**Two independent layers on files.** A document in a backup tarball is protected by the backup passphrase *and* by `FILE_ENCRYPTION_KEY`. Compromising the backup bucket alone yields nothing readable.

---

## 3. File encryption: format and key management

### On-disk format (97 bytes of overhead)

```
off  len  field
  0    4  magic "BBE1"
  4    1  format version (0x01)
  5    4  key id — sha256("bbfk1" || KEK)[0..4)
  9   12  wrap IV        \
 21   16  wrap auth tag   } the DEK, sealed under the KEK
 37   32  wrapped DEK    /
 69   12  data IV
        ── the 81-byte header above is used verbatim as GCM AAD ──
 81    n  ciphertext (AES-256-GCM)
81+n  16  data auth tag  (trailing, so encryption can stream)
```

The recorded `sha256` and `size_bytes` in `documents` describe the **plaintext**, so integrity records survive a key rotation and `Content-Length` on the download route stays correct.

Files written before this change are still plaintext on disk. Reads sniff the magic bytes and pass those through untouched; `reencryptStored(storedName)` upgrades them.

### Generating a key

```bash
openssl rand -base64 32
# or, from the built app:
node -e "import('./dist/lib/crypto.js').then(m => console.log(m.generateKey()))"
```

Set it as `FILE_ENCRYPTION_KEY`. **Production refuses to boot** without it, or with the published dev placeholder. Store a copy in the password manager — *not only on the VPS*. Losing this key destroys every uploaded document, permanently and unrecoverably; no backup helps, because the backups contain the same ciphertext.

### Rotation procedure

Rotate annually, and immediately on any suspicion of key exposure (leaked `.env`, departed operator with prod access, restored snapshot handed to a third party).

1. Generate a new key: `NEW=$(openssl rand -base64 32)`.
2. In the environment file: `FILE_ENCRYPTION_KEY_PREVIOUS=<the old key>`, `FILE_ENCRYPTION_KEY=$NEW`.
3. Restart the portal. New uploads seal under the new key; old files still open under the previous one. **No downtime, no re-encryption needed yet.**
4. Rewrap the backlog. For each `stored_name` in `documents` (and every non-null `intake_items.storage_key`), call `reencryptStored(storedName)` — it writes to a temp file and renames, so a crash cannot destroy an original. Files already on the current key are skipped.
5. Confirm nothing is left on the old key, then remove `FILE_ENCRYPTION_KEY_PREVIOUS` and restart. The app refuses to start if the previous key equals the current one, so a half-finished rotation is visible.
6. Take a fresh backup and run `backup.sh <env> --verify`.

Rotating `SESSION_PEPPER` is separate and instantly revokes every session and outstanding emailed token — do it on any suspected session-store compromise.

---

## 4. Row-level security

RLS is **defense in depth behind** the application's own scoping, never a replacement for it. `resolveClientId()` remains the primary control; RLS exists so that one forgotten `where client_id = …` in a future route cannot leak another client's books.

Policy logic (`src/db/rls.sql`):

- `app.current_role_name` = `staff` | `admin` | `service` → unrestricted.
- `app.current_role_name` = `client` → only rows matching `app.current_client_id`.
- GUC unset or malformed → **no rows**. Fails closed, deliberately.

`messages` and `tasks` carry no `client_id`; their policies reach it through `threads` / `task_lists`. `intake_items.client_id IS NULL` (unresolved sender) and `categorization_rules.client_id IS NULL` (firm-wide default) are therefore staff-only, which is intended.

Not under RLS, on purpose: `users`, `sessions`, `invites`, `password_resets` (the auth path must read them *before* any client context exists — a GUC set after login is circular), `audit_log` (cross-client by design, protected by append-only grants), `leads` (pre-client, staff-only at the app layer), and tables only reachable through a policed parent.

### Rollout — read this before switching `DATABASE_URL`

**Phase 1 (done, active now).** `migrate.ts` applies `rls.sql` on every boot, so a newly added table can never sit unpoliced. The role `portal_app` is created. The app still connects as the database **owner**, and a table owner is exempt from RLS unless the table is `FORCE`d — so the policies are inert and nothing can break.

**Phase 2 (required before real client data).** The policies fail closed, so they only work once something sets the GUCs. That needs a per-request hook on a dedicated connection, which lives in code owned by the routes/db author:

```ts
// after the session is resolved, on a checked-out client (not the pool):
await client.query('SELECT app.set_context($1, $2)', [user.role, resolveClientId(req)]);
// …run the request's queries on that same client…
await client.query('SELECT app.reset_context()');
```

Then, and only then:

```bash
# in the stack .env
ADMIN_DATABASE_URL=postgres://portal:<owner-pw>@db:5432/portal      # migrations + RLS DDL
DATABASE_URL=postgres://portal_app:<app-pw>@db:5432/portal          # the app itself
APP_DB_PASSWORD=<app-pw>                                            # so apply-rls sets it
```

Switching `DATABASE_URL` **before** that hook exists will break every request with zero rows returned. That is the intended failure mode, but it is still an outage.

Verify at any time:

```sql
SELECT relname, relrowsecurity FROM pg_class
 WHERE relnamespace = 'public'::regnamespace AND relrowsecurity;
```

---

## 5. Backup and restore runbook

`infra/backup.sh` replaces the same-disk backup loop in `docker-compose.tpl.yml`, which protected against exactly one failure mode (a bad `DELETE`) and none of the ones that end firms: disk failure, VPS loss, ransomware, or a stolen disk image — in all of which the data and its "backup" die together, in plaintext.

### Setup (once per environment)

```bash
# 1. rclone: one static binary, configured entirely from env vars
curl https://rclone.org/install.sh | sudo bash

# 2. credentials, root-only
sudo install -m 600 /dev/null /srv/balancebridge/prod/.env.backup
sudo tee /srv/balancebridge/prod/.env.backup >/dev/null <<'EOF'
BACKUP_PASSPHRASE=<openssl rand -base64 48>
BACKUP_REMOTE=bb:balancebridge-backups
RCLONE_CONFIG_BB_TYPE=s3
RCLONE_CONFIG_BB_PROVIDER=Other
RCLONE_CONFIG_BB_ACCESS_KEY_ID=...
RCLONE_CONFIG_BB_SECRET_ACCESS_KEY=...
RCLONE_CONFIG_BB_ENDPOINT=https://s3.example-provider.com
RCLONE_CONFIG_BB_REGION=us-east-1
EOF

# 3. cron (root)
15 3 * * *  bash /srv/balancebridge/prod/repo/infra/backup.sh prod          >> /var/log/bb-backup.log 2>&1
30 4 * * 0  bash /srv/balancebridge/prod/repo/infra/backup.sh prod --verify >> /var/log/bb-backup.log 2>&1
```

Use a bucket key scoped to **write + list only** where the provider allows it, so a compromised VPS cannot delete history. Enable object versioning / object lock if available.

`BACKUP_PASSPHRASE` goes in the password manager alongside `FILE_ENCRYPTION_KEY`. Both are needed to read a document out of a backup; neither alone is enough.

### What a backup set contains

`<remote>/<env>/<UTC timestamp>/` with `portal.dump.enc`, `docuseal.dump.enc`, `uploads.tar.gz.enc`, `MANIFEST.sha256`, and `META`. Dumps are `pg_dump -Fc` (custom format) — the only format `pg_restore --list` can parse, which is what makes `--verify` a real check rather than a file-size check.

### Weekly verification

```bash
bash infra/backup.sh prod --verify
```

Downloads the newest remote set, checks every file against `MANIFEST.sha256`, decrypts, parses the TOC with `pg_restore --list`, and lists the uploads tarball. Exits non-zero on any failure. **A backup nobody has restored is a hope, not a control** — run this, and read the log.

### Restore

```bash
# 0. get the set
rclone copy bb:balancebridge-backups/prod/20260726-031500Z ./restore

# 1. decrypt (openssl prompts nothing; pass the passphrase via env)
export BACKUP_PASSPHRASE='…'
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE \
  < restore/portal.dump.enc > restore/portal.dump
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass env:BACKUP_PASSPHRASE \
  < restore/uploads.tar.gz.enc > restore/uploads.tar.gz

# 2. database — into a NEW database first; never restore over a live one
docker compose exec -T db createdb -U portal portal_restore
docker compose exec -T db pg_restore -U portal -d portal_restore --no-owner < restore/portal.dump

# 3. uploads volume
docker run --rm -v bb-prod_uploads:/data -v "$PWD/restore":/r:ro \
  postgres:16-alpine tar xzf /r/uploads.tar.gz -C /data

# 4. the portal needs the SAME FILE_ENCRYPTION_KEY (or the key those files were
#    sealed with, as FILE_ENCRYPTION_KEY_PREVIOUS) or every download fails.

# 5. swap databases only after spot-checking portal_restore, then re-run migrations
#    so RLS policies are applied to the restored database.
```

Recovery objectives today: **RPO ≈ 24 h** (nightly backup), **RTO ≈ 1–2 h** (manual restore onto a fresh VPS). If that RPO is too loose for real client books, the next step is WAL archiving for point-in-time recovery — not a second nightly job.

---

## 6. Retention policy

`portal/src/lib/retention.ts`. Dry run by default; `--apply` deletes.

| Data | Window | Rule |
|---|---|---|
| `sessions` | 90 d | revoked or expired for longer than the window. Live sessions untouched. |
| `audit_log` | **7 years (2555 d)** | financial record. Hard floor: a shorter value is rejected by config parsing *and* re-checked inside the purge. Append-only — nothing younger than the window is ever eligible. |
| `leads` | 2 years | **unhandled only** (`handled_at IS NULL`). Handled leads are kept; they became clients. |
| `intake_items` (quarantined) | 180 d | plus their encrypted blobs, dependent extractions, and match rows. |
| `outbound_messages` | 2 years | the `audit_log` record of the send survives. |

Each window is overridable via `RETENTION_*_DAYS`. Every run returns a per-bucket report (matched / deleted / blobs / errors) and caps at 20 000 rows per bucket per run.

```bash
node dist/lib/retention.js            # report only
node dist/lib/retention.js --apply    # delete
# weekly cron; audit purges need ADMIN_DATABASE_URL-grade credentials because
# portal_app deliberately cannot DELETE from audit_log.
```

Client documents are **not** on a retention schedule: they are the client's own records and are only removed on request (soft delete today). Decide a hard-delete policy for offboarded clients before the first client leaves.

---

## 7. Outstanding before real client data

Ordered by what would hurt most if skipped.

1. **Wire `enforceMfaSetup` into the route chain.** The policy module exists and is tested; nothing calls it yet. One line in `src/server.ts` (`app.addHook('preHandler', enforceMfaSetup)`) plus a `GET /settings/mfa-required` page. Until then, `REQUIRE_STAFF_MFA` is documentation, not enforcement. *(Routes are owned by another author — deliberately not wired here.)*
2. **Phase 2 of RLS** (§4): the per-request GUC hook, then `DATABASE_URL` → `portal_app`. Until then the policies are correct but inert.
3. **Disk-level encryption on the VPS.** Uploads are encrypted; the *database* is not. Transaction amounts, counterparties, client names, message bodies and audit trails sit in plaintext in the Postgres volume. A stolen disk image reads all of it. LUKS on the data partition, or a provider-encrypted volume, closes this. This is the largest remaining at-rest gap.
4. **Re-encrypt legacy uploads.** Files stored before this change are still plaintext on disk. Run `reencryptStored()` across `documents.stored_name` once, and verify no file lacks the `BBE1` magic.
5. **Off-site key escrow.** `FILE_ENCRYPTION_KEY`, `BACKUP_PASSPHRASE`, `SESSION_PEPPER` and the DB passwords currently live in `.env` on one VPS and in one operator's head. Two-person recovery, or at minimum a sealed copy in a separate password manager, before the bus factor matters.
6. **Restore drill on a clean host.** `--verify` proves the archive parses. It does not prove *we* can stand the service back up under pressure. Do it once end to end and time it; that number is the real RTO.
7. **Penetration test** by someone who did not write this. Priorities: authenticated IDOR across `client_id`, the multipart upload path, session fixation on the TOTP step, and the webhook endpoints.
8. **SOC2-style access reviews.** Quarterly: who holds staff/admin accounts, who has SSH to the VPS, who can read the backup bucket, who is in the password manager. Offboarding checklist that revokes all four and rotates what the departing person could read.
9. **Alerting on the security signals we already collect.** Failed-login spikes, `audit_log` gaps, backup job failures, retention errors — all logged, none alerting.
10. **Sub-processor and incident policy.** Written breach-notification procedure (who, within how long), plus a documented list of who touches client data: Stripe, DocuSeal (self-hosted), the SMTP provider, the backup bucket provider, and any AI provider once `AI_PROVIDER` moves off `stub`.
11. **Content Security Policy audit.** Headers are set at the proxy; confirm no inline script survives without a nonce, especially on the DocuSeal embed page.
