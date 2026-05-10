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
  type LoopDatasets,
  type LoopOverview,
} from './loop';

export interface V1Env {
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  PV_DATASET?: string;
  ENG_DATASET?: string;
  SHARE_DATASET?: string;
}

function loopDatasets(env: V1Env): LoopDatasets {
  return {
    pageview: env.PV_DATASET || DEFAULT_LOOP_DATASETS.pageview,
    engagement: env.ENG_DATASET || DEFAULT_LOOP_DATASETS.engagement,
    share: env.SHARE_DATASET || DEFAULT_LOOP_DATASETS.share,
  };
}

async function runCFSql(env: V1Env, sql: string): Promise<{ data?: any[] }> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      body: sql.trim(),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CF SQL API ${res.status}: ${text}`);
  }
  return res.json() as Promise<{ data?: any[] }>;
}

export async function runLoopOverview(env: V1Env, period: string, site: string): Promise<LoopOverview> {
  const ds = loopDatasets(env);
  const sql = buildLoopSql(period, site, ds);
  const [shares, pageviews, paths, engagement, socialInbound, sharesTotal] = await Promise.all([
    runCFSql(env, sql.sharesPerArticle),
    runCFSql(env, sql.pageviewsPerArticle),
    runCFSql(env, sql.pathsPerArticle),
    runCFSql(env, sql.engagementPerArticle),
    runCFSql(env, sql.socialInboundTotal),
    runCFSql(env, sql.sharesTotal),
  ]);

  return aggregateLoop(period, site, {
    sharesPerArticle: shares.data ?? [],
    pageviewsPerArticle: pageviews.data ?? [],
    pathsPerArticle: paths.data ?? [],
    engagementPerArticle: engagement.data ?? [],
    socialInbound: socialInbound.data ?? [],
    sharesTotal: sharesTotal.data ?? [],
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
  return name in V1_QUERIES;
}
