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

### 3. View your dashboard

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
| `timing` | Yes | Time on page (fires on `visibilitychange`) |
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

#### Available queries

**Traffic**

| Query | Description |
|---|---|
| `top-pages` | Most viewed pages |
| `top-pages-visitors` | Top pages with views and unique visitor counts |
| `top-pages-stories` | Top pages where path starts with `/a/` |
| `daily-views` | Pageviews per day |
| `daily-unique-visitors` | Unique visitors per day |
| `new-vs-returning` | New vs returning visitors in the selected period |

**Referrers & Acquisition**

| Query | Params | Description |
|---|---|---|
| `referrers` | | Top referrer hostnames |
| `utm-campaigns` | | UTM campaign totals |
| `utm-campaign-trend` | | Daily UTM visits — shows when each post drove traffic |

**Content & Engagement**

| Query | Params | Description |
|---|---|---|
| `page-views-over-time` | `?page=/path` | Daily views+visitors for one page |
| `page-timing` | | Average time on page in seconds |
| `bounce-rate-by-page` | `?event_name=10` | Bounce % per page (threshold in seconds, default 10) |
| `scroll-depth` | | Scroll depth distribution across all pages |
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
| `conversion-funnel` | | Daily pageviews to custom events |
| `funnel-by-event` | `?event_name=signup` | Daily funnel for a specific event |

**Periods:** `7d`, `14d`, `30d`, `60d`, `90d`, `180d`

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
| Custom event data | Your defined events |

**Not collected:** IP addresses, raw user agents, cookies, device fingerprints, personal data.

The daily visitor hash is SHA-256 of `IP + User-Agent + date`. It resets every midnight UTC — impossible to track users across days.

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

## Development

```bash
npm install       # Install all workspace dependencies
npm run dev       # Start worker + dashboard in dev mode
npm run build     # Build all packages
npm run test      # Run tests
```

## License

MIT
