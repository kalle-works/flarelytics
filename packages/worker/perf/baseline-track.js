/**
 * Baseline /track p99 measurement — MIGRATION_PLAN.md §9 Task B.
 *
 * Sustained 100 RPS for 5 minutes against the staging worker. Captures
 * p50/p95/p99 latency to lock the Phase 0 baseline that the Phase 1
 * dual-emit risk gate compares against (target: dual-emit p99 within
 * +30% of baseline).
 *
 * Run:
 *   k6 run packages/worker/perf/baseline-track.js
 *
 * The staging worker writes to a separate AE dataset (`flarelytics_staging`)
 * so this synthetic load never lands in production analytics. Tear down
 * with `npx wrangler delete --name flarelytics-staging` after the run.
 */

import http from 'k6/http';
import { check } from 'k6';

const TARGET = __ENV.TARGET || 'https://flarelytics-staging.kl100.workers.dev/track';
const ORIGIN = __ENV.ORIGIN || 'https://staging-loadtest.flarelytics.test';
const RATE = parseInt(__ENV.RATE || '100', 10);
const DURATION = __ENV.DURATION || '5m';

export const options = {
  scenarios: {
    constant_rps: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 50,
      maxVUs: 200,
      gracefulStop: '10s',
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(50)', 'p(75)', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(99)<2000'],
  },
};

const BODY = JSON.stringify({ event: 'pageview', path: '/perf-baseline' });
const PARAMS = {
  headers: {
    'Origin': ORIGIN,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 k6-baseline-track',
  },
  tags: { name: 'POST /track' },
};

export default function () {
  const res = http.post(TARGET, BODY, PARAMS);
  check(res, { 'status is 204': (r) => r.status === 204 });
}
