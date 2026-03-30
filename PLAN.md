# Flarelytics — Privacy-First Analytics for Cloudflare

## Context

MailToolFinder has a working analytics worker (Cloudflare Workers + Analytics Engine) with 6 event types, 13 query templates, and a full dashboard. The goal is to extract this into a standalone open-source product called **Flarelytics** that anyone can deploy on their own Cloudflare account.

**Why:** Privacy-first analytics is a growing market (Plausible, Fathom, Counterscale). Flarelytics differentiates by running 100% on Cloudflare with zero external dependencies, email reports, and a polished dashboard.

**Competitor gap:** Counterscale (closest competitor) has 90-day data retention limit and no email reports. Plausible requires separate hosting infrastructure.

## Product Vision

**One-liner:** Privacy-first web analytics that runs entirely on Cloudflare. No cookies, no external dependencies, 5-minute setup.

**Website:** https://flarelytics.dev

**Target users:** Developers and indie makers who use Cloudflare and want simple, privacy-respecting analytics without Google Analytics or paid Plausible.

## Architecture

```
flarelytics/
├── packages/
│   ├── worker/              # CF Worker (tracking + query API)
│   │   ├── src/index.ts
│   │   ├── wrangler.toml
│   │   └── package.json
│   ├── dashboard/           # Standalone dashboard (Astro static site)
│   │   ├── src/
│   │   │   ├── pages/
│   │   │   │   └── index.astro    # Main dashboard
│   │   │   ├── components/
│   │   │   └── lib/
│   │   ├── astro.config.mjs
│   │   └── package.json
│   ├── tracker/             # Lightweight tracking script (<1KB)
│   │   ├── src/tracker.ts
│   │   └── package.json
│   └── email-reports/       # CF Worker cron for email digests
│       ├── src/index.ts
│       └── package.json
├── README.md
├── CLAUDE.md
├── PLAN.md                  # This file
├── LICENSE (MIT)
├── package.json             # Monorepo root (workspaces)
└── turbo.json               # Build orchestration
```

## Phase 1: Extract & Generalize

### 1.1 Create new repo structure
- Initialize monorepo with npm workspaces
- MIT license (done)

### 1.2 Extract worker (`packages/worker/`)
- Copy `analytics/src/index.ts` from mailtoolfinder as base
- Remove mailtoolfinder-specific fallbacks:
  - Remove `|| 'mailtoolfinder'` dataset fallback (require explicit config)
  - Make event types configurable (not hardcoded 6)
  - Move bot UA patterns to config
- Add new endpoints:
  - `GET /config` — returns available queries and event types
  - `GET /events` — returns event type definitions
- Proper wrangler.toml with bindings

### 1.3 Extract tracker (`packages/tracker/`)
- Standalone `<script>` tag (~800 bytes gzipped)
- Auto-detects page views, outbound links
- Custom event API: `flarelytics.track('signup', { plan: 'pro' })`
- No dependencies, no build step needed for basic use
- CDN-hostable from the worker itself at `/tracker.js`

### 1.4 Extract dashboard (`packages/dashboard/`)
- Astro static site that deploys alongside the worker
- Keep existing: KPI cards, traffic chart, tables, funnel, period selector
- Improve:
  - Add sparkline charts to KPI cards (trend last 7d)
  - Add real-time visitor counter
  - Add date range picker (custom range, not just 7d/30d/90d)
  - Add CSV export for all tables
  - Add page-level detail view (click a page → see its referrers, events)
  - Country flags next to country codes
  - Responsive mobile layout
- Remove mailtoolfinder-specific:
  - Rename `mtf_dash_key` to `flarelytics_key`
  - Remove hardcoded worker URL fallback
  - Make "Affiliate Clicks" section optional (configurable sections)

### 1.5 Email reports (`packages/email-reports/`)
- Separate CF Worker with cron trigger
- Generates weekly digest email:
  - Top metrics vs previous period (delta arrows)
  - Top 5 pages
  - Top 3 referrers
  - Affiliate/conversion summary
  - Anomaly alerts (traffic spike/drop >30%)
- Uses Euromail SDK for sending (or configurable SMTP)
- Report recipients stored in CF KV
- Unsubscribe via HMAC-signed link

## Phase 2: Polish & Package

### 2.1 CLI setup tool
- `npx create-flarelytics` — interactive setup wizard
- Prompts for: CF account ID, dataset name, allowed origins
- Generates wrangler.toml with correct bindings
- Deploys worker + dashboard in one command

### 2.2 Documentation
- README with 5-minute quickstart
- Architecture overview
- API reference (all endpoints)
- Dashboard customization guide
- Email reports setup guide

### 2.3 npm packages
- `@flarelytics/tracker` — client-side tracking script
- `@flarelytics/worker` — CF Worker source (for customization)
- Published to npm

### 2.4 Landing page
- Simple site at flarelytics.dev
- Demo dashboard with sample data
- Comparison table vs Plausible, Counterscale, GA

## Phase 3: Back-integrate to MailToolFinder

### 3.1 Replace analytics/ with Flarelytics
- Update mailtoolfinder to use `@flarelytics/tracker`
- Update dashboard to use Flarelytics dashboard
- Remove old analytics/ directory
- Update CLAUDE.md documentation

## Source Files (from mailtoolfinder)

These files in the mailtoolfinder repo are the starting point:
- `analytics/src/index.ts` — Worker source (486 lines)
- `analytics/wrangler.toml.example` — Config template
- `analytics/README.md` — Existing docs
- `src/pages/dashboard.astro` — Dashboard (740 lines)
- `src/layouts/BaseLayout.astro` — Tracking scripts (pageview + outbound)
- `src/components/AffiliateButton.astro` — Affiliate click tracking
- `src/components/blog/NewsletterCTA.astro` — Newsletter signup tracking
- `src/pages/quiz.astro` — Quiz completion tracking

Mailtoolfinder repo: `~/Documents/kalle.works/active/mailtoolfinder.com/`

## Verification

1. `npx wrangler deploy` in packages/worker/ → worker responds on /health
2. Tracker script loads and sends pageview event
3. Dashboard authenticates and shows data
4. Email report cron triggers and sends test email
5. `npm test` passes in all packages
6. `npm run crawl` on mailtoolfinder still shows 0 broken links after back-integration

## Out of Scope (for now)
- Multi-tenant SaaS (one deployment per user is fine)
- Paid hosted version
- Session replay or heatmaps
- A/B testing integration
- Mobile SDK

## Competitors

| Product | Infrastructure | Pricing | Key Gap |
|---------|---------------|---------|---------|
| Counterscale | CF Workers | Free | 90-day retention, no email reports |
| Plausible | Self-hosted/SaaS | $20+/mo | Not CF-native, external deps |
| Fathom | SaaS | $14+/mo | Not self-hostable |
| Umami | Self-hosted | Free | Requires own database |
| **Flarelytics** | CF Workers only | Free | — |
