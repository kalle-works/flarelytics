/**
 * v0 query surface: the legacy Analytics Engine dataset's SQL templates,
 * period mapping, and the `?filter[key]=value` parsing/injection mechanism
 * that scopes any template to a dimension.
 */
import type { Env } from '../env';

// Query filter support — maps ?filter[key]=value params to SQL WHERE clauses.
// Values are validated against strict patterns before use; single quotes are
// also escaped as a second layer of defence against SQL injection.
export const FILTER_BLOB: Record<string, string> = {
  country:      'blob3',
  referrer:     'blob2',
  page:         'blob1',
  device:       'blob11',
  browser:      'blob12',
  os:           'blob13',
  utm_source:   'blob6',
  utm_campaign: 'blob8',
};

export const FILTER_PATTERN: Record<string, RegExp> = {
  country:      /^[A-Z]{2}$/,
  device:       /^(mobile|tablet|desktop)$/,
  browser:      /^[a-zA-Z0-9 ]{1,30}$/,
  os:           /^[a-zA-Z0-9 ]{1,20}$/,
  referrer:     /^[a-zA-Z0-9.\-]{1,100}$/,
  page:         /^\/[a-zA-Z0-9.\-_/]*$/,
  utm_source:   /^[a-zA-Z0-9.\-_]{1,50}$/,
  utm_campaign: /^[a-zA-Z0-9.\-_ ]{1,100}$/,
};

export function parseFilters(url: URL): string {
  const clauses: string[] = [];
  for (const [key, value] of url.searchParams.entries()) {
    const m = key.match(/^filter\[([a-z_]+)\]$/);
    if (!m) continue;
    const k = m[1];
    if (!FILTER_BLOB[k] || !FILTER_PATTERN[k]) continue;
    if (!FILTER_PATTERN[k].test(value)) continue;
    const safe = value.replace(/'/g, "''");
    clauses.push(`AND ${FILTER_BLOB[k]} = '${safe}'`);
  }
  return clauses.join(' ');
}

export function injectFilters(sql: string, filterClauses: string): string {
  if (!filterClauses) return sql;
  return sql.replace(/AND blob10 = '[^']+'/g, m => `${m} ${filterClauses}`);
}

// Query templates
export const QUERY_TEMPLATES: Record<string, {
  description: string;
  sql: (ds: string, p: string, site: string, eventName: string, page: string) => string;
  requiresPage?: boolean;
  /** Live queries ignore the period param and use hardcoded short intervals */
  live?: boolean;
}> = {
  'top-pages': {
    description: 'Most viewed pages',
    sql: (ds, p, site) => `
      SELECT blob1 AS path, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY path ORDER BY views DESC LIMIT 20
    `,
  },
  'daily-views': {
    description: 'Pageviews per day',
    sql: (ds, p, site) => `
      SELECT toDate(timestamp) AS date, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY date ORDER BY date ASC
    `,
  },
  'daily-unique-visitors': {
    description: 'Unique visitors per day',
    sql: (ds, p, site) => `
      SELECT toDate(timestamp) AS date,
        COUNT(DISTINCT blob9) AS unique_visitors,
        SUM(_sample_interval * double1) AS total_views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY date ORDER BY date ASC
    `,
  },
  'referrers': {
    description: 'Top referrer hostnames',
    sql: (ds, p, site) => `
      SELECT blob2 AS referrer, SUM(_sample_interval * double1) AS visits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob2 != 'direct' AND blob10 = '${site}'
      GROUP BY referrer ORDER BY visits DESC LIMIT 20
    `,
  },
  'countries': {
    description: 'Views by country',
    sql: (ds, p, site) => `
      SELECT blob3 AS country, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY country ORDER BY views DESC LIMIT 20
    `,
  },
  'custom-events': {
    description: 'Custom event counts by name',
    sql: (ds, p, site) => `
      SELECT blob4 AS event, blob5 AS properties, SUM(_sample_interval * double1) AS count
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 != 'pageview' AND blob4 != 'outbound' AND blob10 = '${site}'
      GROUP BY event, properties ORDER BY count DESC LIMIT 50
    `,
  },
  'outbound-links': {
    description: 'Clicks to external URLs',
    sql: (ds, p, site) => `
      SELECT blob5 AS destination, SUM(_sample_interval * double1) AS clicks
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'outbound' AND blob5 != '' AND blob10 = '${site}'
      GROUP BY destination ORDER BY clicks DESC LIMIT 30
    `,
  },
  'page-performance': {
    description: 'Page views vs custom event clicks with CTR',
    sql: (ds, p, site) => `
      SELECT
        pages.path AS path, pages.views AS views,
        COALESCE(events.events, 0) AS events,
        CASE WHEN pages.views > 0
          THEN round(COALESCE(events.events, 0) / pages.views * 100, 2)
          ELSE 0 END AS event_rate
      FROM (
        SELECT blob1 AS path, SUM(_sample_interval * double1) AS views
        FROM ${ds}
        WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}'
        GROUP BY path HAVING views >= 10
      ) AS pages
      LEFT JOIN (
        SELECT blob1 AS path, SUM(_sample_interval * double1) AS events
        FROM ${ds}
        WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 != 'pageview' AND blob4 != 'outbound' AND blob10 = '${site}'
        GROUP BY path
      ) AS events ON pages.path = events.path
      ORDER BY pages.views DESC LIMIT 30
    `,
  },
  'utm-campaigns': {
    description: 'UTM campaign breakdown (totals)',
    sql: (ds, p, site) => `
      SELECT blob6 AS utm_source, blob7 AS utm_medium, blob8 AS utm_campaign,
        SUM(_sample_interval * double1) AS visits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob6 != '' AND blob10 = '${site}'
      GROUP BY utm_source, utm_medium, utm_campaign ORDER BY visits DESC LIMIT 30
    `,
  },
  'utm-campaign-trend': {
    description: 'Daily UTM campaign visits — see exactly when each Bluesky post drove traffic',
    sql: (ds, p, site) => `
      SELECT toDate(timestamp) AS date, blob6 AS utm_source, blob8 AS utm_campaign,
        SUM(_sample_interval * double1) AS visits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob6 != '' AND blob10 = '${site}'
      GROUP BY date, utm_source, utm_campaign ORDER BY date ASC, visits DESC LIMIT 200
    `,
  },
  'conversion-funnel': {
    description: 'Daily funnel: pageviews to custom events',
    sql: (ds, p, site) => `
      SELECT toDate(timestamp) AS date,
        sumIf(_sample_interval * double1, blob4 = 'pageview') AS pageviews,
        sumIf(_sample_interval * double1, blob4 != 'pageview' AND blob4 != 'outbound') AS conversions
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob10 = '${site}'
      GROUP BY date ORDER BY date ASC
    `,
  },
  'devices': {
    description: 'Pageviews by device type (mobile/tablet/desktop)',
    sql: (ds, p, site) => `
      SELECT blob11 AS device, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY device ORDER BY views DESC
    `,
  },
  'browsers': {
    description: 'Pageviews by browser',
    sql: (ds, p, site) => `
      SELECT blob12 AS browser, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY browser ORDER BY views DESC LIMIT 10
    `,
  },
  'operating-systems': {
    description: 'Pageviews by operating system',
    sql: (ds, p, site) => `
      SELECT blob13 AS os, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY os ORDER BY views DESC LIMIT 10
    `,
  },
  'top-pages-visitors': {
    description: 'Top pages with both views and unique visitor counts',
    sql: (ds, p, site) => `
      SELECT blob1 AS path,
        SUM(_sample_interval * double1) AS views,
        COUNT(DISTINCT blob9) AS visitors
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY path ORDER BY views DESC LIMIT 20
    `,
  },
  'top-pages-stories': {
    description: 'Top story pages (path starts with /a/) with views and unique visitors',
    sql: (ds, p, site) => `
      SELECT blob1 AS path,
        SUM(_sample_interval * double1) AS views,
        COUNT(DISTINCT blob9) AS visitors
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}' AND blob1 LIKE '/a/%'
      GROUP BY path ORDER BY views DESC LIMIT 20
    `,
  },
  'page-timing': {
    description: 'Average time on page in seconds',
    sql: (ds, p, site) => `
      SELECT blob1 AS path,
        ROUND(AVG(_sample_interval * double2), 0) AS avg_seconds,
        COUNT() AS sessions
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'timing' AND blob10 = '${site}'
      GROUP BY path ORDER BY sessions DESC LIMIT 20
    `,
  },
  'bounce-rate-by-page': {
    description: 'Bounce rate per page — % of visits under threshold seconds (default 10s, override with ?event_name=N)',
    sql: (ds, p, site, eventName) => {
      const threshold = /^\d+$/.test(eventName) ? parseInt(eventName, 10) : 10;
      return `
        SELECT blob1 AS path,
          sumIf(_sample_interval, double2 < ${threshold}) AS bounced,
          COUNT() AS sessions,
          ROUND(sumIf(_sample_interval, double2 < ${threshold}) * 100.0 / COUNT(), 1) AS bounce_pct
        FROM ${ds}
        WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'timing' AND blob10 = '${site}'
        GROUP BY path ORDER BY sessions DESC LIMIT 20
      `;
    },
  },
  'page-views-over-time': {
    description: 'Daily pageviews and visitors for a specific page (?page=/your/path)',
    requiresPage: true,
    sql: (ds, p, site, _eventName, page) => `
      SELECT toDate(timestamp) AS date,
        SUM(_sample_interval * double1) AS views,
        COUNT(DISTINCT blob9) AS visitors
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}' AND blob1 = '${page}'
      GROUP BY date ORDER BY date ASC
    `,
  },
  'countries-by-page': {
    description: 'Country breakdown for a specific page (?page=/your/path)',
    requiresPage: true,
    sql: (ds, p, site, _eventName, page) => `
      SELECT blob3 AS country, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}' AND blob1 = '${page}'
      GROUP BY country ORDER BY views DESC LIMIT 20
    `,
  },
  'referrers-by-page': {
    description: 'Referrer breakdown for a specific page (?page=/your/path)',
    requiresPage: true,
    sql: (ds, p, site, _eventName, page) => `
      SELECT blob2 AS referrer, SUM(_sample_interval * double1) AS visits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}' AND blob1 = '${page}' AND blob2 != 'direct'
      GROUP BY referrer ORDER BY visits DESC LIMIT 10
    `,
  },
  'timing-by-page': {
    description: 'Average time on page for a specific page (?page=/your/path)',
    requiresPage: true,
    sql: (ds, p, site, _eventName, page) => `
      SELECT ROUND(AVG(_sample_interval * double2), 0) AS avg_seconds, COUNT() AS sessions
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'timing' AND blob10 = '${site}' AND blob1 = '${page}'
    `,
  },
  'utm-by-page': {
    description: 'UTM campaign breakdown for a specific page (?page=/your/path)',
    requiresPage: true,
    sql: (ds, p, site, _eventName, page) => `
      SELECT blob6 AS utm_source, blob7 AS utm_medium, blob8 AS utm_campaign, SUM(_sample_interval * double1) AS visits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}' AND blob1 = '${page}' AND blob6 != ''
      GROUP BY utm_source, utm_medium, utm_campaign ORDER BY visits DESC LIMIT 10
    `,
  },
  'scroll-depth-for-page': {
    description: 'Scroll depth distribution for a specific page (?page=/your/path)',
    requiresPage: true,
    sql: (ds, p, site, _eventName, page) => `
      SELECT blob5 AS depth, SUM(_sample_interval * double1) AS count
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'scroll_depth' AND blob10 = '${site}' AND blob1 = '${page}'
      GROUP BY depth ORDER BY depth ASC
    `,
  },
  'funnel-by-event': {
    description: 'Daily funnel: pageviews to a specific custom event (?event_name=my_event)',
    sql: (ds, p, site, eventName) => `
      SELECT toDate(timestamp) AS date,
        sumIf(_sample_interval * double1, blob4 = 'pageview') AS pageviews,
        sumIf(_sample_interval * double1, blob4 = '${eventName}') AS conversions
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob10 = '${site}'
      GROUP BY date ORDER BY date ASC
    `,
  },
  'scroll-depth': {
    description: 'Scroll depth distribution: how far visitors scroll (25/50/75/100%)',
    sql: (ds, p, site) => `
      SELECT blob5 AS depth, SUM(_sample_interval * double1) AS count
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'scroll_depth' AND blob10 = '${site}'
      GROUP BY depth ORDER BY depth ASC
    `,
  },
  'scroll-depth-by-page': {
    description: 'Scroll depth per page — which pages get read furthest',
    sql: (ds, p, site) => `
      SELECT blob1 AS path, blob5 AS depth, SUM(_sample_interval * double1) AS count
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'scroll_depth' AND blob10 = '${site}'
      GROUP BY path, depth ORDER BY path ASC, depth ASC
    `,
  },
  'total-sessions': {
    description: 'Total sessions in period (based on timing events)',
    sql: (ds, p, site) => `
      SELECT SUM(_sample_interval * double1) AS sessions
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'timing' AND blob10 = '${site}'
    `,
  },
  'total-pageviews': {
    description: 'Total pageviews in the period',
    sql: (ds, p, site) => `
      SELECT SUM(_sample_interval * double1) AS pageviews
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}'
    `,
  },
  'total-visitors': {
    description: 'Total unique visitors in the period',
    sql: (ds, p, site) => `
      SELECT COUNT(DISTINCT blob9) AS visitors
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob10 = '${site}'
    `,
  },

  // new-vs-returning is handled separately (requires two CF API calls)

  // Live queries — ignore period param, use hardcoded short intervals
  'live-visitors': {
    description: 'Visitors and pageviews in the last 30 minutes',
    live: true,
    sql: (ds, _p, site) => `
      SELECT COUNT(DISTINCT blob9) AS visitors, SUM(_sample_interval * double1) AS pageviews
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL '30' MINUTE AND blob4 = 'pageview' AND blob10 = '${site}'
    `,
  },
  'live-pages': {
    description: 'Most visited pages in the last 30 minutes',
    live: true,
    sql: (ds, _p, site) => `
      SELECT blob1 AS path, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL '30' MINUTE AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY path ORDER BY views DESC LIMIT 10
    `,
  },
  'hourly-today': {
    description: 'Pageviews by hour for the last 24 hours',
    live: true,
    sql: (ds, _p, site) => `
      SELECT toStartOfHour(timestamp) AS hour, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL '24' HOUR AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY hour ORDER BY hour ASC
    `,
  },
  'live-referrers': {
    description: 'Top referrers in the last 30 minutes',
    live: true,
    sql: (ds, _p, site) => `
      SELECT blob2 AS referrer, SUM(_sample_interval * double1) AS visits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL '30' MINUTE AND blob4 = 'pageview' AND blob2 != 'direct' AND blob10 = '${site}'
      GROUP BY referrer ORDER BY visits DESC LIMIT 8
    `,
  },

  // Bot reporting
  'bot-hits': {
    description: 'Total bot hits and top bot user-agents',
    sql: (ds, p, site) => `
      SELECT blob5 AS user_agent, SUM(_sample_interval * double1) AS hits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'bot_hit' AND blob10 = '${site}'
      GROUP BY user_agent ORDER BY hits DESC LIMIT 15
    `,
  },
  'bot-hits-total': {
    description: 'Total bot hit count for the period',
    sql: (ds, p, site) => `
      SELECT SUM(_sample_interval * double1) AS total_bot_hits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'bot_hit' AND blob10 = '${site}'
    `,
  },
  'bot-pages': {
    description: 'Top pages targeted by bots',
    sql: (ds, p, site) => `
      SELECT blob1 AS path, SUM(_sample_interval * double1) AS hits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'bot_hit' AND blob10 = '${site}'
      GROUP BY path ORDER BY hits DESC LIMIT 15
    `,
  },
  'bot-daily': {
    description: 'Bot hits per day (trend)',
    sql: (ds, p, site) => `
      SELECT toDate(timestamp) AS date, SUM(_sample_interval * double1) AS hits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'bot_hit' AND blob10 = '${site}'
      GROUP BY date ORDER BY date ASC
    `,
  },
  'bot-countries': {
    description: 'Countries where bot traffic originates',
    sql: (ds, p, site) => `
      SELECT blob3 AS country, SUM(_sample_interval * double1) AS hits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'bot_hit' AND blob10 = '${site}'
      GROUP BY country ORDER BY hits DESC LIMIT 15
    `,
  },
  'revenue-by-event': {
    description: 'Events with revenue value — total, count, and average (requires value field in track calls)',
    sql: (ds, p, site) => `
      SELECT blob4 AS event,
        ROUND(SUM(_sample_interval * double3), 2) AS revenue,
        SUM(_sample_interval * double1) AS count,
        ROUND(AVG(_sample_interval * double3), 2) AS avg_value
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND double3 > 0 AND blob10 = '${site}'
      GROUP BY event ORDER BY revenue DESC LIMIT 20
    `,
  },
  'revenue-over-time': {
    description: 'Daily revenue totals and conversion counts',
    sql: (ds, p, site) => `
      SELECT toDate(timestamp) AS date,
        ROUND(SUM(_sample_interval * double3), 2) AS revenue,
        SUM(_sample_interval * double1) AS conversions
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND double3 > 0 AND blob10 = '${site}'
      GROUP BY date ORDER BY date ASC
    `,
  },
};

export const PERIOD_MAP: Record<string, string> = {
  '7d': "'7' DAY",
  '14d': "'14' DAY",
  '30d': "'30' DAY",
  '60d': "'60' DAY",
  '90d': "'90' DAY",
  '180d': "'180' DAY",
};

export async function runCFQuery(sql: string, env: Env): Promise<any> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      body: sql.trim(),
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`CF SQL API error ${response.status}: ${errorText}`);
  }
  return response.json();
}
