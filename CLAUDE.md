# Flarelytics

Privacy-first web analytics that runs entirely on Cloudflare. No cookies, no external dependencies, 5-minute setup.

**Website:** https://flarelytics.dev
**Repo:** https://github.com/kalle-works/flarelytics

## Tech Stack

- **Runtime:** Cloudflare Workers
- **Storage:** Cloudflare Analytics Engine (event data), KV (config/reports)
- **Dashboard:** Astro static site (deployed alongside worker)
- **Tracker:** Vanilla JS (<1KB gzipped)
- **Email Reports:** Cloudflare Worker cron + Euromail SDK
- **Monorepo:** npm workspaces + Turbo

## Architecture

```
packages/
├── worker/         # CF Worker: tracking endpoint + query API
├── dashboard/      # Astro static site: analytics dashboard
├── tracker/        # Lightweight client-side tracking script
└── email-reports/  # CF Worker cron: weekly/monthly email digests
```

## Worker Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/track` | CORS origin check | Record events |
| GET | `/query` | X-API-Key header | Run predefined analytics queries |
| GET | `/tracker.js` | None | Serve auto-configured tracking script |
| GET | `/health` | None | Health check |
| GET | `/config` | None | Available queries and event types |

## Event Types

Default events (all optional, configurable):
- `pageview` — Page views with referrer and UTM tracking
- `custom` — Any custom event with name + properties
- `outbound` — External link clicks

Site-specific events users can add:
- Affiliate clicks, newsletter signups, quiz completions, etc.

## Privacy

- No cookies
- No fingerprinting
- Daily-rotating visitor hash (SHA-256 of IP+UA+date) for unique visitor counts
- Hash resets every day — no cross-day tracking
- GDPR/CCPA compliant by architecture
- Bot filtering built-in

## Development

```bash
npm install          # Install all workspace dependencies
npm run dev          # Start worker + dashboard in dev mode
npm run build        # Build all packages
npm run test         # Run tests
```

## Deployment

```bash
cd packages/worker
npx wrangler deploy  # Deploy analytics worker

cd packages/dashboard
npx wrangler pages deploy dist  # Deploy dashboard
```

## Environment Variables

### Worker (wrangler.toml)
```toml
name = "my-site-analytics"
account_id = "your-cf-account-id"

[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "my-site"

[vars]
ALLOWED_ORIGINS = "https://mysite.com"
DATASET_NAME = "my-site"
```

### Secrets (set via `wrangler secret put`)
- `QUERY_API_KEY` — Random string for dashboard authentication
- `CF_API_TOKEN` — Cloudflare API token with Analytics Engine read access
- `CF_ACCOUNT_ID` — Your Cloudflare account ID

## Design System

Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

Key rules:
- **Accent is amber (#d97706), NOT orange** — orange on dark = wrong association
- **CTA buttons are dark (#1c1917), not amber** — amber is highlight, not action
- **All UI labels use monospace** — nav, buttons, section headers, data labels
- **Light mode landing page, dark code blocks** — the contrast is intentional
- **Satoshi for display only** — everything else is system fonts or monospace

## Content & Style

- No AI slop words
- Documentation should be direct, practical, code-first
- README targets developers who want to deploy in 5 minutes
- Every claim about features must be accurate

## Extracted From

Originally built for [MailToolFinder](https://mailtoolfinder.com). The analytics worker, dashboard, and tracking scripts were extracted and generalized into this standalone product.

Source files in mailtoolfinder repo:
- `analytics/src/index.ts` — Original worker (486 lines)
- `src/pages/dashboard.astro` — Original dashboard (740 lines)
- `src/layouts/BaseLayout.astro` — Original tracking scripts
