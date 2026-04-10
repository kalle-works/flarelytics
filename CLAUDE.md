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

Events written to Analytics Engine:
- `pageview` — Page views with referrer, UTM params, device, browser, country
- `outbound` — External link clicks (destination in blob5)
- `timing` — Time on page in seconds (fires on `visibilitychange`); seconds stored in `double2`
- `scroll_depth` — Scroll milestones 25/50/75/100% via IntersectionObserver (opt-in); depth in blob5
- `(custom)` — Any event via `flarelytics.track('event', { props })` — name in blob4, props in blob5

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

## Analytics Engine Schema

Each event writes one row. Always use these field names in queries:

| Field | Content |
|---|---|
| `blob1` | Page path |
| `blob2` | Referrer hostname (`direct` if none) |
| `blob3` | Country code (from CF headers) |
| `blob4` | Event name (`pageview`, `timing`, `scroll_depth`, custom) |
| `blob5` | Event properties (pipe-separated values) |
| `blob6` | `utm_source` |
| `blob7` | `utm_medium` |
| `blob8` | `utm_campaign` |
| `blob9` | Visitor hash (daily-rotating SHA-256) |
| `blob10` | Site hostname — REQUIRED in all WHERE clauses for multi-site support |
| `blob11` | Device type (`mobile`/`tablet`/`desktop`) |
| `blob12` | Browser name (Chrome/Firefox/Safari/Edge/Opera/DuckDuckGo/Other) |
| `double1` | Event count (always 1) |
| `double2` | Time on page in seconds (only for `timing` events, use AVG) |

All queries must include `AND blob10 = '${site}'` to scope to a single site.

## Available Queries

23 queries available via `GET /query?q=<name>&period=<period>&site=<hostname>`:

**Traffic:** `top-pages`, `top-pages-visitors`, `top-pages-stories`, `daily-views`, `daily-unique-visitors`, `new-vs-returning`

**Referrers:** `referrers`, `utm-campaigns`, `utm-campaign-trend`

**Content:** `page-views-over-time` (?page=), `page-timing`, `bounce-rate-by-page` (?event_name=seconds), `scroll-depth`, `scroll-depth-by-page`

**Geo/Devices:** `countries`, `countries-by-page` (?page=), `devices`, `browsers`

**Conversions:** `outbound-links`, `page-performance`, `custom-events`, `conversion-funnel`, `funnel-by-event` (?event_name=)

Periods: `7d`, `14d`, `30d`, `60d`, `90d`, `180d`

## Design System

Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.

Key rules:
- **Accent is burnt orange (#dc6b14)** — warm, distinct from every competitor
- **Accent hover is #b45309** — for body-text links use #b45309 (WCAG AA), #dc6b14 for large/decorative
- **CTA buttons are dark (#1c1917), not orange** — orange is highlight, not action
- **All UI labels use monospace** — nav, buttons, section headers, data labels
- **Light mode landing page, dark code blocks** — the contrast is intentional
- **Satoshi for display only** — everything else is system fonts or monospace

## Content & Style

- No AI slop words
- Documentation should be direct, practical, code-first
- README targets developers who want to deploy in 5 minutes
- Every claim about features must be accurate

## Multi-Site Support

One worker can serve multiple sites. The site hostname is derived from the `Origin` header on each `/track` request and stored in `blob10`. All queries accept `?site=hostname.com` and filter by `blob10`. The dashboard has a site switcher for switching between configured sites.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
