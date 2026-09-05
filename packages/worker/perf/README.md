# Performance baseline scripts

k6 scripts for the latency baselines and risk-gate measurements referenced in
`MIGRATION_PLAN.md §9 Task B` and `§4 Phase 1`. Run from a non-CF region
(developer laptop is fine).

## Files

| Script | Purpose |
|---|---|
| `baseline-track.js` | Sustained 100 RPS POST `/track` for 5 minutes — captures the v0 baseline used by the Phase 1 dual-emit risk gate (+30% ceiling). |

## Usage

```bash
# Baseline against staging worker (default target)
k6 run perf/baseline-track.js

# Override target / origin / rate / duration via env
TARGET=https://flarelytics-staging.kl100.workers.dev/track \
ORIGIN=https://staging-loadtest.flarelytics.test \
RATE=100 DURATION=5m \
  k6 run perf/baseline-track.js
```

## Setup

The baseline targets `flarelytics-staging` (separate AE dataset). Deploy it
first via the `[env.staging]` block in `wrangler.toml`:

```bash
npx wrangler deploy --env staging
# … run k6 …
npx wrangler delete --name flarelytics-staging
```

The staging worker writes to `flarelytics_staging`, so synthetic load never
lands in production analytics. Tear it down after each measurement round.

## Recorded baselines

See `MIGRATION_PLAN.md §9 Task B` for the locked baseline numbers.

## Lifecycle

This is a Phase 0/1 measurement harness for `MIGRATION_PLAN.md` §9 Task B, not
permanent tooling. It's needed again after the Phase 1 dual-emit deploy to
re-measure `/track` p99 against the Phase 0 baseline before promoting to
Phase 2 (§4). Once that Phase 1 → 2 gate is cleared, this directory can be
deleted.
