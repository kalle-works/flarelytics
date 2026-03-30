# Flarelytics

Privacy-first web analytics that runs entirely on Cloudflare. No cookies, no external dependencies, 5-minute setup.

**Website:** [flarelytics.dev](https://flarelytics.dev)

## Why Flarelytics?

- **100% Cloudflare** — Workers + Analytics Engine. No databases, no servers, no third-party services.
- **Privacy by architecture** — No cookies. No fingerprinting. Daily-rotating visitor hash that resets every 24 hours. GDPR/CCPA compliant without a cookie banner.
- **Under 1KB** — The tracking script is smaller than most cookie consent popups.
- **Custom events** — Track signups, purchases, clicks, or anything else with `flarelytics.track('event', { props })`.
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
<script defer src="https://your-worker.workers.dev/tracker.js"></script>
```

Or with npm:

```bash
npm install @flarelytics/tracker
```

```js
import { init, track } from '@flarelytics/tracker'

init('https://your-worker.workers.dev')

// Pageviews and outbound links are tracked automatically.
// Track custom events:
track('signup', { props: { plan: 'pro' } })
```

### 3. View your dashboard

Visit `https://your-site.com/dashboard` and enter your API key.

## Architecture

```
packages/
  worker/         Cloudflare Worker: event tracking + query API
  tracker/        Client-side script (<1KB): pageviews, outbound links, custom events
  dashboard/      Astro static site: analytics dashboard with charts and tables
  email-reports/  Cloudflare Worker cron: weekly email digests
```

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
GET /query?q=top-pages&period=30d
X-API-Key: your-api-key
```

Available queries: `top-pages`, `daily-views`, `daily-unique-visitors`, `referrers`, `countries`, `custom-events`, `outbound-links`, `page-performance`, `utm-campaigns`, `conversion-funnel`

Periods: `7d`, `30d`, `90d`

### Health check

```bash
GET /health
```

## Privacy

Flarelytics collects only what you need to understand your traffic:

| What's collected | Why |
|-----------------|-----|
| Page path | Know which pages are visited |
| Referrer hostname | Know where traffic comes from |
| Country (from CF headers) | Geographic distribution |
| Daily visitor hash | Unique visitor count (resets daily) |
| UTM parameters | Campaign tracking |
| Custom event data | Your defined events |

**What's NOT collected:** IP addresses, user agents, cookies, device fingerprints, personal data.

The daily visitor hash is a SHA-256 of `IP + User-Agent + date`. It resets every midnight UTC, making it impossible to track users across days.

## Comparison

| Feature | Flarelytics | Google Analytics | Plausible | Counterscale |
|---------|------------|-----------------|-----------|--------------|
| Privacy-first | Yes | No | Yes | Yes |
| No cookies | Yes | No | Yes | Yes |
| Self-hosted | Yes | No | Yes | Yes |
| Runs on CF only | Yes | No | No | Yes |
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
