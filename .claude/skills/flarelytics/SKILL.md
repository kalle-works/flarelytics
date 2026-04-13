---
name: flarelytics
description: |
  Add Flarelytics privacy-first analytics (Cloudflare Workers, no cookies) to any project.
  Detects tech stack, installs the tracker, configures origins, and verifies events are flowing.
  Use when: "add analytics", "add flarelytics", "track pageviews", "install tracker",
  "add scroll depth tracking", "set up web analytics", "query analytics", "get analytics data".
user-invocable: true
---

# Flarelytics Integration Skill

You are integrating Flarelytics — privacy-first, cookie-free web analytics on Cloudflare Workers.

Tracks: pageviews, outbound clicks, time on page, scroll depth (opt-in), bot hits, custom events.
No cookies. No PII. GDPR/CCPA compliant by design.
37 built-in queries + public stats endpoint (no API key needed).

Full query reference: `.claude/skills/flarelytics/references/queries.md` — load it if the user asks about available data or queries.

---

## Step 1: Get the worker URL

Ask the user:

> What is your Flarelytics worker URL? (e.g. `https://analytics.example.com`)
> Do you have a `QUERY_API_KEY`? (needed for dashboard/queries, not for tracking itself)

If they don't have a worker yet, tell them to deploy first:

```bash
git clone https://github.com/kalle-works/flarelytics.git
cd flarelytics/packages/worker
# Edit wrangler.toml: set account_id and ALLOWED_ORIGINS to include your site
npx wrangler deploy
npx wrangler secret put QUERY_API_KEY
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put CF_ACCOUNT_ID
```

Verify the worker is up before continuing:

```bash
curl https://<worker-url>/health
```

Expected: `{"status":"healthy",...}`

---

## Step 2: Detect tech stack

Check the project root:

| File | Stack |
|------|-------|
| `astro.config.*` | Astro |
| `next.config.*` | Next.js |
| `nuxt.config.*` | Nuxt |
| `svelte.config.*` | SvelteKit |
| `vite.config.*` | Vite |
| `package.json` only | Generic JS |
| No `package.json` | Static HTML |

---

## Step 3: Install the tracker

**Script tag (any stack):**

```html
<!-- Basic -->
<script defer data-endpoint="WORKER_URL" src="WORKER_URL/tracker.js"></script>

<!-- With scroll depth tracking (25/50/75/100%) -->
<script defer data-endpoint="WORKER_URL" data-scroll-depth src="WORKER_URL/tracker.js"></script>
```

**npm:**

```bash
npm install @flarelytics/tracker
```

```ts
import { init, track } from '@flarelytics/tracker'

init('WORKER_URL')                          // basic
init('WORKER_URL', { scrollDepth: true })   // with scroll depth

track('signup', { props: { plan: 'pro' } }) // custom event
```

**Stack-specific placement:**

- **Astro** — `src/layouts/BaseLayout.astro` inside `<head>`. Add a preconnect hint for faster loading:
  ```html
  <link rel="preconnect" href="WORKER_URL" crossorigin />
  <script defer data-endpoint="WORKER_URL" data-scroll-depth src="WORKER_URL/tracker.js"></script>
  ```
- **Next.js** — `app/layout.tsx` using `next/script` with `strategy="afterInteractive"`
  ```tsx
  import Script from 'next/script'
  <Script src="WORKER_URL/tracker.js" data-endpoint="WORKER_URL" strategy="afterInteractive" />
  ```
- **Nuxt** — `plugins/flarelytics.client.ts`
- **SvelteKit** — `src/app.html` or `src/routes/+layout.svelte`

**CSP headers:** If the site uses Content-Security-Policy, add the worker URL:
```
script-src 'self' WORKER_URL;
connect-src 'self' WORKER_URL;
```

---

## Step 4: Allow the origin

The worker only accepts events from origins in `ALLOWED_ORIGINS` (`wrangler.toml`). Check if the site's origin is already listed.

If not, add it and redeploy:

```toml
# packages/worker/wrangler.toml
[vars]
ALLOWED_ORIGINS = "https://yoursite.com,http://localhost:4321"
```

```bash
cd packages/worker && npx wrangler deploy
```

---

## Step 5: Verify events are flowing

Open the site in a browser, navigate to a page, then query:

```bash
curl "WORKER_URL/query?q=daily-views&period=7d&site=HOSTNAME" \
  -H "X-API-Key: QUERY_API_KEY"
```

`HOSTNAME` = bare hostname, e.g. `yoursite.com` (no `https://`).

Expected: `{"data":[{"date":"...","views":1}]}`

If `data` is empty, wait 30 seconds — Analytics Engine has a short ingestion delay. If still empty:
1. Check `Origin` header matches `ALLOWED_ORIGINS` exactly (no trailing slash)
2. Check browser Network tab — is `/track` returning 204?
3. Check for browser extensions blocking requests

---

## Step 6: Custom events (optional)

```ts
import { track } from '@flarelytics/tracker'

document.querySelector('#signup-btn')?.addEventListener('click', () => {
  track('signup', { props: { plan: 'pro', source: 'hero' } })
})
```

Script tag global:
```js
window.flarelytics.track('signup', { props: { plan: 'pro' } })
```

**Real-world examples (from kiiru.fi):**

```js
// Article read completion — fires when user scrolls to end AND spends 30+ seconds
window.flarelytics?.track('read_complete', { props: { time_seconds: String(seconds) } })

// Social share tracking
window.flarelytics?.track('share', { props: { method: 'bluesky', url: window.location.href } })

// Newsletter signup
window.flarelytics?.track('newsletter_signup', { props: { location: window.location.pathname } })
```

Use `window.flarelytics?.track()` with optional chaining — safe if the tracker hasn't loaded yet.

---

## Step 7: Query analytics data (optional)

For scripts or dashboards that need to fetch analytics programmatically:

```bash
# Public stats (no API key) — 30-day summary
curl "WORKER_URL/public-stats?site=HOSTNAME"

# Authenticated query — any of the 37 built-in queries
curl "WORKER_URL/query?q=top-pages&period=30d&site=HOSTNAME" \
  -H "X-API-Key: QUERY_API_KEY"

# Per-page drill-down
curl "WORKER_URL/query?q=referrers-by-page&period=30d&site=HOSTNAME&page=/my-article" \
  -H "X-API-Key: QUERY_API_KEY"

# Live data (last 30 minutes)
curl "WORKER_URL/query?q=live-visitors&period=7d&site=HOSTNAME" \
  -H "X-API-Key: QUERY_API_KEY"
```

See `.claude/skills/flarelytics/references/queries.md` for the full list of 37 queries.

---

## Done

Tell the user:

> Analytics are live. View your dashboard at https://flarelytics-dashboard.pages.dev
>
> Enter:
> - **Worker URL:** `WORKER_URL`
> - **API Key:** your `QUERY_API_KEY`
> - **Site:** `HOSTNAME`

---

## Installation (for contributors)

After cloning the repo, symlink the skill:

```bash
ln -s "$(pwd)/.claude/skills/flarelytics" ~/.claude/skills/flarelytics
```

Then `/flarelytics` is available in any Claude Code session.
