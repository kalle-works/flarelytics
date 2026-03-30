/**
 * Flarelytics — Privacy-first analytics worker for Cloudflare
 *
 * Endpoints:
 *   POST /track        — Record an event (pageview, custom, outbound)
 *   GET  /query        — Run a predefined analytics query (requires API key)
 *   GET  /tracker.js   — Serve auto-configured tracking script
 *   GET  /config       — Available queries and event types
 *   GET  /health       — Health check
 */

interface Env {
  ANALYTICS: AnalyticsEngineDataset;
  ALLOWED_ORIGINS: string;
  QUERY_API_KEY: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  DATASET_NAME: string;
}

interface TrackPayload {
  /** Event name: 'pageview', 'outbound', or any custom event name */
  event: string;
  /** Page path (required) */
  path: string;
  /** Referrer hostname */
  referrer?: string;
  /** Event-specific properties (key-value pairs) */
  props?: Record<string, string>;
  /** UTM params */
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}

// Legacy short-form payload (backwards compatible with mailtoolfinder format)
interface LegacyPayload {
  e: string;
  p: string;
  r?: string;
  t?: string;
  d?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}

const DEFAULT_BOT_PATTERNS = [
  'bot', 'crawl', 'spider', 'slurp', 'baidu', 'yandex',
  'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptimerobot',
  'headlesschrome', 'phantomjs', 'semrush', 'ahrefs', 'moz.com',
  'dotbot', 'facebookexternalhit', 'twitterbot', 'linkedinbot',
  'whatsapp', 'telegrambot', 'bytespider', 'gptbot', 'claudebot',
];

function isBot(ua: string): boolean {
  if (!ua) return true;
  const lower = ua.toLowerCase();
  return DEFAULT_BOT_PATTERNS.some((p) => lower.includes(p));
}

function getAllowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(',').map((o) => o.trim());
}

function corsHeaders(origin: string | null, env: Env, allowAny = false): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Max-Age': '86400',
  };
  if (allowAny && origin) {
    // API-key authenticated endpoints allow any origin
    headers['Access-Control-Allow-Origin'] = origin;
  } else if (origin && getAllowedOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

/** Daily-rotating visitor hash. GDPR-friendly: no raw IP stored. */
async function visitorHash(ip: string, ua: string): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const data = new TextEncoder().encode(`${ip}:${ua}:${date}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Normalize payload: accept both new format and legacy short-form */
function normalizePayload(raw: TrackPayload | LegacyPayload): TrackPayload {
  if ('event' in raw && 'path' in raw) {
    return raw as TrackPayload;
  }
  const legacy = raw as LegacyPayload;
  const EVENT_MAP: Record<string, string> = {
    pv: 'pageview', ac: 'affiliate_click', ns: 'newsletter_signup',
    qc: 'quiz_complete', bl: 'blog_engagement', ol: 'outbound',
  };
  return {
    event: EVENT_MAP[legacy.e] || legacy.e,
    path: legacy.p,
    referrer: legacy.r,
    props: {
      ...(legacy.t ? { tool: legacy.t } : {}),
      ...(legacy.d ? { data: legacy.d } : {}),
    },
    utm_source: legacy.utm_source,
    utm_medium: legacy.utm_medium,
    utm_campaign: legacy.utm_campaign,
  };
}

async function handleTrack(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env);

  const allowed = getAllowedOrigins(env);
  if (origin && !allowed.includes(origin)) {
    return new Response('Forbidden', { status: 403, headers: cors });
  }

  const ua = request.headers.get('User-Agent') || '';
  if (isBot(ua)) {
    return new Response(null, { status: 204, headers: cors });
  }

  let raw: TrackPayload | LegacyPayload;
  try {
    raw = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400, headers: cors });
  }

  const body = normalizePayload(raw);

  if (!body.path || typeof body.path !== 'string') {
    return new Response('Bad Request: missing path', { status: 400, headers: cors });
  }
  if (!body.event || typeof body.event !== 'string') {
    return new Response('Bad Request: missing event', { status: 400, headers: cors });
  }

  const path = body.path.replace(/\/+$/, '').slice(0, 500) || '/';
  const eventName = body.event.slice(0, 100);
  const referrer = (body.referrer || 'direct').slice(0, 500);
  const country = (request.cf?.country as string) || 'XX';
  const propValue = body.props ? Object.values(body.props).join('|').slice(0, 200) : '';

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const vid = await visitorHash(ip, ua);

  env.ANALYTICS.writeDataPoint({
    blobs: [
      path,                                      // blob1: path
      referrer,                                  // blob2: referrer
      country,                                   // blob3: country
      eventName,                                 // blob4: event name
      propValue,                                 // blob5: event properties
      (body.utm_source || '').slice(0, 200),     // blob6: utm_source
      (body.utm_medium || '').slice(0, 200),     // blob7: utm_medium
      (body.utm_campaign || '').slice(0, 200),   // blob8: utm_campaign
      vid,                                       // blob9: visitor_id
    ],
    doubles: [1],
    indexes: [path],
  });

  return new Response(null, { status: 204, headers: cors });
}

// Query templates
const QUERY_TEMPLATES: Record<string, { description: string; sql: (ds: string, p: string) => string }> = {
  'top-pages': {
    description: 'Most viewed pages',
    sql: (ds, p) => `
      SELECT blob1 AS path, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview'
      GROUP BY path ORDER BY views DESC LIMIT 20
    `,
  },
  'daily-views': {
    description: 'Pageviews per day',
    sql: (ds, p) => `
      SELECT toDate(timestamp) AS date, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview'
      GROUP BY date ORDER BY date ASC
    `,
  },
  'daily-unique-visitors': {
    description: 'Unique visitors per day',
    sql: (ds, p) => `
      SELECT toDate(timestamp) AS date,
        COUNT(DISTINCT blob9) AS unique_visitors,
        SUM(_sample_interval * double1) AS total_views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview'
      GROUP BY date ORDER BY date ASC
    `,
  },
  'referrers': {
    description: 'Top referrer hostnames',
    sql: (ds, p) => `
      SELECT blob2 AS referrer, SUM(_sample_interval * double1) AS visits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview' AND blob2 != 'direct'
      GROUP BY referrer ORDER BY visits DESC LIMIT 20
    `,
  },
  'countries': {
    description: 'Views by country',
    sql: (ds, p) => `
      SELECT blob3 AS country, SUM(_sample_interval * double1) AS views
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview'
      GROUP BY country ORDER BY views DESC LIMIT 20
    `,
  },
  'custom-events': {
    description: 'Custom event counts by name',
    sql: (ds, p) => `
      SELECT blob4 AS event, blob5 AS properties, SUM(_sample_interval * double1) AS count
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 != 'pageview' AND blob4 != 'outbound'
      GROUP BY event, properties ORDER BY count DESC LIMIT 50
    `,
  },
  'outbound-links': {
    description: 'Clicks to external URLs',
    sql: (ds, p) => `
      SELECT blob5 AS destination, SUM(_sample_interval * double1) AS clicks
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'outbound' AND blob5 != ''
      GROUP BY destination ORDER BY clicks DESC LIMIT 30
    `,
  },
  'page-performance': {
    description: 'Page views vs custom event clicks with CTR',
    sql: (ds, p) => `
      SELECT
        pages.path AS path, pages.views AS views,
        COALESCE(events.events, 0) AS events,
        CASE WHEN pages.views > 0
          THEN round(COALESCE(events.events, 0) / pages.views * 100, 2)
          ELSE 0 END AS event_rate
      FROM (
        SELECT blob1 AS path, SUM(_sample_interval * double1) AS views
        FROM ${ds}
        WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 = 'pageview'
        GROUP BY path HAVING views >= 10
      ) AS pages
      LEFT JOIN (
        SELECT blob1 AS path, SUM(_sample_interval * double1) AS events
        FROM ${ds}
        WHERE timestamp > NOW() - INTERVAL ${p} AND blob4 != 'pageview' AND blob4 != 'outbound'
        GROUP BY path
      ) AS events ON pages.path = events.path
      ORDER BY pages.views DESC LIMIT 30
    `,
  },
  'utm-campaigns': {
    description: 'UTM campaign breakdown',
    sql: (ds, p) => `
      SELECT blob6 AS utm_source, blob7 AS utm_medium, blob8 AS utm_campaign,
        SUM(_sample_interval * double1) AS visits
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p} AND blob6 != ''
      GROUP BY utm_source, utm_medium, utm_campaign ORDER BY visits DESC LIMIT 30
    `,
  },
  'conversion-funnel': {
    description: 'Daily funnel: pageviews to custom events',
    sql: (ds, p) => `
      SELECT toDate(timestamp) AS date,
        SUM(CASE WHEN blob4 = 'pageview' THEN _sample_interval * double1 ELSE 0 END) AS pageviews,
        SUM(CASE WHEN blob4 != 'pageview' AND blob4 != 'outbound' THEN _sample_interval * double1 ELSE 0 END) AS conversions
      FROM ${ds}
      WHERE timestamp > NOW() - INTERVAL ${p}
      GROUP BY date ORDER BY date ASC
    `,
  },
};

const PERIOD_MAP: Record<string, string> = {
  '7d': "'7' DAY",
  '30d': "'30' DAY",
  '90d': "'90' DAY",
};

async function handleQuery(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env, true);

  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey || apiKey !== env.QUERY_API_KEY) {
    return new Response('Unauthorized', { status: 401, headers: cors });
  }

  const url = new URL(request.url);
  const queryName = url.searchParams.get('q');
  const periodParam = url.searchParams.get('period') || '30d';

  if (!queryName || !QUERY_TEMPLATES[queryName]) {
    return Response.json(
      { error: 'Invalid query', available: Object.keys(QUERY_TEMPLATES).map((k) => ({ name: k, description: QUERY_TEMPLATES[k].description })) },
      { status: 400, headers: cors },
    );
  }

  const period = PERIOD_MAP[periodParam];
  if (!period) {
    return Response.json(
      { error: 'Invalid period', available: Object.keys(PERIOD_MAP) },
      { status: 400, headers: cors },
    );
  }

  const dataset = env.DATASET_NAME;
  if (!dataset) {
    return Response.json({ error: 'DATASET_NAME not configured' }, { status: 500, headers: cors });
  }

  const sql = QUERY_TEMPLATES[queryName].sql(dataset, period);

  try {
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
      console.log(`[query] CF SQL API error ${response.status}: ${errorText}`);
      return Response.json({ error: 'Query execution failed' }, { status: 502, headers: cors });
    }

    const data = await response.text();
    return new Response(data, {
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    });
  } catch (err) {
    console.log(`[query] fetch error: ${err}`);
    return Response.json({ error: 'Query execution failed' }, { status: 502, headers: cors });
  }
}

// Auto-configured tracking script served from the worker
const TRACKER_SCRIPT = `!function(){var e="__ENDPOINT__",n=function(n,t){var r=Object.assign({event:n,path:location.pathname},t||{});var i=document.referrer;if(n==="pageview"){if(i)try{r.referrer=new URL(i).hostname}catch(e){r.referrer=i}else r.referrer="direct";var o=new URLSearchParams(location.search);["utm_source","utm_medium","utm_campaign"].forEach(function(e){var n=o.get(e);if(n)r[e]=n})}var a=JSON.stringify(r),s=new Blob([a],{type:"application/json"});navigator.sendBeacon?navigator.sendBeacon(e+"/track",s):fetch(e+"/track",{method:"POST",body:a,headers:{"Content-Type":"application/json"},keepalive:!0})};n("pageview");document.addEventListener("click",function(e){var t=e.target.closest("a[href]");if(!t)return;try{var r=new URL(t.href);if(r.hostname===location.hostname)return;n("outbound",{props:{url:r.hostname+r.pathname}})}catch(e){}});window.flarelytics={track:n}}();`;

function handleTrackerJs(request: Request): Response {
  const url = new URL(request.url);
  const endpoint = `${url.protocol}//${url.host}`;
  const script = TRACKER_SCRIPT.replace(/__ENDPOINT__/g, endpoint);
  return new Response(script, {
    headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'public, max-age=86400' },
  });
}

function handleConfig(env: Env): Response {
  return Response.json({
    name: 'flarelytics',
    version: '0.1.0',
    queries: Object.entries(QUERY_TEMPLATES).map(([name, q]) => ({ name, description: q.description })),
    periods: Object.keys(PERIOD_MAP),
    tracking: {
      endpoint: '/track',
      method: 'POST',
      events: ['pageview', 'outbound', '(any custom event name)'],
    },
  }, {
    headers: { 'Cache-Control': 'public, max-age=3600' },
  });
}

function handleHealth(env: Env): Response {
  const checks = {
    analytics_binding: !!env.ANALYTICS,
    query_api_key: !!env.QUERY_API_KEY,
    cf_account_id: !!env.CF_ACCOUNT_ID,
    cf_api_token: !!env.CF_API_TOKEN,
    dataset_name: !!env.DATASET_NAME,
  };
  const healthy = Object.values(checks).every(Boolean);
  return Response.json(
    { status: healthy ? 'healthy' : 'degraded', checks, version: '0.1.0' },
    { status: healthy ? 200 : 503 },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      // Allow any origin for preflight if the request includes X-API-Key
      const allowAny = request.headers.get('Access-Control-Request-Headers')?.includes('x-api-key') ?? false;
      return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin'), env, allowAny) });
    }

    if (pathname === '/track' && request.method === 'POST') return handleTrack(request, env);
    if (pathname === '/query' && request.method === 'GET') return handleQuery(request, env);
    if (pathname === '/tracker.js' && request.method === 'GET') return handleTrackerJs(request);
    if (pathname === '/config' && request.method === 'GET') return handleConfig(env);
    if (pathname === '/health' && request.method === 'GET') return handleHealth(env);

    return new Response('Not Found', { status: 404 });
  },
};
