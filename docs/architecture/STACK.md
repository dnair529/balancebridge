# Stack Decisions — and why

Constraint set: small-firm budget (one VPS, ~$10–30/mo already paid), financial data (security first), no full-time dev on staff (simplicity/boring tech), room to grow (scalability without re-platforming).

## Marketing site — Astro 5 + Tailwind CSS 4, fully static

- **Why static:** the public site has zero server code → nothing to hack, nothing to patch at 2am, and sub-second loads that Google rewards. Pages are pre-rendered HTML served by Caddy with far-future caching.
- **Why Astro:** content collections give the blog real structure (typed frontmatter, RSS, sitemaps) while shipping ~0KB JS by default; the 52-post content plan publishes by adding a markdown file and pushing to git.
- **Why Tailwind:** design-system tokens (brand colors, spacing, type scale) enforced in one config; no CSS drift as the site grows.

## Client portal — Node.js 22 (Fastify) + PostgreSQL 16 + Drizzle ORM, server-rendered

- **Why Fastify/Node:** one language across the project, tiny memory footprint on a shared VPS, first-class ecosystem for everything we need (argon2, TOTP, Stripe SDK).
- **Why server-rendered + light JS (no SPA):** an accounting portal is forms, lists, and files — SSR keeps it fast, accessible, simple to secure (no token-in-browser problems; httpOnly session cookies only), and cheap to maintain.
- **Why PostgreSQL:** boring, bulletproof, real audit trails, easy nightly dumps; SQLite would work today but Postgres removes the future migration.
- **Auth:** argon2id password hashing, httpOnly+Secure+SameSite cookies, session table (revocable), TOTP MFA, rate-limited login, invite-only signup (the firm creates clients — no open registration).

## The risky parts we deliberately did NOT build

| Need | Choice | Why not build it |
|---|---|---|
| E-signature | **DocuSeal** (self-hosted container, open source, ESIGN/UETA-aligned) | Legally-defensible audit trails, tamper seals, and certificate pages are a product, not a feature. $0 self-hosted. |
| Payments & invoices | **Stripe** (hosted invoices + customer portal; webhooks sync history into our DB) | Card data never touches the VPS → PCI scope collapses to SAQ-A. Invoicing, receipts, ACH, autopay all included. ~2.9%+30¢ only when paid. |
| Scheduling | **Cal.com** embed (free tier) | Calendar sync/reminders/timezones are solved problems. |
| Transactional email | Resend or Postmark (~$0–15/mo) | VPS-sent mail lands in spam; deliverability is rented, not built. |

## Infrastructure — Docker Compose behind the VPS's existing Traefik

**Revised after inspecting the box (2026-07-25).** The VPS is not a blank server: it already runs ~18 containers — n8n, `platform-*`, `photoshotpro-*`, `app-*`, `polysage-*`, `deepaknair-web`, `fundeio-staging` and others — fronted by **Traefik** (`n8n-traefik-1`), which owns ports 80/443 and routes by container label on the `n8n_default` network, with an ACME resolver named `mytlschallenge`.

The original plan (Caddy on :80/:443) would have collided with Traefik and taken every one of those sites down. So:

- **We reuse Traefik.** Balance Bridge containers publish **no host ports**; they join `n8n_default` and advertise routes via `traefik.*` labels, the same pattern the existing services use. TLS is issued automatically by the existing resolver. Traefik itself is never modified.
- **Two isolated stacks**, `bb-uat` and `bb-prod`: separate Postgres, uploads volume, and DocuSeal per environment, each on its own private `bb-<env>-internal` network. Postgres is never on the edge network and publishes no port.
- **UAT is gated** by a Traefik basic-auth middleware plus an `X-Robots-Tag: noindex` header, so it can't be crawled or casually browsed.
- **The host is left alone.** The deploy script installs nothing, changes no firewall or SSH config, and refuses to run if Traefik isn't up. The site is even built inside a throwaway `node:22-alpine` container so Node never touches the host.
- **CI/CD:** GitHub Actions is disabled on this account, so deploys run from `infra/vps-deploy.sh` on the box (idempotent; it *is* the deploy command). The Actions workflows remain in the repo and will work unchanged if Actions is enabled later — the script and the workflow do the same steps.
- **Backups:** nightly `pg_dump` + uploads tarball, 14-day rotation on-box + copy-off-box step documented (Hostinger VPS backups + optional B2/S3).

## Monthly cost of ownership

| Item | Cost |
|---|---|
| Hostinger VPS (already owned) | $0 incremental |
| Domain (already owned) | $0 |
| DocuSeal, Caddy, Postgres, Astro, Fastify | $0 (open source) |
| Stripe | per-transaction only |
| Cal.com free tier | $0 |
| Transactional email | $0–15 |
| **Total fixed** | **≈ $0–15/mo** |

Scale path: portal and site are separate containers → move Postgres to managed DB or portal to a second VPS with a compose file change; static site can front with Cloudflare free CDN anytime.
