# Contributing to Flarelytics

Thanks for your interest in contributing.

## Setup

```bash
git clone https://github.com/kalle-works/flarelytics.git
cd flarelytics
npm install
npm run dev
```

Requires Node.js 22+ and a Cloudflare account for worker development.

## Development tools

- **Node.js 22+** — version pinned in `.nvmrc`, run `nvm use` to switch
- **EditorConfig** — formatting rules in `.editorconfig`, supported by most editors
- **Type check:** `npx tsc --noEmit` in any package directory
- **Tests:** `npx vitest run` in worker or tracker directories
- **Full check:** `npm run check` from the root (type-checks and tests all packages)
- **Pre-commit:** Run `bash scripts/pre-commit.sh` before committing, or set up as a git hook:
  ```bash
  ln -s ../../scripts/pre-commit.sh .git/hooks/pre-commit
  ```

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
