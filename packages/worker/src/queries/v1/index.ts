/**
 * v1 query orchestrator. One entry per registered query name, dispatched from
 * the /query endpoint when ?v=1 is present. Today only "loop-overview" lives
 * here — future v1 queries land in their own files under this directory and
 * register in V1_QUERIES.
 */

import {
  aggregateLoop,
  buildLoopSql,
  DEFAULT_LOOP_DATASETS,
  type EngagementRow,
  type LoopDatasets,
  type LoopOverview,
  type PageviewsRow,
  type PathRow,
  type SharesRow,
  type SharesTotalRow,
  type SocialInboundRow,
} from './loop';

export interface V1Env {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  PV_DATASET?: string;
  ENG_DATASET?: string;
  SHARE_DATASET?: string;
}

// 10 s leaves room inside the CF Workers wall-clock budget while letting AE
// SQL warm-cache misses (~1–3 s typical) breathe on slow responses.
const CF_SQL_TIMEOUT_MS = 10_000;

function loopDatasets(env: V1Env): LoopDatasets {
  return {
    pageview: env.PV_DATASET || DEFAULT_LOOP_DATASETS.pageview,
    engagement: env.ENG_DATASET || DEFAULT_LOOP_DATASETS.engagement,
    share: env.SHARE_DATASET || DEFAULT_LOOP_DATASETS.share,
  };
}

async function runCFSql(env: V1Env, sql: string, signal?: AbortSignal): Promise<{ data?: any[] }> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      body: sql.trim(),
      signal: signal ?? AbortSignal.timeout(CF_SQL_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CF SQL API ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ data?: any[] }>;
}

/** Settled-tolerant runner. Returns rows on success, null on failure (logs the error). */
async function tryRun<T>(env: V1Env, sql: string, label: string, signal: AbortSignal): Promise<T[] | null> {
  try {
    const result = await runCFSql(env, sql, signal);
    return (result.data ?? []) as T[];
  } catch (err) {
    console.log(`[loop-overview] ${label} bucket failed: ${err}`);
    return null;
  }
}

export async function runLoopOverview(env: V1Env, period: string, site: string): Promise<LoopOverview> {
  const ds = loopDatasets(env);
  const sql = buildLoopSql(period, site, ds);
  // Shared abort: if any bucket throws unrelated to the per-call timeout, the
  // others can be cancelled to free their subrequests early. Per-bucket
  // timeout still fires via AbortSignal.timeout below.
  const sharedAbort = AbortSignal.timeout(CF_SQL_TIMEOUT_MS);

  const [shares, pageviews, paths, engagement, socialInbound, sharesTotal] = await Promise.all([
    tryRun<SharesRow>(env, sql.sharesPerArticle, 'shares', sharedAbort),
    tryRun<PageviewsRow>(env, sql.pageviewsPerArticle, 'pageviews', sharedAbort),
    tryRun<PathRow>(env, sql.pathsPerArticle, 'paths', sharedAbort),
    tryRun<EngagementRow>(env, sql.engagementPerArticle, 'engagement', sharedAbort),
    tryRun<SocialInboundRow>(env, sql.socialInboundTotal, 'socialInbound', sharedAbort),
    tryRun<SharesTotalRow>(env, sql.sharesTotal, 'sharesTotal', sharedAbort),
  ]);

  return aggregateLoop(period, site, {
    sharesPerArticle: shares,
    pageviewsPerArticle: pageviews,
    pathsPerArticle: paths,
    engagementPerArticle: engagement,
    socialInbound,
    sharesTotal,
  });
}

export interface V1QueryDef {
  description: string;
  run: (env: V1Env, period: string, site: string) => Promise<unknown>;
}

export const V1_QUERIES: Record<string, V1QueryDef> = {
  'loop-overview': {
    description: 'Distribution Loop overview — KPIs + top articles (shares → visits → engaged reads → quality)',
    run: runLoopOverview,
  },
};

export function isV1Query(name: string): boolean {
  // Object.hasOwn avoids the prototype-chain footgun where 'toString' / '__proto__'
  // would resolve to inherited properties and crash inside the dispatch.
  return Object.hasOwn(V1_QUERIES, name);
}
