# Changelog

## 0.2.0 — 2026-04-12

### Added
- **Bot analytics:** Worker records bot hits to Analytics Engine. Dashboard shows bot trend chart, category breakdown (search engines, AI crawlers, SEO tools, social, monitoring), top targeted pages, and origin countries.
- **Article drill-down:** Click any row in Top Pages or Top Articles to open a detail panel with daily views/visitors chart, avg time on page, scroll depth funnel, referrers, countries, and UTM campaigns for that page.
- **Time-on-page tracking:** Tracker automatically fires a `timing` event via `visibilitychange` with seconds spent on page.
- **UTM per page:** Drill-down panel shows which UTM campaigns drove traffic to each page.

### Fixed
- Worker error responses now return JSON with `error` and `hint` fields instead of bare strings.
- Landing site serves proper 404 page instead of silently falling back to the homepage.
- `npm run build` works out of the box (added `packageManager` field to package.json).
- Dashboard hardcoded colors replaced with CSS variables (`--data-muted`, `--accent-hover`).

### Changed
- DESIGN.md updated with new component patterns (progress bars, scroll depth funnel, drill-down modal, data viz charts) and `--data-muted` color for bot/filtered data visualization.

## 0.1.0 — 2026-03-30

Initial release.

- Cloudflare Worker with event tracking endpoint and 23 query templates
- Vanilla JS tracker (<1KB gzipped) with pageview, outbound link, and custom event tracking
- Opt-in scroll depth tracking via IntersectionObserver
- Astro dashboard with traffic charts, top pages, referrers, countries, devices, browsers, UTM campaigns, outbound links, conversion funnels
- Live panel with 30-min visitors, active pages, referrer sources, 24-hour chart
- Email reports worker with weekly digest, anomaly detection, recipient management
- Multi-site support via Origin header
- Daily-rotating visitor hash (SHA-256) for privacy-first unique visitor counts
- Bot filtering with configurable patterns
- Landing page at flarelytics.dev
