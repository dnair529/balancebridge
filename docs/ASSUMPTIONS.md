# Documented Assumptions

Decisions made without explicit direction, per project brief ("make reasonable assumptions where needed, document them"). Each is easy to reverse — flag anything you want changed.

## Business & content

| # | Assumption | Rationale | To change it |
|---|-----------|-----------|--------------|
| A1 | Firm name renders as **Balance Bridge Financial**, short form "Balance Bridge" | Matches brief; domain is balancebridge.us | Edit `site/src/config.ts` |
| A2 | Service area: **all of Texas, remote-first**, with local-SEO city pages for Dallas–Fort Worth, Houston, Austin, San Antonio, El Paso | Brief says "Texas cities"; these are the top metros for SMB density | SEO plan §City pages |
| A3 | Placeholder contact: phone `(512) 555-0146`, email `hello@balancebridge.us`, no street address published (remote-first) | User chose "placeholders, clearly marked". All placeholders listed in `docs/content/SWAP-LIST.md` | Swap-list doc |
| A4 | Pricing shown as **transparent starting-at tiers**: Essentials $395/mo, Growth $795/mo, Controller+ $1,495/mo, all "starting at" with Get a Quote CTA | Transparent anchoring converts better for SMB bookkeeping than "call us"; numbers are mid-market for TX firms | `site/src/pages/pricing.astro` |
| A5 | Testimonials & case studies are **realistic fictional composites, clearly marked as illustrative** in the swap-list | Trust signals needed for design/UX; publishing fake reviews would violate FTC rules — swap before launch or keep the section hidden | Swap-list doc |
| A6 | Certifications shown: QuickBooks ProAdvisor, Xero Partner, AIPB Certified Bookkeeper — as **placeholders pending verification** | Common for firms of this type; must be verified before production | Swap-list doc |
| A7 | Tax prep coordination positioned as "we prepare and coordinate with your CPA," not "we file your taxes" | Bookkeeping firm vs. CPA firm distinction; avoids implying CPA licensure | Services copy |

## Technical

| # | Assumption | Rationale | To change it |
|---|-----------|-----------|--------------|
| T1 | Marketing site: **Astro 5 + Tailwind CSS 4**, fully static output | Fastest possible loads, zero server attack surface for the public site, great SEO, content collections for blog | — |
| T2 | Portal: **Node.js (Fastify) + PostgreSQL 16 + Drizzle ORM**, server-rendered UI + small JS islands | Small-firm budget: one VPS runs everything; boring, auditable, secure | Stack doc |
| T3 | E-signature: **DocuSeal (self-hosted, open source)**; payments/invoice history via **Stripe** | Per portal decision (hybrid). DocuSeal is free self-hosted & ESIGN/UETA compliant; Stripe avoids PCI scope | Stack doc |
| T4 | Reverse proxy: **Caddy** (auto-TLS via Let's Encrypt) | Zero-maintenance HTTPS, HTTP/2, simple config | infra/ |
| T5 | UAT = `uat.balancebridge.us` (basic-auth gated + noindex), prod = `balancebridge.us` + `www` redirect | Standard two-environment promotion flow | infra/ |
| T6 | CI/CD: GitHub Actions → SSH deploy. Push to `uat` deploys UAT; push to `main` deploys production (after manual approval) | Version-controlled deploys per brief | `.github/workflows/` |
| T7 | Contact form + scheduling: form posts to portal backend (spam-protected); calendar embed assumed **Cal.com** (free tier) with placeholder link | Cal.com free plan fits small-firm budget; swap for Calendly if preferred | Swap-list doc |
| T8 | File storage: VPS local disk with encrypted-at-rest volume + nightly off-site backup guidance | Simplest secure option at this scale; S3-compatible upgrade path documented | Deploy guide |
| T9 | Email sending (portal notifications, form alerts): SMTP via a transactional provider (Resend/Postmark, ~$0–15/mo); placeholder env vars until account exists | VPS-direct SMTP lands in spam; provider needed | Deploy guide |
| T10 | VPS assumed Ubuntu 22.04/24.04 with root SSH (Hostinger default); will verify on first connect | Standard Hostinger KVM image | — |

## Legal/compliance notes (not legal advice)

- Privacy policy + terms drafted as solid starting points; have an attorney review before relying on them.
- Portal handles financial documents: encryption in transit (TLS) + at rest, MFA-ready auth, audit log, and least-privilege access are built in.
- No card data ever touches the VPS (Stripe-hosted checkout/portal) → minimal PCI scope (SAQ A).
