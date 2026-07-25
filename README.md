# Balance Bridge Financial — Website & Client Portal

Premium marketing website + secure client portal for a Texas-based bookkeeping and accounting firm.

**Domain:** balancebridge.us (production) · uat.balancebridge.us (UAT)
**Infrastructure:** Hostinger VPS (Docker Compose, Caddy TLS)
**Repo layout:**

```
├── docs/              # Brand guide, architecture, SEO, API docs, deploy runbooks
│   ├── brand/         # Logo assets, brand guide
│   ├── architecture/  # Sitemap, wireframes, stack decisions, DB schema
│   ├── seo/           # Keyword targets, metadata map, local SEO plan
│   ├── content/       # Content plan, article drafts, swap-list for placeholders
│   ├── api/           # Portal API reference
│   └── deploy/        # Deployment guide, runbooks
├── site/              # Marketing site (Astro + Tailwind, static output)
├── portal/            # Client portal (Fastify + PostgreSQL)
└── infra/             # Docker Compose stacks, Caddy config, CI/CD
```

**Branches:** `main` → production · `uat` → uat.balancebridge.us

## Quick start (local)

```bash
cd site && npm install && npm run dev        # marketing site → localhost:4321
cd portal && npm install && npm run dev      # portal API + UI → localhost:3000
```

See `docs/deploy/DEPLOYMENT.md` for the full VPS deployment guide.
