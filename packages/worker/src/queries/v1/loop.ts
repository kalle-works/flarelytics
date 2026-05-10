/**
 * v1 Distribution Loop queries. Reads PAGEVIEW_EVENTS / ENGAGEMENT_EVENTS /
 * SHARE_EVENTS (Phase 0.5 dual-emit) and ties them together on
 * canonical_url_hash to render the editorial Loop view.
 *
 * MIGRATION_PLAN.md §4 Phase 0.5 deliverable: aggregates surface at
 * canonical_url_hash level, not content_id, because the queue consumer that
 * mints D1 content_ids ships in Phase 1 (TODO(phase-1): swap to content_id).
 *
 * Functions in this file are pure — builders return SQL strings, aggregators
 * fold raw CF-API responses into the dashboard shape — so they're testable
 * without touching Analytics Engine.
 *
 * Two intentional filters scope the loop view to social distribution semantics:
 *
 *   1. shares_out counts only share_v1 rows whose share_target_platform was
 *      recognized by parseReferrer (blob4 NOT IN ('other', '')). The dual-emit
 *      writes every outbound click as a share_v1 row, so without this filter
 *      every external link click (source links, ads, embeds) inflates
 *      shares_out. Filter lives here, not in dual-emit, so the underlying
 *      data stays uncolored for Phase 1 alternative views.
 *
 *   2. inbound_visits_from_social falls back to a referrer_domain hostname
 *      allowlist (blob6 IN SOCIAL_REFERRER_HOSTS) instead of the
 *      social_platform field, because the tracker today sends only the
 *      referrer hostname (no path) and parseReferrer needs paths to set
 *      social_platform for most platforms — see comment in handleTrack on
 *      the v1 dual-emit. Once the tracker emits full referrer URLs, the
 *      hostname check still matches and the platform-extraction layer can
 *      enrich on top.
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
// Path/canonical cardinality cap — a busy site with many query-string variants
// per article can balloon the (canonical, path) cross-product. Cap keeps the
// CF SQL response small enough for the worker to fold in memory.
export const PATHS_QUERY_LIMIT = 500;

// Distinct visitors who hit at least this scroll % count as an "engaged read".
// Matches the tracker's IntersectionObserver milestones (25/50/75/100) — 75 is
// the strictest defensible threshold without requiring 100 % which would
// underweight long-form content.
export const ENGAGED_SCROLL_THRESHOLD = 75;

// Hostnames that count as "social inbound" when present in pageview blob6
// (referrer_domain). Mirrors what parseReferrer in src/referrer/index.ts
// recognizes, plus a short list of common social/aggregator hosts that lack
// path-extractable post IDs. Keep in sync with the parser when adding new
// social platforms.
export const SOCIAL_REFERRER_HOSTS: readonly string[] = [
  'bsky.app',
  'facebook.com', 'm.facebook.com', 'l.facebook.com',
  'news.ycombinator.com',
  'reddit.com', 'old.reddit.com', 'new.reddit.com',
  't.co',
  'twitter.com', 'x.com',
  'mastodon.social',
  'linkedin.com', 'lnkd.in',
  'threads.net',
];

// Platform names that parseReferrer emits when it recognizes a share-target
// URL. Anything else lands as 'other' (in the dual-emit fallback) or '' (when
// the URL is missing). The loop counts only recognized platforms so editorial
// users don't see ad-link clicks as shares.
export const RECOGNIZED_SHARE_PLATFORMS: readonly string[] = [
  'bluesky', 'facebook', 'hn', 'reddit', 'x', 'mastodon',
];

function sqlList(values: readonly string[]): string {
  // values are hardcoded constants above — never user input — but keep the
  // quote-escaping defensive in case the lists grow.
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
}

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
  const hashNotEmpty = `blob3 != ''`;
  const sharePlatformIn = `blob4 IN (${sqlList(RECOGNIZED_SHARE_PLATFORMS)})`;
  const socialHostIn = `blob6 IN (${sqlList(SOCIAL_REFERRER_HOSTS)})`;

  return {
    sharesPerArticle: `
      SELECT blob3 AS canonical_url_hash,
             SUM(_sample_interval * double1) AS shares_out
      FROM ${ds.share}
      WHERE ${win} AND ${siteFilter} AND ${hashNotEmpty} AND ${sharePlatformIn}
      GROUP BY canonical_url_hash
      ORDER BY shares_out DESC
      LIMIT ${TOP_ARTICLES_LIMIT}
    `,
    pageviewsPerArticle: `
      SELECT blob3 AS canonical_url_hash,
             SUM(_sample_interval * double1) AS inbound_visits
      FROM ${ds.pageview}
      WHERE ${win} AND ${siteFilter} AND ${hashNotEmpty}
      GROUP BY canonical_url_hash
    `,
    pathsPerArticle: `
      SELECT blob3 AS canonical_url_hash,
             blob5 AS path,
             SUM(_sample_interval * double1) AS views,
             MIN(timestamp) AS first_seen
      FROM ${ds.pageview}
      WHERE ${win} AND ${siteFilter} AND ${hashNotEmpty}
      GROUP BY canonical_url_hash, path
      ORDER BY views DESC
      LIMIT ${PATHS_QUERY_LIMIT}
    `,
    engagementPerArticle: `
      SELECT blob3 AS canonical_url_hash,
             COUNT(DISTINCT blob6) AS engaged_reads
      FROM ${ds.engagement}
      WHERE ${win} AND ${siteFilter} AND ${hashNotEmpty}
        AND blob5 = 'scroll_depth' AND double2 >= ${ENGAGED_SCROLL_THRESHOLD}
      GROUP BY canonical_url_hash
    `,
    socialInboundTotal: `
      SELECT SUM(_sample_interval * double1) AS inbound_visits_from_social
      FROM ${ds.pageview}
      WHERE ${win} AND ${siteFilter} AND ${hashNotEmpty} AND ${socialHostIn}
    `,
    sharesTotal: `
      SELECT SUM(_sample_interval * double1) AS shares_out_total,
             COUNT(DISTINCT blob3) AS articles_driving_shares
      FROM ${ds.share}
      WHERE ${win} AND ${siteFilter} AND ${hashNotEmpty} AND ${sharePlatformIn}
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
  /** null when the underlying SQL bucket failed; UI renders '—'. */
  articles_driving_shares: number | null;
  inbound_visits_from_social: number | null;
  /** shares_out_total ÷ inbound_visits_from_social × 100, two decimals. 0 when no social inbound. */
  secondary_share_rate: number | null;
  /** Mean per-article quality score, scaled to 0.0–10.0, one decimal. */
  avg_distribution_quality_score: number | null;
}

/**
 * Per-bucket health for the partial-failure path. UI uses this to badge the
 * KPIs as '(partial)' when one of the six SQL calls failed.
 */
export interface LoopBucketStatus {
  shares: 'ok' | 'failed';
  pageviews: 'ok' | 'failed';
  paths: 'ok' | 'failed';
  engagement: 'ok' | 'failed';
  socialInbound: 'ok' | 'failed';
  sharesTotal: 'ok' | 'failed';
}

export interface LoopOverview {
  period: string;
  site: string;
  kpis: LoopKpis;
  articles: LoopArticleRow[];
  /** True when at least one of the six CF SQL calls failed but others succeeded. */
  partial: boolean;
  status: LoopBucketStatus;
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

/** Rows-or-null per bucket; null marks a failed CF SQL call so the aggregator can render partial KPIs. */
export interface LoopRawData {
  sharesPerArticle: SharesRow[] | null;
  pageviewsPerArticle: PageviewsRow[] | null;
  pathsPerArticle: PathRow[] | null;
  engagementPerArticle: EngagementRow[] | null;
  socialInbound: SocialInboundRow[] | null;
  sharesTotal: SharesTotalRow[] | null;
}

export function aggregateLoop(period: string, site: string, raw: LoopRawData): LoopOverview {
  const status: LoopBucketStatus = {
    shares: raw.sharesPerArticle == null ? 'failed' : 'ok',
    pageviews: raw.pageviewsPerArticle == null ? 'failed' : 'ok',
    paths: raw.pathsPerArticle == null ? 'failed' : 'ok',
    engagement: raw.engagementPerArticle == null ? 'failed' : 'ok',
    socialInbound: raw.socialInbound == null ? 'failed' : 'ok',
    sharesTotal: raw.sharesTotal == null ? 'failed' : 'ok',
  };
  const partial = Object.values(status).some((s) => s === 'failed');

  const pageviewsByHash = indexBy(raw.pageviewsPerArticle ?? []);
  const engagementByHash = indexBy(raw.engagementPerArticle ?? []);
  const pathByHash = collapsePaths(raw.pathsPerArticle ?? []);

  // Top articles — already sorted DESC by shares_out + LIMITed by SQL. When
  // shares bucket failed, the article list is empty (we don't synthesize one
  // from pageviews because the column ordering is "by shares").
  const articles: LoopArticleRow[] = (raw.sharesPerArticle ?? []).map((s) => {
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

  // KPIs — null when the underlying bucket failed; downstream UI renders '—'.
  const sharesTotalRow = raw.sharesTotal?.[0];
  const sharesOutTotal = num(sharesTotalRow?.shares_out_total);
  const articlesDrivingShares = raw.sharesTotal == null ? null : num(sharesTotalRow?.articles_driving_shares);

  const socialInboundVal = raw.socialInbound?.[0]?.inbound_visits_from_social;
  const socialInbound = raw.socialInbound == null ? null : num(socialInboundVal);

  let secondaryShareRate: number | null;
  if (raw.socialInbound == null || raw.sharesTotal == null) {
    secondaryShareRate = null;
  } else if (socialInbound != null && socialInbound > 0) {
    secondaryShareRate = Math.round((sharesOutTotal / socialInbound) * 100 * 100) / 100;
  } else {
    secondaryShareRate = 0;
  }

  // Mean quality across every article with at least 1 inbound visit (not just
  // top-20-by-shares, so leaders don't dominate the average).
  let avgDistributionQuality: number | null = null;
  if (raw.pageviewsPerArticle != null && raw.engagementPerArticle != null) {
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
    avgDistributionQuality = Math.round(avg100) / 10; // 0.0–10.0
  }

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
    partial,
    status,
  };
}
