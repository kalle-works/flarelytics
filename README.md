# Flarelytics

Privacy-first web analytics that runs entirely on Cloudflare. No cookies, no external dependencies, 5-minute setup.

**Website:** [flarelytics.dev](https://flarelytics.dev)

## Why Flarelytics?

- **100% Cloudflare** — Workers + Analytics Engine. No databases, no servers, no third-party services.
- **Privacy by architecture** — No cookies. No fingerprinting. Daily-rotating visitor hash that resets every 24 hours. GDPR/CCPA compliant without a cookie banner.
- **Under 1KB** — The tracking script is smaller than most cookie consent popups.
- **Custom events** — Track signups, purchases, clicks, or anything else with `flarelytics.track('event', { props })`.
- **Scroll depth** — Optional IntersectionObserver-based tracking at 25/50/75/100% milestones.
- **Email reports** — Weekly digests with traffic trends, top pages, and anomaly alerts.
- **Open source** — MIT licensed. Self-host on your own Cloudflare account.

## Quick Start (5 minutes)

### 1. Deploy the worker

```bash
git clone https://github.com/kalle-works/flarelytics.git
cd flarelytics/packages/worker

# Edit wrangler.toml with your account_id and allowed origins
npx wrangler deploy
npx wrangler secret put QUERY_API_KEY    # random string for dashboard auth
npx wrangler secret put CF_API_TOKEN     # CF API token (Analytics Engine read)
npx wrangler secret put CF_ACCOUNT_ID    # your CF account ID
```

> **Quick setup:** Run `bash setup.sh` in the worker directory for an interactive guided setup that configures everything automatically.

### 2. Add the tracking script

```html
<!-- Basic tracking -->
<script defer data-endpoint="https://your-worker.workers.dev" src="/tracker.js"></script>

<!-- With scroll depth tracking -->
<script defer data-endpoint="https://your-worker.workers.dev" data-scroll-depth src="/tracker.js"></script>
```

Or with npm:

```bash
npm install @flarelytics/tracker
```

```js
import { init, track } from '@flarelytics/tracker'

// Basic
init('https://your-worker.workers.dev')

// With scroll depth tracking at 25/50/75/100% milestones
init('https://your-worker.workers.dev', { scrollDepth: true })

// Track custom events
track('signup', { props: { plan: 'pro' } })
```

### 3. Verify it works

```bash
# Check the worker is running
curl https://your-worker.workers.dev/health
# → { "status": "healthy", "checks": { "analytics_binding": true } }

# Visit your site, then check data is flowing (wait ~30 seconds)
curl -H "X-API-Key: your-api-key" \
  "https://your-worker.workers.dev/query?q=daily-views&period=7d&site=yoursite.com"
# → { "data": [{ "date": "2026-04-12", "views": 1 }] }
```

### 4. View your dashboard

Visit `https://flarelytics-dashboard.pages.dev` and enter your API key, worker URL, and site hostname.

## Architecture

```
packages/
  worker/         Cloudflare Worker: event tracking + query API
  tracker/        Client-side script (<1KB): pageviews, outbound links, custom events, scroll depth
  dashboard/      Astro static site: analytics dashboard with charts and tables
  email-reports/  Cloudflare Worker cron: weekly email digests
```

## Event Types

| Event | Tracked automatically | Description |
|---|---|---|
| `pageview` | Yes | Page load with referrer and UTM params |
| `outbound` | Yes | External link clicks |
| `timing` | Yes | Time on page in seconds (fires on `visibilitychange`) |
| `scroll_depth` | Opt-in | Scroll milestones at 25/50/75/100% |
| `(custom)` | Manual | Any event via `flarelytics.track()` |

## API

### Track events

```bash
POST /track
Content-Type: application/json

{
  "event": "pageview",
  "path": "/pricing",
  "referrer": "google.com",
  "utm_source": "newsletter"
}
```

### Custom events

```bash
POST /track

{
  "event": "signup",
  "path": "/pricing",
  "props": { "plan": "pro", "source": "hero-cta" }
}
```

### Query analytics

```bash
GET /query?q=<query-name>&period=30d&site=yoursite.com
X-API-Key: your-api-key
```

**Periods:** `7d`, `14d`, `30d`, `60d`, `90d`, `180d`

#### Available queries

**Traffic**

| Query | Params | Description |
|---|---|---|
| `top-pages` | | Most viewed pages |
| `top-pages-visitors` | | Top pages with views and unique visitor counts |
| `top-pages-stories` | | Top pages where path starts with `/a/` |
| `daily-views` | | Pageviews per day |
| `daily-unique-visitors` | | Unique visitors per day (+ total views) |
| `new-vs-returning` | | New vs returning visitors in the selected period |

**Referrers & Acquisition**

| Query | Params | Description |
|---|---|---|
| `referrers` | | Top referrer hostnames |
| `utm-campaigns` | | UTM campaign totals (source, medium, campaign) |
| `utm-campaign-trend` | | Daily UTM visits — when each post drove traffic |

**Content & Engagement**

| Query | Params | Description |
|---|---|---|
| `page-views-over-time` | `?page=/path` | Daily views + visitors for one page |
| `page-timing` | | Average time on page in seconds per path |
| `bounce-rate-by-page` | `?event_name=N` | Bounce % per page (threshold seconds, default 10) |
| `scroll-depth` | | Scroll depth distribution: how far visitors scroll across all pages |
| `scroll-depth-by-page` | | Scroll depth breakdown per page |

**Geography & Devices**

| Query | Params | Description |
|---|---|---|
| `countries` | | Views by country |
| `countries-by-page` | `?page=/path` | Country breakdown for one page |
| `devices` | | Pageviews by device type (mobile/tablet/desktop) |
| `browsers` | | Pageviews by browser |

**Conversions**

| Query | Params | Description |
|---|---|---|
| `outbound-links` | | External link click destinations |
| `page-performance` | | Pages with views vs custom event CTR |
| `custom-events` | | Custom event counts by name and properties |
| `conversion-funnel` | | Daily pageviews to custom events |
| `funnel-by-event` | `?event_name=signup` | Daily funnel for a specific custom event |

#### Example: scroll depth per page

```bash
GET /query?q=scroll-depth-by-page&period=30d&site=yoursite.com
X-API-Key: your-api-key
```

```json
{
  "data": [
    { "path": "/a/my-article", "depth": "25", "count": 142 },
    { "path": "/a/my-article", "depth": "50", "count": 98 },
    { "path": "/a/my-article", "depth": "75", "count": 61 },
    { "path": "/a/my-article", "depth": "100", "count": 34 }
  ]
}
```

#### Example: new vs returning visitors

```bash
GET /query?q=new-vs-returning&period=7d&site=yoursite.com
X-API-Key: your-api-key
```

```json
{
  "data": [{ "new_visitors": 83, "returning_visitors": 21, "total": 104 }]
}
```

#### Example: UTM campaign trend

```bash
GET /query?q=utm-campaign-trend&period=30d&site=yoursite.com
X-API-Key: your-api-key
```

```json
{
  "data": [
    { "date": "2026-04-08", "utm_source": "bluesky", "utm_campaign": "post-abc123", "visits": 47 },
    { "date": "2026-04-09", "utm_source": "bluesky", "utm_campaign": "post-abc123", "visits": 12 }
  ]
}
```

#### Example: bounce rate with custom threshold

```bash
GET /query?q=bounce-rate-by-page&period=30d&site=yoursite.com&event_name=30
X-API-Key: your-api-key
```

```json
{
  "data": [
    { "path": "/", "bounced": 120, "sessions": 340, "bounce_pct": 35.3 },
    { "path": "/pricing", "bounced": 45, "sessions": 210, "bounce_pct": 21.4 }
  ]
}
```

### Health check

```bash
GET /health
```

```json
{ "status": "healthy", "checks": { "analytics_binding": true, ... }, "version": "0.1.0" }
```

## Privacy

Flarelytics collects only what you need to understand your traffic:

| Collected | Why |
|---|---|
| Page path | Know which pages are visited |
| Referrer hostname | Know where traffic comes from |
| Country (from CF headers) | Geographic distribution |
| Daily visitor hash | Unique visitor count (resets daily) |
| UTM parameters | Campaign tracking |
| Device type, browser | Audience breakdown |
| Time on page (seconds) | Engagement measurement |
| Scroll depth milestones | Content engagement |
| Custom event data | Your defined events |

**Not collected:** IP addresses, raw user agents, cookies, device fingerprints, personal data.

The daily visitor hash is SHA-256 of `IP + User-Agent + date`. It resets every midnight UTC — impossible to track users across days.

## Analytics Engine Schema

Each event writes one row to Cloudflare Analytics Engine:

| Field | Value |
|---|---|
| `blob1` | Page path |
| `blob2` | Referrer hostname (`direct` if none) |
| `blob3` | Country code (from CF headers) |
| `blob4` | Event name (`pageview`, `timing`, `scroll_depth`, custom) |
| `blob5` | Event properties (pipe-separated values) |
| `blob6` | `utm_source` |
| `blob7` | `utm_medium` |
| `blob8` | `utm_campaign` |
| `blob9` | Visitor hash (daily-rotating) |
| `blob10` | Site hostname (for multi-site support) |
| `blob11` | Device type (`mobile`/`tablet`/`desktop`) |
| `blob12` | Browser name |
| `double1` | Event count (always 1) |
| `double2` | Time on page in seconds (only for `timing` events) |

## Comparison

| Feature | Flarelytics | Google Analytics | Plausible | Counterscale |
|---|---|---|---|---|
| Privacy-first | Yes | No | Yes | Yes |
| No cookies | Yes | No | Yes | Yes |
| Self-hosted | Yes | No | Yes | Yes |
| Runs on CF only | Yes | No | No | Yes |
| Scroll depth | Yes | Yes | No | No |
| Custom events | Yes | Yes | Yes | Limited |
| Email reports | Yes | Yes | Yes | No |
| Data retention | 90d (AE) | Unlimited | Unlimited | 90d |
| Setup time | 5 min | 10 min | 30 min | 5 min |
| Cost | Free (CF free tier) | Free | $20+/mo | Free |

## Multi-Site Setup

One worker can serve multiple sites. The site hostname is derived automatically from the `Origin` header on each `/track` request.

### 1. Allow multiple origins

In your `wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "https://site-a.com,https://site-b.com,https://blog.example.com"
```

### 2. Add the tracker to each site

Each site uses the same worker URL:

```html
<!-- On site-a.com -->
<script defer data-endpoint="https://your-worker.workers.dev" src="https://your-worker.workers.dev/tracker.js"></script>

<!-- On site-b.com — same script, same worker -->
<script defer data-endpoint="https://your-worker.workers.dev" src="https://your-worker.workers.dev/tracker.js"></script>
```

### 3. Query by site

All queries accept a `?site=` parameter to filter by hostname:

```bash
# Traffic for site-a.com only
curl -H "X-API-Key: your-key" "https://your-worker/query?q=daily-views&period=7d&site=site-a.com"

# Traffic for site-b.com
curl -H "X-API-Key: your-key" "https://your-worker/query?q=daily-views&period=7d&site=site-b.com"
```

The dashboard has a site switcher dropdown for switching between configured sites.

## Troubleshooting

### No data showing in dashboard

1. Check the worker is running: `curl https://your-worker.workers.dev/health`
2. Verify the tracking script is loaded: open browser DevTools → Network tab → look for `tracker.js`
3. Check CORS: your site's origin must be in `ALLOWED_ORIGINS` in wrangler.toml
4. Wait 30-60 seconds — Analytics Engine has a short ingestion delay

### "Unauthorized" on query endpoint

The `X-API-Key` header must match the `QUERY_API_KEY` secret you set:

```bash
# Set or update the key
npx wrangler secret put QUERY_API_KEY

# Test it
curl -H "X-API-Key: your-key" "https://your-worker/query?q=daily-views&period=7d&site=yoursite.com"
```

### "Forbidden" on /track

Your site's origin is not in `ALLOWED_ORIGINS`. Add it to `wrangler.toml` and redeploy:

```toml
[vars]
ALLOWED_ORIGINS = "https://yoursite.com,http://localhost:3000"
```

### Bot traffic overwhelming real data

Flarelytics filters bots automatically and records them separately. Check the Bot Traffic section in the dashboard to see what's being filtered. To add custom bot patterns, modify `DEFAULT_BOT_PATTERNS` in `packages/worker/src/index.ts`.

### Analytics Engine 90-day limit

Cloudflare Analytics Engine retains data for 90 days. For longer retention, set up the email reports worker to receive weekly digests, or query the API periodically and store results in KV or an external database.

## Development

```bash
npm install       # Install all workspace dependencies
npm run dev       # Start worker + dashboard in dev mode
npm run build     # Build all packages
npm run test      # Run tests
```

## License

MIT
