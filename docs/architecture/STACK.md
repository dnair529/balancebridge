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

## Infrastructure — Docker Compose + Caddy on the Hostinger VPS

- **Two isolated stacks** on one VPS: `uat` (uat.balancebridge.us, basic-auth + noindex) and `prod` (balancebridge.us + portal.balancebridge.us). Same images, different env — what you test is what you ship.
- **Caddy** terminates TLS (auto Let's Encrypt renewal), serves the static site, reverse-proxies portal + DocuSeal, and adds security headers (HSTS, CSP, frame-deny) centrally.
- **CI/CD — GitHub Actions:** push to `uat` branch → build + deploy UAT; merge to `main` → deploy production (with manual approval gate). Deploys are logged, repeatable, and roll back by re-running a previous commit's workflow. This also solves a practical constraint: the build environment can't open outbound SSH, but GitHub's runners can.
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
