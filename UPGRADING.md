# Upgrading Flarelytics

## 0.1.0 → 0.2.0

### Breaking changes

None.

### New features

- **Bot analytics:** Bot traffic is now recorded and visible in the dashboard. Previously bots were silently dropped. No action needed — the worker automatically starts recording bot hits after upgrade.
- **Time-on-page tracking:** The tracker now automatically fires `timing` events via `visibilitychange`. No configuration needed.
- **Article drill-down:** Click any row in Top Pages to see per-page analytics (views, visitors, scroll depth, referrers, countries, UTM).
- **Docs site:** Documentation is now available at flarelytics.dev/docs/.

### How to upgrade

1. Pull the latest code:
   ```bash
   git pull origin main
   ```

2. Redeploy the worker:
   ```bash
   cd packages/worker
   npx wrangler deploy
   ```

3. Redeploy the dashboard (if self-hosted):
   ```bash
   cd packages/dashboard
   npx wrangler pages deploy dist
   ```

4. Redeploy the landing page (if self-hosted):
   ```bash
   cd packages/landing
   npx astro build && npx wrangler pages deploy dist
   ```

The tracker script is served from your worker, so it updates automatically when you redeploy the worker.

### New queries

These queries are available after upgrading the worker:

| Query | Description |
|-------|-------------|
| `bot-hits` | Top bot user-agents |
| `bot-hits-total` | Total bot hit count |
| `bot-pages` | Pages most targeted by bots |
| `bot-daily` | Bot hits per day (trend) |
| `bot-countries` | Bot traffic by country |
| `referrers-by-page` | Referrers for a specific page (?page=) |
| `timing-by-page` | Avg time on a specific page (?page=) |
| `scroll-depth-for-page` | Scroll depth for a specific page (?page=) |
| `utm-by-page` | UTM campaigns for a specific page (?page=) |

### New error response format

Worker error responses now return JSON with hints:

```json
{ "error": "Unauthorized", "hint": "Include X-API-Key header with your QUERY_API_KEY." }
```

Previously errors returned bare strings like `"Unauthorized"`. If your code parses error responses, update it to expect JSON.
