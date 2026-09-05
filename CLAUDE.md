# Flarelytics

Privacy-first web analytics that runs entirely on Cloudflare. No cookies, no external dependencies, 5-minute setup.

**Website:** https://flarelytics.dev
**Repo:** https://github.com/kalle-works/flarelytics

## Tech Stack

- **Runtime:** Cloudflare Workers
- **Storage:** Cloudflare Analytics Engine (event data), KV (config/reports)
- **Dashboard:** Astro static site (deployed alongside worker)
- **Tracker:** Vanilla JS (under 2KB gzipped)
- **Email Reports:** Cloudflare Worker cron + Euromail SDK
- **Monorepo:** npm workspaces + Turbo

## Architecture

```
packages/
├── worker/         # CF Worker: tracking endpoint + query API
├── dashboard/      # Astro static site: analytics dashboard
├── tracker/        # Lightweight client-side tracking script
├── email-reports/  # CF Worker cron: weekly/monthly email digests
└── landing/        # Astro static site: flarelytics.dev marketing + docs
```

## Worker Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/track` | CORS origin check | Record events |
| GET | `/query` | Session cookie (org-scoped) OR X-API-Key (full) | Run predefined analytics queries |
| GET | `/public-stats` | CORS origin check | Public analytics summary (no API key) |
| GET | `/tracker.js` | None | Serve auto-configured tracking script |
| GET | `/health` | None | Health check |
| GET | `/config` | None | Available queries and event types |
| GET/POST/DELETE | `/admin/sites` | Session (owner/admin, org-scoped) OR X-API-Key (legacy global) | List / claim / remove the org's sites |
| POST | `/admin/sites/verify` | Session (owner/admin) + same-origin | Verify a pending site claim via DNS TXT |
| GET | `/api/auth/login` | None → redirects to OIDC | Start SSO login (PKCE) |
| GET | `/api/auth/oidc/callback` | OIDC flow cookie | Finish login, set session cookie |
| GET | `/api/auth/me` | Session cookie | Current user: orgs, active_org, role, sites |
| POST | `/api/auth/switch-org` | Session cookie + same-origin | Change active organization |
| GET | `/api/auth/logout` | Session cookie | Clear session + OIDC end-session |

## Event Types

Events written to Analytics Engine:
- `pageview` — Page views with referrer, UTM params, device, browser, country. Fires on load and on SPA route changes (pushState/replaceState/popstate); opt out with `data-no-spa`
- `outbound` — External link clicks, including middle-click (destination in blob5); subdomains of the current site count as internal, not outbound
- `timing` — Time on page in seconds, per *visible period* (resets on tab switch/pagehide, not cumulative since load); seconds stored in `double2`
- `scroll_depth` — Scroll milestones 25/50/75/100% via IntersectionObserver (opt-in); depth in blob5
- `bot_hit` — Bot traffic recorded separately for analytics; UA in blob5
- `(custom)` — Any event via `flarelytics.track('event', { props })` — name in blob4, props in blob5

## Privacy

- No cookies
- No fingerprinting
- Daily-rotating, per-site visitor hash (HMAC-SHA256 of IP+UA+site+date, keyed by `VISITOR_SALT`, truncated to 64 bits) for unique visitor counts
- Hash resets every day — no cross-day tracking
- GDPR/CCPA compliant by architecture
- Bot filtering built-in
- Tracker skips sending on `localhost`/`127.0.0.1`/`[::1]`/`file:` by default (`data-allow-localhost` opts in), so local dev doesn't send test traffic into production

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
- `VISITOR_SALT` — Secret pepper for the visitor hash; falls back to `QUERY_API_KEY` if unset

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
| `blob9` | Visitor hash (daily-rotating HMAC-SHA256, 16 hex chars) |
| `blob10` | Site hostname — REQUIRED in all WHERE clauses for multi-site support |
| `blob11` | Device type (`mobile`/`tablet`/`desktop`) |
| `blob12` | Browser name (Chrome/Firefox/Safari/Edge/Opera/DuckDuckGo/Other) |
| `blob13` | Operating system (Windows/macOS/iOS/Android/Linux/ChromeOS/Other) |
| `double1` | Event count (always 1) |
| `double2` | Time on page in seconds (only for `timing` events, use AVG) |
| `double3` | Revenue/conversion value (0 unless `value` field sent in track payload) |

All queries must include `AND blob10 = '${site}'` to scope to a single site.

## Available Queries

41 queries available via `GET /query?q=<name>&period=<period>&site=<hostname>`:

**Traffic:** `top-pages`, `top-pages-visitors`, `top-pages-stories`, `daily-views`, `daily-unique-visitors`, `total-sessions`, `total-pageviews`, `total-visitors`

**Revenue:** `revenue-by-event`, `revenue-over-time` (only populated when `value` field is sent in track calls)

**Query filters:** Append `&filter[key]=value` to any query to scope by dimension. Keys: `country` (2-letter code), `device` (mobile/tablet/desktop), `browser`, `os` (Windows/macOS/iOS/Android/Linux/ChromeOS), `referrer` (hostname), `page`, `utm_source`, `utm_campaign`.

**Server-side tracking:** POST to `/track` with `X-API-Key` header (no `Origin` required) and include `"site": "yoursite.com"` in the payload.

**Referrers:** `referrers`, `referrers-by-page` (?page=), `utm-campaigns`, `utm-campaign-trend`, `utm-by-page` (?page=)

**Content:** `page-views-over-time` (?page=), `page-timing`, `timing-by-page` (?page=), `bounce-rate-by-page` (?event_name=seconds), `scroll-depth`, `scroll-depth-by-page`, `scroll-depth-for-page` (?page=)

**Geo/Devices:** `countries`, `countries-by-page` (?page=), `devices`, `browsers`, `operating-systems`

**Conversions:** `outbound-links`, `page-performance`, `custom-events`, `conversion-funnel`, `funnel-by-event` (?event_name=)

**Live (30-min window):** `live-visitors`, `live-pages`, `live-referrers`, `hourly-today`

**Bot reporting:** `bot-hits`, `bot-hits-total`, `bot-pages`, `bot-daily`, `bot-countries`

Periods: `7d`, `14d`, `30d`, `60d`, `90d`, `180d`

## v1 Queries (Phase 0.5+)

Versioned query surface for the per-family v1 datasets (PAGEVIEW_EVENTS, ENGAGEMENT_EVENTS, SHARE_EVENTS). Dispatched by adding `v=1` to the request:

```
GET /query?v=1&q=<name>&site=<hostname>&period=<period>
```

| Query | Returns |
|---|---|
| `loop-overview` | `{ period, site, partial, status, kpis, articles[] }` — Distribution Loop view: shares → social inbound → engaged reads → quality score, surfaced at canonical_url_hash level |

v1 queries return a structured object (not the raw CF SQL `{data:[...]}` envelope). They aggregate multiple parallel SQL calls inside the worker using `Promise.all` over a per-bucket `tryRun` wrapper that catches its own errors and resolves to `null` (rather than `Promise.allSettled`), so partial failures degrade gracefully — failed buckets surface as `null` KPIs and `partial: true`. v0 queries are unchanged.

Loop view filters:
- `shares_out` counts only outbound clicks whose target URL was recognized as a known social platform (`bluesky`, `facebook`, `hn`, `reddit`, `x`, `mastodon`) — non-social outbound clicks (source links, ads) are excluded.
- `inbound_visits_from_social` counts pageviews whose `referrer_domain` matches a hostname allowlist (`SOCIAL_REFERRER_HOSTS` in `queries/v1/loop.ts`).

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

## Multi-Organization Support (SSO)

Dashboard users authenticate via the palvelureppu OIDC provider
(`id.palvelureppu.fi`) and only see the sites their **active organization** owns.
Modeled on helpparibotti's multi-org auth.

- **Session:** a signed (HMAC-SHA256) cookie `__Secure-fl_session` carrying
  `sub`, `orgs[{id,name,role}]`, and `active_org`. Stateless — no server session
  store. Code lives in `packages/worker/src/auth/` (`crypto`, `oidc`, `session`,
  `session-refresh`, `middleware`, `routes`, `sites-store`).
- **Cookie scope:** with `COOKIE_DOMAIN=flarelytics.dev` the cookie is
  first-party same-site across `app.flarelytics.dev` (dashboard) and
  `api.flarelytics.dev` (worker) — `SameSite=Lax`, survives Safari/Chrome
  third-party-cookie blocking. Empty `COOKIE_DOMAIN` → degraded `SameSite=None`.
- **Org→site ownership (DNS-verified):** an org may only add a hostname it
  proves it controls. `POST /admin/sites` returns a pending claim with a DNS TXT
  record (`_flarelytics.<host>` = `flarelytics-site-verification=<token>`);
  `POST /admin/sites/verify` confirms it via DNS-over-HTTPS and grants exclusive
  ownership. KV layout (all via `auth/sites-store.ts`): `org:<orgId>:sites`
  (verified, queryable), `site_owner:<hostname>` (global exclusive owner —
  blocks cross-tenant claims with 409), `site_claim:<orgId>:<host>` (pending
  token). This is the authz layer above AE; `blob10` is unchanged and `org_id`
  is never written to Analytics Engine.
- **Authorization:** `/query` requires the requested `?site=` to be in the active
  org's verified site list (`ADMIN_EMAILS` bypass any site). `/admin/sites`
  mutations need owner/admin role + a same-origin request (CSRF guard).
  `/switch-org` is IDOR-checked against the signed session's org list.
- **Roles:** `owner`/`admin` manage sites; `member` is read-only.
- **Back-compat:** `X-API-Key` remains a full-access programmatic key for
  `/query`, `/admin/sites` (legacy global `allowed_origins`), and server-side
  `/track`. SSO is additive; unset OIDC vars → auth endpoints return 503 and the
  worker runs on `X-API-Key` only.
- **Config:** `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`,
  `DASHBOARD_URL`, `COOKIE_DOMAIN`, `ADMIN_EMAILS` in `wrangler.toml`; secrets
  `SESSION_SECRET`, `OIDC_CLIENT_SECRET` via `wrangler secret put`.
- **Backfill:** existing `allowed_origins` sites belong to no org. Superadmins
  (`ADMIN_EMAILS`) see all sites immediately. At rollout, **seed ownership** for
  each currently-tracked hostname so nobody can first-claim it: set
  `site_owner:<hostname>` and `org:<ownerOrgId>:sites` in KV (e.g. via
  `wrangler kv key put`). New sites go through the DNS-verified claim flow.

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
