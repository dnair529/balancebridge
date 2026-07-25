# Balance Bridge Portal — API Reference

App: `portal.balancebridge.us` — Fastify (Node 22), server-rendered (Eta), PostgreSQL 16 + Drizzle.
Source of truth: `portal/src/routes/*.ts`, `portal/src/auth/`, `portal/src/lib/`. This document describes what is **implemented**, not just what the spec (`docs/architecture/PORTAL-SPEC.md`) asks for.

This is a **server-rendered web app**, not a JSON API. Almost every route returns HTML or a `303 See Other` redirect. The only JSON endpoints are `POST /api/leads`, the two webhooks, and `GET /healthz`.

---

## Authentication model

Implemented in `portal/src/auth/session.ts`, `portal/src/auth/tokens.ts`, `portal/src/config.ts`.

**Roles:** `client` (bound to one client), `staff` (all clients), `admin` (staff + invites for staff/admin + audit view). Enforced by `requireAuth` / `requireStaff` / `requireAdmin` preHandlers in `portal/src/auth/guards.ts`. Unauthenticated browsers are redirected `303 → /login`; role failures render a `403` HTML error page.

**Session cookie**

| Property | Value |
|---|---|
| Name | `__Host-session` when `COOKIE_SECURE=1` (production); `session` for local HTTP dev |
| Value | 32 random bytes, base64url (raw token; only the hash is stored) |
| Attributes | `HttpOnly; Secure; SameSite=Lax; Path=/` — no `Max-Age`, so it is a browser-session cookie; real lifetimes are enforced server-side |
| Storage | `sessions.token_hash = sha256(token + SESSION_PEPPER)`. A leaked DB cannot be replayed without the pepper. Rotating `SESSION_PEPPER` invalidates every outstanding session, reset link, and invite link. |

**Lifetimes and rotation**

- **Idle timeout:** 24 hours (`config.session.idleMs`). An idle-expired session is revoked on next use.
- **Absolute lifetime:** 14 days (`config.session.absoluteMs`).
- **`last_seen_at`** is bumped at most once per 5 minutes to avoid a write per request.
- **Rotation:** a fresh session (new token + new CSRF secret) is minted on login, on MFA enable/disable, and after a password change. Password change and password reset revoke **all** other sessions for the user. Disabling a user revokes sessions on next request.
- **Revocation** is server-side (`sessions.revoked_at`); logout revokes the presented session and clears the cookie.

**Login hardening** (`portal/src/routes/auth.ts`, `portal/src/auth/password.ts`)

- Passwords: argon2id, memory 19 MiB, iterations 2, parallelism 1. Minimum length 12 (enforced on reset, invite-accept, and password change).
- A dummy argon2 verification runs when the email doesn't match a user, so response timing doesn't reveal account existence. Forgot-password responds identically whether or not the account exists.
- Optional TOTP (RFC 6238, 30s step, ±1 step window, 6 digits). Password success with TOTP enabled sets a **signed** `totp_pending` cookie (5-minute lifetime) and redirects to `/login/totp`; no session exists until the code verifies.
- Account creation is **invite-only** (7-day invite tokens, stored hashed like sessions).

---

## CSRF model

Implemented in `portal/src/lib/csrf.ts`, registered as a global `preHandler` on every `POST`.

- **Authenticated requests — synchronizer token.** Each session row carries a random `csrf_token`; every form embeds it as a hidden `_csrf` field. It rotates whenever the session rotates. Mismatch → `403` HTML page ("Form expired").
- **Pre-auth forms (login, TOTP, forgot/reset password, accept-invite) — double-submit cookie.** A random token is set in an `HttpOnly; SameSite=Lax` cookie (`__Host-csrf` in prod, `csrf` in dev) and must match the hidden `_csrf` field.
- **Multipart exception:** `POST /documents/upload` is marked `skipCsrf` (the global hook can't read multipart bodies) and validates the `_csrf` part itself after parsing, before any DB write; a stored file is deleted if the check fails.
- **Exempt by design:** `POST /api/leads` (cross-origin lead form; protected by CORS allowlist + rate limit + honeypot), `POST /webhooks/*` (signature / shared-secret verified), `GET /healthz`.
- All token comparisons are constant-time (`safeEqual` in `portal/src/auth/tokens.ts`).

---

## Error format

- **Browser routes:** errors render an HTML page (`views/error.eta`) with the right status code — `403` (CSRF failure / role failure / not-your-upload), `404` (unknown routes and out-of-scope IDs), `429` ("Slow down" page), `500` (generic message; stack traces are never sent, full error is logged server-side with cookies redacted).
- **Validation failures** on forms use a flash-message cookie + `303` redirect back to the form (see `reply.flash` in `portal/src/lib/view.ts`).
- **JSON endpoints** (`/api/leads`, webhooks): `{ "ok": false, "error": "..." }` or `{ "error": "..." }` with 400/401/422/503 as documented per route below.

---

## Access-control scoping

`resolveClientId()` (`portal/src/auth/guards.ts`) is the single choke point:

- `client` role: **always** the `client_id` on the session's user row — request input is never consulted.
- `staff`/`admin`: choose a client explicitly with `?client=<uuid>` on the client-scoped routes below; without it those pages redirect `303 → /admin`.

Every query on a client-scoped route filters by that resolved `client_id`; an ID alone is never sufficient (out-of-scope IDs return `404`).

---

## Rate limits

`@fastify/rate-limit` registered with `global: false` — only these routes are limited:

| Route | Limit | Key |
|---|---|---|
| `POST /login` | 10 / 15 min | IP + submitted email |
| `POST /login/totp` | 10 / 15 min | IP (+ email field, absent on this form) |
| `POST /forgot-password` | 5 / 15 min | IP |
| `POST /api/leads` | 5 / min | IP |

Exceeding a limit returns the `429` HTML page. `trustProxy` is on (Caddy in front), so `req.ip` is the real client IP.

---

## Routes

Legend — **Auth:** `public` / `client+` (any signed-in user; staff must add `?client=<uuid>`) / `staff` / `admin`. **CSRF:** sync = session synchronizer token, ds = pre-auth double-submit cookie, self = validated inside the handler, — = exempt. All redirects are `303`.

### Auth

| Method & path | Auth | CSRF | Request | Success | Errors |
|---|---|---|---|---|---|
| `GET /login` | public | — | – | 200 HTML (or → `/dashboard` if already signed in) | – |
| `POST /login` | public | ds | form: `email`, `password` | → `/dashboard`, or → `/login/totp` if MFA on | bad creds / disabled → flash + → `/login`; 429 |
| `GET /login/totp` | public (needs `totp_pending` cookie) | — | – | 200 HTML | no/expired cookie → `/login` |
| `POST /login/totp` | public | ds | form: `code` (6 digits) | → `/dashboard` | bad code → flash + → `/login/totp`; 429 |
| `POST /logout` | client+ | sync | – | → `/login` (session revoked, cookie cleared) | – |
| `GET /forgot-password` | public | — | – | 200 HTML | – |
| `POST /forgot-password` | public | ds | form: `email` | → `/login` with neutral flash (reset link emailed if account exists; 1-hour token) | 429 |
| `GET /reset-password/:token` | public | — | – | 200 HTML | invalid/expired/used token → `/forgot-password` |
| `POST /reset-password/:token` | public | ds | form: `password` (≥12 chars) | → `/login`; all sessions for the user revoked | short password → flash + back; bad token → `/forgot-password` |
| `GET /accept-invite/:token` | public | — | – | 200 HTML (shows invite email) | invalid/expired/accepted → `/login` |
| `POST /accept-invite/:token` | public | ds | form: `name`, `password` (≥12) | creates user, marks invite accepted, signs in → `/dashboard` | validation → back; email already registered → `/login` |

### Dashboard

| Method & path | Auth | CSRF | Success | Notes |
|---|---|---|---|---|
| `GET /` | client+ | — | → `/dashboard` | |
| `GET /dashboard` | client+ | — | 200 HTML | 5 recent docs, 5 open threads, open/past-due invoices + total due, pending signatures, up to 8 open client-owned tasks. Staff without `?client` → `/admin`. |

### Documents

| Method & path | Auth | CSRF | Request | Success | Errors |
|---|---|---|---|---|---|
| `GET /documents` | client+ | — | – | 200 HTML (non-deleted docs, newest first) | |
| `POST /documents/upload` | client+ | self | multipart: `_csrf`, `folder` (one of General, Bank statements, Receipts, Payroll, Tax, Reports; else General), one file. Max 25 MB; extension allowlist: pdf png jpg jpeg csv xlsx xls docx doc qbo qbx txt zip. Extra files are drained and ignored. | flash + → `/documents` (sha256 + size recorded; stored as `{uuid}` outside web root) | bad type / >25 MB / no file → flash + back; CSRF fail → 403 (stored file deleted) |
| `GET /documents/:id/download` | client+ | — | – | 200 stream, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Length` | out-of-scope or deleted → 404 |
| `POST /documents/:id/delete` | client+ | sync | – | soft delete; flash + → `/documents` | clients may delete **only their own uploads** (403 otherwise); 404 out of scope |

### Messages

| Method & path | Auth | CSRF | Request | Success | Errors |
|---|---|---|---|---|---|
| `GET /messages` | client+ | — | – | 200 HTML (threads with last-activity, count, unread flag) | |
| `POST /messages/new` | client+ | sync | form: `subject` (≤200), `body` | creates thread + first message, emails the other side → `/messages/:threadId` | empty fields → flash + → `/messages` |
| `GET /messages/:threadId` | client+ | — | – | 200 HTML; marks thread read for current user | out of scope → 404 |
| `POST /messages/:threadId` | client+ | sync | form: `body` | appends reply, notifies other side → thread | closed/missing thread → 404; empty body → silent redirect back |

Email fan-out: client sender → firm inbox (`FIRM_INBOX`); staff sender → every enabled portal user of that client.

### Tasks

| Method & path | Auth | CSRF | Success | Errors |
|---|---|---|---|---|
| `GET /tasks` | client+ | — | 200 HTML (active lists + items) | |
| `POST /tasks/:id/toggle` | client+ | sync | toggles complete/reopen → `/tasks` | task joined through its list for scope (404 out of scope); clients may only toggle `owner='client'` items (403 for firm-side items) |

### Billing

| Method & path | Auth | CSRF | Success | Errors |
|---|---|---|---|---|
| `GET /billing` | client+ | — | 200 HTML (mirrored Stripe invoices; "Pay now" links to Stripe-hosted `hosted_invoice_url`). Audited as `invoice.view_list`. | |
| `POST /billing/portal` | client+ | sync | → Stripe-hosted customer-portal session URL | Stripe unconfigured or client has no `stripe_customer_id` → flash + → `/billing` |

No card data is ever handled by this app; invoices are status mirrors of Stripe.

### Signatures

| Method & path | Auth | CSRF | Success | Errors |
|---|---|---|---|---|
| `GET /signatures` | client+ | — | 200 HTML (all requests for client) | |
| `GET /signatures/:id` | client+ | — | 200 HTML; for pending requests, embeds the DocuSeal signing iframe (`${DOCUSEAL_URL}/s/{slug}`). This route alone widens CSP `frame-src` to the DocuSeal origin. | out of scope → 404; slug lookup failure logged, page renders without embed |

### Settings

| Method & path | Auth | CSRF | Request | Success | Errors |
|---|---|---|---|---|---|
| `GET /settings` | client+ | — | – | 200 HTML; re-shows TOTP QR (data URL) if setup is mid-flight | |
| `POST /settings/password` | client+ | sync | form: `current_password`, `new_password` (≥12) | updates hash, revokes all other sessions, issues fresh session → `/settings` | wrong current / short new → flash + back |
| `POST /settings/mfa/setup` | client+ | sync | – | stores TOTP secret (not yet enabled) → `/settings` shows QR + secret | already enabled → flash + back |
| `POST /settings/mfa/verify` | client+ | sync | form: `code` | first valid code arms MFA; session rotated → `/settings` | bad code → flash + back |
| `POST /settings/mfa/disable` | client+ | sync | form: `password` | disables + clears secret; session rotated → `/settings` | wrong password → flash + back |

### Admin

All routes below require **staff** (scoped `preHandler` hook); `/admin/audit` requires **admin**. All POSTs use the sync CSRF token.

| Method & path | Auth | Request | Success | Errors |
|---|---|---|---|---|
| `GET /admin` | staff | – | 200 HTML (clients, unhandled leads, pending signatures, open invoices) | |
| `GET /admin/clients` | staff | – | 200 HTML | |
| `POST /admin/clients` | staff | form: `business_name` (required), `contact_name`, `email`, `phone`, `stripe_customer_id`, `notes` | creates client → `/admin/clients/:id` | missing name → flash + back |
| `GET /admin/clients/:id` | staff | – | 200 HTML (tabs: docs, threads, task lists, invoices, signatures, users, pending invites) | non-UUID or unknown → 404 |
| `POST /admin/clients/:id/tasks` | staff | form: `template` (`onboarding` \| `monthly_close` \| `year_end`) or `title` + `items` (one per line; `!` prefix = firm-owned) | creates list + items, emails client users → client page | no template and no title/items → flash + back |
| `GET /admin/invites` | staff | – | 200 HTML | |
| `POST /admin/invites` | staff | form: `email`, `role` (`client` \| `staff` \| `admin`, defaults `client`), `client_id` (required for client role) | creates 7-day invite, emails link → `/admin/invites` | **staff/admin invites: admin only** (flash otherwise); invalid email / missing client → flash |
| `GET /admin/leads` | staff | – | 200 HTML (newest 200) | |
| `POST /admin/leads/:id/handled` | staff | – | marks handled → `/admin/leads` | non-UUID → 404 |
| `POST /admin/signatures/new` | staff | form: `document_id` (existing PDF doc), `signer_email`, `title` | creates DocuSeal template + submission (portal sends its own email, DocuSeal's is suppressed) → client page | DocuSeal unconfigured / invalid input / non-PDF doc → flash + → `/admin` |
| `POST /admin/invoices/sync` | staff | – | pulls up to 100 invoices per Stripe-linked client, upserts mirrors → `/admin` | Stripe unconfigured → flash |
| `GET /admin/audit` | **admin** | – | 200 HTML (latest 300 audit rows) | 403 for staff |

### Public API (leads)

`POST /api/leads` — the only cross-origin endpoint (`portal/src/routes/leads.ts`). Caddy also routes `balancebridge.us/api/*` to the portal, so the marketing site can post same-origin.

- **Auth:** public. **CSRF:** exempt. **Rate limit:** 5/min/IP. **CORS:** allowlist — `https://balancebridge.us`, `https://www.balancebridge.us`, `https://uat.balancebridge.us`, localhost dev origins, plus `LEADS_EXTRA_ORIGINS`. `OPTIONS /api/leads` answers preflight with 204.
- **Body** (form or JSON): `form` (≤50, default `contact`), `name` (≤200), `email` (≤254), `phone` (≤50), `company` (≤200), `business_type` (≤100), `revenue` (≤100), `message` (≤5000), and honeypot field `website` (must be empty). At least one of `name`/`email` is required.
- **Success:** `Accept: application/json` → `200 {"ok":true}`; otherwise `303 → ${SITE_URL}/thanks/`. Fires a lead-alert email to `FIRM_INBOX` and an audit row.
- **Errors:** honeypot filled → `422 {"ok":false,...}` (bot learns nothing); missing name+email → `400`; rate limit → 429.

### Webhooks

Registered in an isolated plugin with a raw-body parser (`portal/src/routes/webhooks.ts`). Both CSRF-exempt and idempotent.

**`POST /webhooks/stripe`**
- Verified with `stripe.webhooks.constructEvent` against `STRIPE_WEBHOOK_SECRET` (raw bytes + `Stripe-Signature` header).
- Handled events: `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided` → upsert mirror row keyed on `stripe_invoice_id` (invoices for unknown customers are ignored). All other events are acknowledged without action.
- Responses: `200 {"received":true}`; `400 {"error":"invalid signature"}`; `503 {"error":"stripe not configured"}`.

**`POST /webhooks/docuseal`**
- Verified by shared secret: header `X-Docuseal-Secret` must equal `DOCUSEAL_WEBHOOK_SECRET` (constant-time).
- Handled events: `form.completed` / `submission.completed` → mark the matching signature request completed and archive the signed PDF back into the client's Documents (folder "General", named `"<title> (signed).pdf"`). Already-completed submissions are a no-op.
- Responses: `200 {"received":true}`; `401 {"error":"unauthorized"}`; `400 {"error":"invalid json"}`; `503 {"error":"docuseal not configured"}`.

### Health

| Method & path | Auth | Success | Notes |
|---|---|---|---|
| `GET /healthz` | public | `200 {"ok":true}` | Runs `SELECT 1` against Postgres; used by the Docker `HEALTHCHECK` and CI smoke tests. Non-200/exception if the DB is down. |

---

## Audit logging

`portal/src/lib/audit.ts` appends to `audit_log` (never updated or deleted by app code). Failures are logged but never fail the request. Each row: timestamp, acting user (from session when present), client id, action, entity/entity id, IP, JSON meta.

Recorded actions: `auth.login_success`, `auth.login_fail` (includes attempted email in meta), `auth.totp_fail`, `auth.logout`, `auth.reset_requested`, `auth.password_reset`, `auth.password_change`, `auth.invite_accepted`, `auth.mfa_enabled`, `auth.mfa_disabled`, `document.upload` (filename, size, sha256), `document.download`, `document.delete`, `message.send`, `invoice.view_list`, `billing.portal_open`, `signature.view`, `signature.request_created`, `signature.completed`, `task.complete`, `task.reopen`, `lead.created`, `admin.client_create`, `admin.tasklist_create`, `admin.invite_create`, `admin.lead_handled`, `admin.invoice_sync`, and `stripe.invoice.finalized|paid|payment_failed|voided` from the webhook.

Viewable at `GET /admin/audit` (admin only, latest 300 rows).

---

## Security headers

Set on every response (`portal/src/server.ts`), also mirrored at Caddy: strict CSP (`default-src 'self'`, no inline scripts, `form-action 'self' https://*.stripe.com`, `frame-ancestors 'none'`; `frame-src` opens to the DocuSeal origin only on `GET /signatures/:id`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy` (camera/mic/geo off), HSTS (2 years, includeSubDomains) when cookies are Secure.

---

## Environment variables (`portal/.env.example`)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `production` refuses dev pepper and `COOKIE_SECURE=0` |
| `HOST` | no | `0.0.0.0` | Bind address |
| `PORT` | no | `3000` | Listen port |
| `LOG_LEVEL` | no | `info` | pino level |
| `DATABASE_URL` | **yes** | – | Postgres 16 connection string |
| `SESSION_PEPPER` | **yes** (≥32 chars) | – | Mixed into session/reset/invite token hashes; also the cookie-signing secret. Rotating it logs everyone out and voids emailed links. |
| `COOKIE_SECURE` | no | `1` | `1` = Secure cookies + `__Host-` names. `0` only for local HTTP dev; refused in production. |
| `SITE_URL` | no | `https://balancebridge.us` | Marketing site origin; `/api/leads` redirects to `${SITE_URL}/thanks/` |
| `PORTAL_URL` | no | `http://localhost:3000` | Portal's public origin, used in email links |
| `LEADS_EXTRA_ORIGINS` | no | empty | Extra comma-separated CORS origins for `/api/leads` |
| `UPLOADS_DIR` | no | `./data/uploads` | File storage, outside web root; created on boot |
| `ADMIN_EMAIL` | no | `admin@balancebridge.us` | Admin created by the seed script |
| `ADMIN_PASSWORD` | for seeding | empty | Seed refuses to run without it |
| `SEED_DEMO` | no | `0` | `1` also seeds demo client/user/sample data |
| `DEMO_PASSWORD` | no | `demo-client-password` | Demo client user's password (SEED_DEMO=1 only) |
| `STRIPE_SECRET_KEY` | no | empty | Billing disabled when empty |
| `STRIPE_WEBHOOK_SECRET` | no | empty | Stripe webhook returns 503 when empty |
| `DOCUSEAL_URL` | no | empty | DocuSeal origin. Used for **both** server-side API calls and the browser iframe/CSP — must be the publicly reachable origin (e.g. `https://sign.balancebridge.us`) |
| `DOCUSEAL_API_KEY` | no | empty | `X-Auth-Token` for DocuSeal API |
| `DOCUSEAL_WEBHOOK_SECRET` | no | empty | Expected in `X-Docuseal-Secret` webhook header; webhook 503s when empty |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | no | empty / 587 / – / – / `0` | Mail transport; when `SMTP_HOST` is empty, mail is logged to console instead of sent |
| `MAIL_FROM` | no | `Balance Bridge Financial <no-reply@balancebridge.us>` | From header |
| `FIRM_INBOX` | no | `hello@balancebridge.us` | Receives lead alerts and client-message notifications |

Config is validated with zod at boot; the process exits with a readable list of problems rather than starting half-configured.
