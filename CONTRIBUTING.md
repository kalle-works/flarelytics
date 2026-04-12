# Contributing to Flarelytics

Thanks for your interest in contributing.

## Setup

```bash
git clone https://github.com/kalle-works/flarelytics.git
cd flarelytics
npm install
npm run dev
```

Requires Node.js 20+ and a Cloudflare account for worker development.

## Project structure

```
packages/
  worker/         CF Worker: tracking endpoint + query API
  tracker/        Client-side tracking script (<1KB)
  dashboard/      Astro static site: analytics dashboard
  email-reports/  CF Worker cron: weekly email digests
  landing/        Astro static site: flarelytics.dev
```

## Making changes

1. Create a feature branch from `main`
2. Use conventional commits: `feat(scope):`, `fix(scope):`, `docs:`, etc.
3. Run `npx tsc --noEmit` in the package you changed
4. Open a pull request against `main`

## Commit format

```
feat(worker): add new query template
fix(tracker): handle missing referrer
docs: update README with new API endpoint
```

## Code style

- TypeScript everywhere
- No external runtime dependencies in the tracker (must stay <1KB gzipped)
- Worker queries use Analytics Engine SQL — test with `wrangler dev`
- Dashboard is vanilla JS inside Astro (no framework)

## Reporting bugs

Open an issue with:
- What you expected
- What happened instead
- Steps to reproduce
- Worker version / browser / OS if relevant
