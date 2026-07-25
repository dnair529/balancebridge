# Client Portal — Technical Specification v1.0

App: `portal.balancebridge.us` — Fastify (Node 22) + PostgreSQL 16 + Drizzle ORM, server-rendered (Eta templates) with minimal client JS. Session-cookie auth. Runs as one Docker container beside Postgres, DocuSeal, and Caddy.

## Security requirements (non-negotiable)

1. **Auth:** argon2id hashing (memory 19MiB, iterations 2, parallelism 1 minimum); invite-only account creation; optional TOTP MFA (RFC 6238, ±1 step window); rate limit: 10 login attempts / 15 min / IP+email, constant-time compare on tokens.
2. **Sessions:** 128-bit random token, stored **hashed** (sha256) in DB; cookie `__Host-session`: httpOnly, Secure, SameSite=Lax, path=/; idle timeout 24h, absolute 14 days; revocable server-side; session rotated on login and privilege change.
3. **CSRF:** double-submit token on all state-changing form posts (synchronizer token stored in session, hidden field in forms).
4. **Access control:** every query scoped by `client_id` derived from the session server-side — never from user input. Roles: `client` (their own client only), `staff` (all clients), `admin` (staff + user/invite management + audit view).
5. **Files:** stored outside web root as `{uuid}` with original name only in DB; served via authenticated streaming route with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`; upload limits 25MB/file, allowlist of extensions (pdf, png, jpg, csv, xlsx, xls, docx, doc, qbo, qbx, txt, zip); sha256 recorded.
6. **Headers (also enforced at Caddy):** HSTS, X-Frame-Options DENY (except DocuSeal embed page which uses frame-src for the DocuSeal origin only), CSP default-src 'self', no inline script except nonce'd.
7. **Audit log:** append-only record of logins (success/fail), file view/upload/download/delete, message send, invoice view, signature events, admin actions. Never deleted by app code.
8. **Secrets:** env-only (`.env` never committed); DATABASE_URL, SESSION_PEPPER, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, DOCUSEAL_URL, DOCUSEAL_API_KEY, SMTP_*.
9. **Webhooks:** Stripe signature verified with official lib; DocuSeal webhook verified via shared secret header; both idempotent.
10. **No card data** ever stored; invoices/payments live in Stripe, we mirror status metadata only.

## Database schema (Drizzle / Postgres)

```
clients        id uuid pk, business_name text, contact_name text, email text, phone text,
               status text default 'active', stripe_customer_id text, created_at, notes text
users          id uuid pk, client_id uuid fk null (null = staff/admin), email citext unique,
               password_hash text, name text, role text check in ('client','staff','admin'),
               totp_secret text null, totp_enabled bool default false,
               disabled bool default false, last_login_at, created_at
sessions       id uuid pk, user_id fk, token_hash text unique, csrf_token text,
               created_at, last_seen_at, expires_at, ip inet, user_agent text, revoked_at null
invites        id uuid pk, email, client_id fk null, role, token_hash unique, expires_at,
               accepted_at null, created_by fk users
password_resets id uuid pk, user_id fk, token_hash unique, expires_at, used_at null
documents      id uuid pk, client_id fk, uploaded_by fk users, folder text default 'General',
               filename text, stored_name uuid, mime text, size_bytes bigint, sha256 text,
               created_at, deleted_at null
threads        id uuid pk, client_id fk, subject text, created_by fk, created_at, closed_at null
messages       id uuid pk, thread_id fk, sender_id fk, body text, created_at
thread_reads   thread_id fk, user_id fk, last_read_at — pk (thread_id, user_id)
task_lists     id uuid pk, client_id fk, title text, created_by fk, created_at, archived_at null
tasks          id uuid pk, list_id fk, title text, notes text, owner text check in ('client','firm'),
               due_date date null, sort_order int, completed_at null, completed_by fk null
invoices       id uuid pk, client_id fk, stripe_invoice_id text unique, number text,
               amount_due_cents int, amount_paid_cents int, currency text default 'usd',
               status text, hosted_invoice_url text, invoice_pdf text, issued_at, due_at, paid_at
signature_requests id uuid pk, client_id fk, title text, docuseal_submission_id text unique,
               signer_email text, status text default 'pending', created_by fk, created_at, completed_at
leads          id uuid pk, form text, name text, email text, phone text, company text,
               business_type text, revenue text, message text, ip inet, created_at, handled_at null
audit_log      id bigserial pk, at timestamptz default now(), user_id fk null, client_id fk null,
               action text, entity text, entity_id text, ip inet, meta jsonb
```

## Routes

**Public:** GET /login, POST /login, GET/POST /login/totp, GET/POST /forgot-password, GET/POST /reset-password/:token, GET/POST /accept-invite/:token, POST /api/leads (rate-limited 5/min/IP, honeypot check, CORS restricted to site origins), POST /webhooks/stripe, POST /webhooks/docuseal, GET /healthz.

**Authenticated (client scope):** GET /dashboard · documents: GET /documents, POST /documents/upload, GET /documents/:id/download, POST /documents/:id/delete (own uploads only) · messages: GET /messages, GET/POST /messages/:threadId, POST /messages/new · tasks: GET /tasks, POST /tasks/:id/toggle (owner=client only) · billing: GET /billing (list + status chips, "Pay now" → hosted_invoice_url) · signatures: GET /signatures, GET /signatures/:id (DocuSeal embed) · settings: GET /settings, POST /settings/password, POST /settings/mfa/setup, POST /settings/mfa/verify, POST /settings/mfa/disable, POST /logout.

**Staff/admin:** GET /admin (client list + open items) · GET/POST /admin/clients, GET /admin/clients/:id (tabs: docs, messages, tasks, invoices, signatures) · POST /admin/clients/:id/tasks (create list/tasks from templates) · POST /admin/invites · GET /admin/leads · POST /admin/signatures/new (create DocuSeal submission from uploaded doc) · GET /admin/audit (admin only) · POST /admin/invoices/sync (pull from Stripe).

## UI

Eta templates, server-rendered, brand-consistent (navy/emerald, Space Grotesk + Inter via system fallback stack to avoid font hosting duplication: use `font-family: 'Space Grotesk Variable', ...` with local CSS copy). Layout: top bar + left nav (Dashboard, Documents, Messages, Tasks, Billing, Signatures, Settings; staff see Admin). Mobile: nav collapses to bottom tab bar. No SPA framework; small vanilla JS for drag-drop upload, message polling (30s), checkbox toggles.

## Integrations

- **Stripe:** invoices created in Stripe dashboard by the firm (phase 1); webhook `invoice.finalized|paid|payment_failed|voided` upserts mirror rows. "Pay now" = Stripe-hosted invoice URL. Customer portal link on /billing.
- **DocuSeal:** self-hosted at `sign.balancebridge.us` (internal container). Staff upload PDF → create submission via API → client gets portal notification + embedded signing page → webhook `form.completed` updates status + saves signed PDF back into documents.
- **Email (SMTP):** invite, password reset, new-message notification, task assigned, signature request, lead alert to firm inbox. All templated, plain-English.

## Non-goals (phase 1)

No open registration, no client-initiated Stripe payment methods management beyond hosted portal, no in-app document preview (download only), no realtime websockets (poll), no multi-firm tenancy.
