import { describe, expect, it } from 'vitest';
import {
  aggregateLoop,
  buildLoopSql,
  DEFAULT_LOOP_DATASETS,
  ENGAGED_SCROLL_THRESHOLD,
  PATHS_QUERY_LIMIT,
  RECOGNIZED_SHARE_PLATFORMS,
  SOCIAL_REFERRER_HOSTS,
  TOP_ARTICLES_LIMIT,
  type LoopRawData,
} from './loop';

describe('buildLoopSql', () => {
  const sql = buildLoopSql("'30' DAY", 'kiiru.fi', DEFAULT_LOOP_DATASETS);

  it('scopes every query to the period and site', () => {
    for (const key of Object.keys(sql) as (keyof typeof sql)[]) {
      expect(sql[key]).toContain("INTERVAL '30' DAY");
      expect(sql[key]).toContain("blob2 = 'kiiru.fi'");
    }
  });

  it('reads each family from its dedicated v1 dataset', () => {
    expect(sql.sharesPerArticle).toContain('flarelytics_share_v1');
    expect(sql.sharesTotal).toContain('flarelytics_share_v1');
    expect(sql.pageviewsPerArticle).toContain('flarelytics_pageview_v1');
    expect(sql.pathsPerArticle).toContain('flarelytics_pageview_v1');
    expect(sql.socialInboundTotal).toContain('flarelytics_pageview_v1');
    expect(sql.engagementPerArticle).toContain('flarelytics_engagement_v1');
  });

  it('limits top-articles to TOP_ARTICLES_LIMIT and orders by shares_out', () => {
    expect(sql.sharesPerArticle).toContain(`LIMIT ${TOP_ARTICLES_LIMIT}`);
    expect(sql.sharesPerArticle).toContain('ORDER BY shares_out DESC');
  });

  it('caps pathsPerArticle so high-cardinality sites do not balloon the response', () => {
    expect(sql.pathsPerArticle).toContain(`LIMIT ${PATHS_QUERY_LIMIT}`);
    expect(sql.pathsPerArticle).toContain('ORDER BY views DESC');
  });

  it('engagement query filters by engagement_type and scroll threshold', () => {
    expect(sql.engagementPerArticle).toContain("blob5 = 'scroll_depth'");
    expect(sql.engagementPerArticle).toContain(`double2 >= ${ENGAGED_SCROLL_THRESHOLD}`);
  });

  it('social-inbound total filters by referrer_domain hostname allowlist', () => {
    // Verify the hostname list is interpolated as a SQL IN clause on blob6
    // (referrer_domain) — not blob8 (social_platform), which the tracker
    // cannot populate with hostname-only referrers.
    expect(sql.socialInboundTotal).toContain('blob6 IN');
    for (const host of SOCIAL_REFERRER_HOSTS) {
      expect(sql.socialInboundTotal).toContain(`'${host}'`);
    }
  });

  it('share queries filter to recognized share-target platforms only', () => {
    expect(sql.sharesPerArticle).toContain('blob4 IN');
    expect(sql.sharesTotal).toContain('blob4 IN');
    for (const p of RECOGNIZED_SHARE_PLATFORMS) {
      expect(sql.sharesPerArticle).toContain(`'${p}'`);
      expect(sql.sharesTotal).toContain(`'${p}'`);
    }
    // No 'other' — the dual-emit fallback for unrecognized targets must NOT
    // count toward shares_out (it represents arbitrary outbound clicks).
    expect(sql.sharesPerArticle).not.toContain("'other'");
    expect(sql.sharesTotal).not.toContain("'other'");
  });

  it('every query excludes empty canonical_url_hash', () => {
    for (const key of Object.keys(sql) as (keyof typeof sql)[]) {
      expect(sql[key]).toContain("blob3 != ''");
    }
  });
});

describe('aggregateLoop', () => {
  const baseRaw: LoopRawData = {
    sharesPerArticle: [
      { canonical_url_hash: 'a1', shares_out: 125 },
      { canonical_url_hash: 'b2', shares_out: 98 },
      { canonical_url_hash: 'c3', shares_out: 50 },
    ],
    pageviewsPerArticle: [
      { canonical_url_hash: 'a1', inbound_visits: 846 },
      { canonical_url_hash: 'b2', inbound_visits: 572 },
      { canonical_url_hash: 'c3', inbound_visits: 100 },
      // d4 has visits but no shares — should NOT appear in articles list
      { canonical_url_hash: 'd4', inbound_visits: 200 },
    ],
    pathsPerArticle: [
      { canonical_url_hash: 'a1', path: '/breaking', views: 800, first_seen: '2026-05-01T10:00:00Z' },
      { canonical_url_hash: 'a1', path: '/breaking?utm=x', views: 46, first_seen: '2026-05-02T08:00:00Z' },
      { canonical_url_hash: 'b2', path: '/howto', views: 572, first_seen: '2026-05-03T12:00:00Z' },
      { canonical_url_hash: 'c3', path: '/tips', views: 100, first_seen: '2026-05-05T09:00:00Z' },
      { canonical_url_hash: 'd4', path: '/about', views: 200, first_seen: '2026-04-30T00:00:00Z' },
    ],
    engagementPerArticle: [
      { canonical_url_hash: 'a1', engaged_reads: 488 },
      { canonical_url_hash: 'b2', engaged_reads: 137 },
      // c3 has no engagement at all
      { canonical_url_hash: 'd4', engaged_reads: 50 },
    ],
    socialInbound: [{ inbound_visits_from_social: 2341 }],
    sharesTotal: [{ shares_out_total: 273, articles_driving_shares: 47 }],
  };

  const result = aggregateLoop("'30' DAY", 'kiiru.fi', baseRaw);

  it('returns articles only for canonicals that drove shares (sorted as input)', () => {
    expect(result.articles.map((a) => a.canonical_url_hash)).toEqual(['a1', 'b2', 'c3']);
  });

  it('picks the most-viewed path per canonical and the earliest first_seen', () => {
    const a1 = result.articles[0];
    expect(a1.path).toBe('/breaking');
    expect(a1.first_seen).toBe('2026-05-01T10:00:00Z');
  });

  it('keeps the first-seen path on a views tie and picks the earliest first_seen', () => {
    const out = aggregateLoop("'30' DAY", 'kiiru.fi', {
      sharesPerArticle: [{ canonical_url_hash: 'tie', shares_out: 1 }],
      pageviewsPerArticle: [{ canonical_url_hash: 'tie', inbound_visits: 100 }],
      pathsPerArticle: [
        { canonical_url_hash: 'tie', path: '/first', views: 50, first_seen: '2026-05-02T00:00:00Z' },
        { canonical_url_hash: 'tie', path: '/second', views: 50, first_seen: '2026-05-01T00:00:00Z' },
      ],
      engagementPerArticle: [],
      socialInbound: [],
      sharesTotal: [],
    });
    expect(out.articles[0].path).toBe('/first');
    expect(out.articles[0].first_seen).toBe('2026-05-01T00:00:00Z');
  });

  it('computes quality_score = round(engaged ÷ visits × 100)', () => {
    expect(result.articles[0].quality_score).toBe(58); // 488/846 = 0.5768 → 58
    expect(result.articles[1].quality_score).toBe(24); // 137/572 = 0.2395 → 24
    expect(result.articles[2].quality_score).toBe(0);  // no engagement
  });

  it('caps quality_score at 100 even when engaged > visits', () => {
    const out = aggregateLoop("'30' DAY", 'kiiru.fi', {
      ...baseRaw,
      sharesPerArticle: [{ canonical_url_hash: 'x', shares_out: 1 }],
      pageviewsPerArticle: [{ canonical_url_hash: 'x', inbound_visits: 5 }],
      engagementPerArticle: [{ canonical_url_hash: 'x', engaged_reads: 50 }],
      pathsPerArticle: [{ canonical_url_hash: 'x', path: '/x', views: 5, first_seen: '2026-05-01T00:00:00Z' }],
    });
    expect(out.articles[0].quality_score).toBe(100);
  });

  it('passes through KPI totals from CF rows', () => {
    expect(result.kpis.articles_driving_shares).toBe(47);
    expect(result.kpis.inbound_visits_from_social).toBe(2341);
  });

  it('computes secondary_share_rate = shares_total / social_inbound × 100', () => {
    // 273 / 2341 = 0.11662 → 11.66
    expect(result.kpis.secondary_share_rate).toBe(11.66);
  });

  it('avg_distribution_quality_score is mean of per-article scores ÷ 10, one decimal', () => {
    // a1=58, b2=24, c3=0, d4=qualityScore(50,200)=25 → mean = 26.75 → /10 = 2.7
    expect(result.kpis.avg_distribution_quality_score).toBe(2.7);
  });

  it('reports partial=false and all-ok status when every bucket succeeded', () => {
    expect(result.partial).toBe(false);
    expect(result.status).toEqual({
      shares: 'ok', pageviews: 'ok', paths: 'ok',
      engagement: 'ok', socialInbound: 'ok', sharesTotal: 'ok',
    });
  });

  it('handles empty inputs without throwing', () => {
    const empty = aggregateLoop("'7' DAY", 'kiiru.fi', {
      sharesPerArticle: [],
      pageviewsPerArticle: [],
      pathsPerArticle: [],
      engagementPerArticle: [],
      socialInbound: [],
      sharesTotal: [],
    });
    expect(empty.articles).toEqual([]);
    expect(empty.kpis).toEqual({
      articles_driving_shares: 0,
      inbound_visits_from_social: 0,
      secondary_share_rate: 0,
      avg_distribution_quality_score: 0,
    });
    expect(empty.partial).toBe(false);
  });

  it('coerces null/string CF API numbers to numbers', () => {
    const messy = aggregateLoop("'7' DAY", 'kiiru.fi', {
      sharesPerArticle: [{ canonical_url_hash: 'a', shares_out: '12' as unknown as number }],
      pageviewsPerArticle: [{ canonical_url_hash: 'a', inbound_visits: '100' as unknown as number }],
      pathsPerArticle: [{ canonical_url_hash: 'a', path: '/a', views: 100, first_seen: '2026-05-01T00:00:00Z' }],
      engagementPerArticle: [{ canonical_url_hash: 'a', engaged_reads: '40' as unknown as number }],
      socialInbound: [{ inbound_visits_from_social: null }],
      sharesTotal: [{ shares_out_total: null, articles_driving_shares: null }],
    });
    expect(messy.articles[0].shares_out).toBe(12);
    expect(messy.articles[0].quality_score).toBe(40);
    expect(messy.kpis.inbound_visits_from_social).toBe(0);
    expect(messy.kpis.articles_driving_shares).toBe(0);
  });

  // ─── Partial-failure: null buckets produce graceful degradation ──────────

  it('reports partial=true and null KPI when one bucket failed', () => {
    const out = aggregateLoop("'30' DAY", 'kiiru.fi', {
      ...baseRaw,
      socialInbound: null, // simulate engagement bucket CF SQL failure
    });
    expect(out.partial).toBe(true);
    expect(out.status.socialInbound).toBe('failed');
    expect(out.kpis.inbound_visits_from_social).toBeNull();
    // secondary_share_rate also depends on socialInbound → null
    expect(out.kpis.secondary_share_rate).toBeNull();
    // KPIs from healthy buckets stay populated
    expect(out.kpis.articles_driving_shares).toBe(47);
    // Articles still render because shares + pageviews + paths + engagement
    // all succeeded
    expect(out.articles).toHaveLength(3);
  });

  it('null shares bucket → empty articles list, partial=true, null shares KPIs', () => {
    const out = aggregateLoop("'30' DAY", 'kiiru.fi', {
      ...baseRaw,
      sharesPerArticle: null,
      sharesTotal: null,
    });
    expect(out.partial).toBe(true);
    expect(out.articles).toEqual([]);
    expect(out.kpis.articles_driving_shares).toBeNull();
    expect(out.kpis.secondary_share_rate).toBeNull();
    // Quality KPI still computable from pageviews + engagement
    expect(out.kpis.avg_distribution_quality_score).not.toBeNull();
  });

  it('quality KPI is null when pageviews OR engagement bucket failed', () => {
    const noEng = aggregateLoop("'30' DAY", 'kiiru.fi', {
      ...baseRaw,
      engagementPerArticle: null,
    });
    expect(noEng.partial).toBe(true);
    expect(noEng.kpis.avg_distribution_quality_score).toBeNull();

    const noPv = aggregateLoop("'30' DAY", 'kiiru.fi', {
      ...baseRaw,
      pageviewsPerArticle: null,
    });
    expect(noPv.partial).toBe(true);
    expect(noPv.kpis.avg_distribution_quality_score).toBeNull();
  });
});
