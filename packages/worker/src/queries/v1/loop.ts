/**
 * v1 Distribution Loop queries. Reads PAGEVIEW_EVENTS / ENGAGEMENT_EVENTS /
 * SHARE_EVENTS (Phase 0.5 dual-emit) and ties them together on
 * canonical_url_hash to render the editorial Loop view.
 *
 * MIGRATION_PLAN.md §4 Phase 0.5 deliverable: aggregates surface at
 * canonical_url_hash level, not content_id, because the queue consumer that
 * mints D1 content_ids ships in Phase 1. Kiiru maps 1 canonical = 1 article so
 * this is sufficient for the cutover gate (§6 "Distribution Loop view ≥3
 * editorial decisions").
 *
 * Functions in this file are pure — builders return SQL strings, aggregators
 * fold raw CF-API responses into the dashboard shape — so they're testable
 * without touching Analytics Engine.
 */

export interface LoopDatasets {
  pageview: string;
  engagement: string;
  share: string;
}

export const DEFAULT_LOOP_DATASETS: LoopDatasets = {
  pageview: 'flarelytics_pageview_v1',
  engagement: 'flarelytics_engagement_v1',
  share: 'flarelytics_share_v1',
};

export const TOP_ARTICLES_LIMIT = 20;

// Distinct visitors who hit at least this scroll % count as an "engaged read".
// Matches the tracker's IntersectionObserver milestones (25/50/75/100) — 75 is
// the strictest defensible threshold without requiring 100 % which would
// underweight long-form content.
export const ENGAGED_SCROLL_THRESHOLD = 75;

export interface LoopSqlBundle {
  sharesPerArticle: string;
  pageviewsPerArticle: string;
  pathsPerArticle: string;
  engagementPerArticle: string;
  socialInboundTotal: string;
  sharesTotal: string;
}

/**
 * Build the parallel-runnable SQL bundle for a single (period, site) window.
 * Callers MUST pre-validate `period` (PERIOD_MAP) and `site` (hostname regex)
 * — same gate the v0 handleQuery uses. Datasets are config-driven, never user
 * input. AE SQL has no parameter binding, so interpolated strings are the
 * only option.
 */
export function buildLoopSql(period: string, site: string, ds: LoopDatasets): LoopSqlBundle {
  const win = `timestamp > NOW() - INTERVAL ${period}`;
  const siteFilter = `blob2 = '${site}'`;

  return {
    sharesPerArticle: `
      SELECT blob3 AS canonical_url_hash,
             SUM(_sample_interval * double1) AS shares_out
      FROM ${ds.share}
      WHERE ${win} AND ${siteFilter}
      GROUP BY canonical_url_hash
      ORDER BY shares_out DESC
      LIMIT ${TOP_ARTICLES_LIMIT}
    `,
    pageviewsPerArticle: `
      SELECT blob3 AS canonical_url_hash,
             SUM(_sample_interval * double1) AS inbound_visits
      FROM ${ds.pageview}
      WHERE ${win} AND ${siteFilter}
      GROUP BY canonical_url_hash
    `,
    pathsPerArticle: `
      SELECT blob3 AS canonical_url_hash,
             blob5 AS path,
             SUM(_sample_interval * double1) AS views,
             MIN(timestamp) AS first_seen
      FROM ${ds.pageview}
      WHERE ${win} AND ${siteFilter}
      GROUP BY canonical_url_hash, path
    `,
    engagementPerArticle: `
      SELECT blob3 AS canonical_url_hash,
             COUNT(DISTINCT blob6) AS engaged_reads
      FROM ${ds.engagement}
      WHERE ${win} AND ${siteFilter}
        AND blob5 = 'scroll_depth' AND double2 >= ${ENGAGED_SCROLL_THRESHOLD}
      GROUP BY canonical_url_hash
    `,
    socialInboundTotal: `
      SELECT SUM(_sample_interval * double1) AS inbound_visits_from_social
      FROM ${ds.pageview}
      WHERE ${win} AND ${siteFilter} AND blob8 != ''
    `,
    sharesTotal: `
      SELECT SUM(_sample_interval * double1) AS shares_out_total,
             COUNT(DISTINCT blob3) AS articles_driving_shares
      FROM ${ds.share}
      WHERE ${win} AND ${siteFilter}
    `,
  };
}

// ─── Row types from the CF SQL API ──────────────────────────────────────────

export interface SharesRow { canonical_url_hash: string; shares_out: number }
export interface PageviewsRow { canonical_url_hash: string; inbound_visits: number }
export interface PathRow { canonical_url_hash: string; path: string; views: number; first_seen: string | null }
export interface EngagementRow { canonical_url_hash: string; engaged_reads: number }
export interface SocialInboundRow { inbound_visits_from_social: number | null }
export interface SharesTotalRow { shares_out_total: number | null; articles_driving_shares: number | null }

// ─── Output shape ───────────────────────────────────────────────────────────

export interface LoopArticleRow {
  canonical_url_hash: string;
  path: string;
  first_seen: string | null;
  shares_out: number;
  inbound_visits: number;
  engaged_reads: number;
  /** 0–100 integer. engaged_reads / inbound_visits × 100, capped at 100. */
  quality_score: number;
}

export interface LoopKpis {
  articles_driving_shares: number;
  inbound_visits_from_social: number;
  /** shares_out_total ÷ inbound_visits_from_social × 100, two decimals. 0 when no social inbound. */
  secondary_share_rate: number;
  /** Mean per-article quality score, scaled to 0.0–10.0, one decimal. */
  avg_distribution_quality_score: number;
}

export interface LoopOverview {
  period: string;
  site: string;
  kpis: LoopKpis;
  articles: LoopArticleRow[];
}

// ─── Aggregation helpers ────────────────────────────────────────────────────

function collapsePaths(rows: PathRow[]): Map<string, { path: string; first_seen: string | null }> {
  const acc = new Map<string, { path: string; views: number; first_seen: string | null }>();
  for (const r of rows) {
    const cur = acc.get(r.canonical_url_hash);
    const seen = r.first_seen ?? null;
    if (!cur) {
      acc.set(r.canonical_url_hash, { path: r.path, views: r.views, first_seen: seen });
      continue;
    }
    if (r.views > cur.views) {
      cur.path = r.path;
      cur.views = r.views;
    }
    if (seen && (!cur.first_seen || seen < cur.first_seen)) {
      cur.first_seen = seen;
    }
  }
  const out = new Map<string, { path: string; first_seen: string | null }>();
  for (const [k, v] of acc) out.set(k, { path: v.path, first_seen: v.first_seen });
  return out;
}

function indexBy<T extends { canonical_url_hash: string }>(rows: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const r of rows) m.set(r.canonical_url_hash, r);
  return m;
}

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function qualityScore(engaged: number, visits: number): number {
  if (visits <= 0) return 0;
  return Math.min(100, Math.round((engaged / visits) * 100));
}

export interface LoopRawData {
  sharesPerArticle: SharesRow[];
  pageviewsPerArticle: PageviewsRow[];
  pathsPerArticle: PathRow[];
  engagementPerArticle: EngagementRow[];
  socialInbound: SocialInboundRow[];
  sharesTotal: SharesTotalRow[];
}

export function aggregateLoop(period: string, site: string, raw: LoopRawData): LoopOverview {
  const pageviewsByHash = indexBy(raw.pageviewsPerArticle);
  const engagementByHash = indexBy(raw.engagementPerArticle);
  const pathByHash = collapsePaths(raw.pathsPerArticle);

  // Top articles — already sorted DESC by shares_out + LIMITed by SQL.
  const articles: LoopArticleRow[] = raw.sharesPerArticle.map((s) => {
    const inbound = num(pageviewsByHash.get(s.canonical_url_hash)?.inbound_visits);
    const engaged = num(engagementByHash.get(s.canonical_url_hash)?.engaged_reads);
    const meta = pathByHash.get(s.canonical_url_hash);
    return {
      canonical_url_hash: s.canonical_url_hash,
      path: meta?.path ?? '',
      first_seen: meta?.first_seen ?? null,
      shares_out: num(s.shares_out),
      inbound_visits: inbound,
      engaged_reads: engaged,
      quality_score: qualityScore(engaged, inbound),
    };
  });

  // KPIs.
  const sharesTotal = raw.sharesTotal[0];
  const sharesOutTotal = num(sharesTotal?.shares_out_total);
  const articlesDrivingShares = num(sharesTotal?.articles_driving_shares);
  const socialInbound = num(raw.socialInbound[0]?.inbound_visits_from_social);

  const secondaryShareRate = socialInbound > 0
    ? Math.round((sharesOutTotal / socialInbound) * 100 * 100) / 100
    : 0;

  // Mean quality across every article with at least 1 inbound visit (not just
  // top-20-by-shares, so leaders don't dominate the average).
  let sum = 0;
  let n = 0;
  for (const pv of raw.pageviewsPerArticle) {
    const inbound = num(pv.inbound_visits);
    if (inbound < 1) continue;
    const engaged = num(engagementByHash.get(pv.canonical_url_hash)?.engaged_reads);
    sum += qualityScore(engaged, inbound);
    n += 1;
  }
  const avg100 = n > 0 ? sum / n : 0;
  const avgDistributionQuality = Math.round(avg100 / 10 * 10) / 10; // 0.0–10.0

  return {
    period,
    site,
    kpis: {
      articles_driving_shares: articlesDrivingShares,
      inbound_visits_from_social: socialInbound,
      secondary_share_rate: secondaryShareRate,
      avg_distribution_quality_score: avgDistributionQuality,
    },
    articles,
  };
}
