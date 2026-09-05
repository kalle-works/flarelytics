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
  PUBLIC_STATS_SITES?: string;
  /** Secret pepper for the visitor hash. Falls back to QUERY_API_KEY if unset. */
  VISITOR_SALT?: string;
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
  /** Site hostname — required for server-side tracking (no Origin header) */
  site?: string;
  /** Revenue / conversion value — stored in double3, used by revenue-by-event query */
  value?: number;
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

const VERSION = '0.2.0';

// Query filter support — maps ?filter[key]=value params to SQL WHERE clauses.
// Values are validated against strict patterns before use; single quotes are
// also escaped as a second layer of defence against SQL injection.
const FILTER_BLOB: Record<string, string> = {
  country:      'blob3',
  referrer:     'blob2',
  page:         'blob1',
  device:       'blob11',
  browser:      'blob12',
  os:           'blob13',
  utm_source:   'blob6',
  utm_campaign: 'blob8',
};

const FILTER_PATTERN: Record<string, RegExp> = {
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

function injectFilters(sql: string, filterClauses: string): string {
  if (!filterClauses) return sql;
  return sql.replace(/AND blob10 = '[^']+'/g, (m) => `${m} ${filterClauses}`);
}

const DEFAULT_BOT_PATTERNS = [
  'bot', 'crawl', 'spider', 'slurp', 'baidu', 'yandex',
  'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptimerobot',
  'headlesschrome', 'phantomjs', 'semrush', 'ahrefs', 'moz.com',
  'dotbot', 'facebookexternalhit', 'twitterbot', 'linkedinbot',
  'whatsapp', 'telegrambot', 'bytespider', 'gptbot', 'claudebot',
];

export function deviceType(ua: string): string {
  if (/Mobi|Android/i.test(ua)) return 'mobile';
  if (/Tablet|iPad/i.test(ua)) return 'tablet';
  return 'desktop';
}

export function browserName(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/DuckDuckGo/.test(ua)) return 'DuckDuckGo';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Mobile.*Safari/.test(ua)) return 'Safari Mobile';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Other';
}

export function osName(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Other';
}

export function isBot(ua: string): boolean {
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

/**
 * Constant-time string comparison for API key checks — prevents a remote
 * timing attack from narrowing down QUERY_API_KEY one byte at a time.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

/**
 * Daily-rotating, per-site, salted visitor hash. GDPR-friendly: no raw IP
 * stored. Keyed by VISITOR_SALT (falling back to QUERY_API_KEY when unset)
 * so the hash cannot be reversed from dataset access alone via a
 * precomputed IP/UA table.
 */
async function visitorHash(ip: string, ua: string, site: string, env: Env): Promise<string> {
  const salt = env.VISITOR_SALT || env.QUERY_API_KEY;
  const date = new Date().toISOString().slice(0, 10);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ip}:${ua}:${site}:${date}`));
  return Array.from(new Uint8Array(signature).slice(0, 8))
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

  // Server-side tracking: no Origin header → require X-API-Key for auth.
  // This prevents unauthenticated server-to-server event injection — anyone
  // omitting the Origin header (curl, a script, fetch outside CORS mode)
  // would otherwise bypass the origin allowlist entirely.
  if (!origin) {
    const incomingKey = request.headers.get('X-API-Key');
    if (!incomingKey || !timingSafeEqual(incomingKey, env.QUERY_API_KEY)) {
      return Response.json(
        { error: 'Unauthorized', hint: 'Server-side tracking requires X-API-Key header with your QUERY_API_KEY. Include a "site" field in the payload to identify the site.' },
        { status: 401 },
      );
    }
  }

  const cors = corsHeaders(origin, env);

  const allowed = getAllowedOrigins(env);
  if (origin && !allowed.includes(origin)) {
    return Response.json({ error: 'Forbidden', hint: 'Origin not in ALLOWED_ORIGINS. Check your worker wrangler.toml.' }, { status: 403, headers: cors });
  }

  const ua = request.headers.get('User-Agent') || '';
  if (isBot(ua)) {
    // Record bot hit for reporting, then drop
    const botOrigin = request.headers.get('Origin');
    const botSite = botOrigin ? (() => { try { return new URL(botOrigin).hostname.replace(/^www\./, ''); } catch { return botOrigin; } })() : '';
    let botPath = '/';
    try {
      const botBody = await request.clone().json() as { path?: string; p?: string };
      botPath = (botBody.path || botBody.p || '/').replace(/\/+$/, '').slice(0, 500) || '/';
    } catch { /* ignore parse errors */ }

    env.ANALYTICS.writeDataPoint({
      blobs: [
        botPath,           // blob1: path
        '',                // blob2: referrer (not relevant)
        (request.cf?.country as string) || 'XX', // blob3: country
        'bot_hit',         // blob4: event name
        ua.slice(0, 200),  // blob5: user-agent string as prop
        '', '', '', '',    // blob6-9: unused
        botSite,           // blob10: site hostname
        '', '',            // blob11-12: unused
      ],
      doubles: [1, 0],
      indexes: [botPath],
    });

    return new Response(null, { status: 204, headers: cors });
  }

  let raw: TrackPayload | LegacyPayload;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: 'Bad Request', hint: 'POST body must be valid JSON with "event" and "path" fields.' }, { status: 400, headers: cors });
  }

  const body = normalizePayload(raw);

  if (!body.path || typeof body.path !== 'string') {
    return Response.json({ error: 'Bad Request', hint: 'Missing "path" field. Example: { "event": "pageview", "path": "/pricing" }' }, { status: 400, headers: cors });
  }
  if (!body.event || typeof body.event !== 'string') {
    return Response.json({ error: 'Bad Request', hint: 'Missing "event" field. Example: { "event": "pageview", "path": "/" }' }, { status: 400, headers: cors });
  }

  const path = body.path.replace(/\/+$/, '').slice(0, 500) || '/';
  const eventName = body.event.slice(0, 100);
  const country = (request.cf?.country as string) || 'XX';
  const propValue = body.props ? Object.values(body.props).join('|').slice(0, 200) : '';

  // Derive site from Origin header, strip www. prefix; for server-side
  // requests (no Origin, already X-API-Key gated above) fall back to a
  // validated "site" field in the body.
  const site = origin
    ? (() => { try { return new URL(origin).hostname.replace(/^www\./, ''); } catch { return origin; } })()
    : (() => {
        const s = typeof body.site === 'string' ? body.site.trim().replace(/^www\./, '') : '';
        return /^[a-zA-Z0-9.\-]+$/.test(s) ? s : '';
      })();

  if (!site) {
    // Every query scopes by blob10, so an event stored under an empty site
    // can never be read back. Refuse it instead of accepting it into a void.
    return Response.json(
      { error: 'Bad Request', hint: 'Server-side tracking needs a "site" field with a plain hostname, e.g. { "site": "yoursite.com" }.' },
      { status: 400, headers: cors },
    );
  }

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const vid = await visitorHash(ip, ua, site, env);

  // If referrer hostname matches the site itself, treat as direct (internal navigation)
  const rawReferrer = (body.referrer || 'direct').slice(0, 500);
  const referrer = rawReferrer === site ? 'direct' : rawReferrer;

  // For timing events, extract seconds into double2 for AVG queries
  const timingSeconds = eventName === 'timing' ? (parseFloat(body.props?.seconds || '0') || 0) : 0;
  // Revenue value (double3) — only for custom events with a numeric value field
  const revenueValue = typeof body.value === 'number' && isFinite(body.value) && body.value >= 0 ? body.value : 0;
  const device = deviceType(ua);
  const browser = browserName(ua);
  const os = osName(ua);

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
      site,                                      // blob10: site hostname
      device,                                    // blob11: device type (mobile/tablet/desktop)
      browser,                                   // blob12: browser name
      os,                                        // blob13: operating system
    ],
    doubles: [1, timingSeconds, revenueValue], // double1: event count, double2: timing seconds, double3: revenue value
    indexes: [path],
  });

  return new Response(null, { status: 204, headers: cors });
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

const PERIOD_MAP: Record<string, string> = {
  '7d': "'7' DAY",
  '14d': "'14' DAY",
  '30d': "'30' DAY",
  '60d': "'60' DAY",
  '90d': "'90' DAY",
  '180d': "'180' DAY",
};

async function runCFQuery(sql: string, env: Env): Promise<any> {
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

async function handleQuery(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env, true);

  const apiKey = request.headers.get('X-API-Key');
  if (!apiKey || !timingSafeEqual(apiKey, env.QUERY_API_KEY)) {
    return Response.json({ error: 'Unauthorized', hint: 'Include X-API-Key header with your QUERY_API_KEY.' }, { status: 401, headers: cors });
  }

  const url = new URL(request.url);
  const queryName = url.searchParams.get('q');
  const periodParam = url.searchParams.get('period') || '30d';
  const siteParam = url.searchParams.get('site');
  const eventNameParam = url.searchParams.get('event_name') || '';
  const pageParam = url.searchParams.get('page') || '';
  const filterClauses = parseFilters(url);

  const validQueries = Object.keys(QUERY_TEMPLATES);
  if (!queryName || !validQueries.includes(queryName)) {
    return Response.json(
      {
        error: 'Invalid query',
        available: Object.entries(QUERY_TEMPLATES).map(([name, q]) => ({ name, description: q.description })),
      },
      { status: 400, headers: cors },
    );
  }

  const template = QUERY_TEMPLATES[queryName];
  const isLive = template?.live === true;

  const period = isLive ? "'unused'" : PERIOD_MAP[periodParam];
  if (!isLive && !period) {
    return Response.json(
      { error: 'Invalid period', hint: `Use one of the valid period values. Example: ?period=30d`, available: Object.keys(PERIOD_MAP) },
      { status: 400, headers: cors },
    );
  }

  if (!siteParam) {
    return Response.json({ error: 'Missing required param: site', hint: 'Add ?site=yoursite.com to scope the query to a single site.' }, { status: 400, headers: cors });
  }

  // Validate site param: only allow hostname-safe characters to prevent SQL injection
  if (!/^[a-zA-Z0-9.\-]+$/.test(siteParam)) {
    return Response.json({ error: 'Invalid site param', hint: 'The site param must be a plain hostname, e.g. yoursite.com — no protocol, port, or path.' }, { status: 400, headers: cors });
  }

  const dataset = env.DATASET_NAME;
  if (!dataset) {
    return Response.json({ error: 'DATASET_NAME not configured', hint: 'Set DATASET_NAME in wrangler.toml under [vars]. It must match your Analytics Engine dataset binding.' }, { status: 500, headers: cors });
  }

  // funnel-by-event requires a valid event_name param
  if (queryName === 'funnel-by-event') {
    if (!eventNameParam || !/^[a-zA-Z0-9_\-]+$/.test(eventNameParam)) {
      return Response.json({ error: 'Missing or invalid param: event_name', hint: 'Add ?event_name=your_event to filter by a specific custom event. Only alphanumeric characters, hyphens and underscores are allowed.' }, { status: 400, headers: cors });
    }
  }

  // Some queries require a ?page= param
  if (template.requiresPage) {
    if (!pageParam || !/^\/[a-zA-Z0-9.\-_/]*$/.test(pageParam)) {
      return Response.json({ error: 'Missing or invalid param: page', hint: 'Add ?page=/your/path to scope this query to a single page. The value must start with / and contain only URL-safe characters.' }, { status: 400, headers: cors });
    }
  }

  const sql = injectFilters(template.sql(dataset, period, siteParam, eventNameParam, pageParam), filterClauses);

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
      return Response.json({ error: 'Query execution failed', hint: `The Cloudflare Analytics Engine SQL API returned an error for query "${queryName}". Check that CF_API_TOKEN has Analytics Engine read permission and CF_ACCOUNT_ID is correct.` }, { status: 502, headers: cors });
    }

    const data = await response.text();
    const cacheControl = isLive ? 'no-store' : 'public, max-age=300';
    return new Response(data, {
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
    });
  } catch (err) {
    console.log(`[query] fetch error: ${err}`);
    return Response.json({ error: 'Query execution failed', hint: `Could not reach the Cloudflare Analytics Engine SQL API for query "${queryName}". The request may have timed out (10 s limit) or the API may be temporarily unavailable.` }, { status: 502, headers: cors });
  }
}

// Auto-configured tracking script served from the worker
const TRACKER_SCRIPT = `!function(){var sc=document.currentScript,e="__ENDPOINT__",sd=sc&&"scrollDepth"in sc.dataset,n=function(n,t){var r=Object.assign({event:n,path:location.pathname},t||{});var i=document.referrer;if(n==="pageview"){if(i)try{r.referrer=new URL(i).hostname}catch(e){r.referrer=i}else r.referrer="direct";var o=new URLSearchParams(location.search);["utm_source","utm_medium","utm_campaign"].forEach(function(e){var n=o.get(e);if(n)r[e]=n})}var a=JSON.stringify(r),s=new Blob([a],{type:"application/json"});navigator.sendBeacon?navigator.sendBeacon(e+"/track",s):fetch(e+"/track",{method:"POST",body:a,headers:{"Content-Type":"application/json"},keepalive:!0})};n("pageview");document.addEventListener("click",function(e){var t=e.target.closest("a[href]");if(!t)return;try{var r=new URL(t.href);if(r.hostname===location.hostname)return;n("outbound",{props:{url:r.hostname+r.pathname}})}catch(e){}});var _s=Date.now();document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden"){var t=Math.round((Date.now()-_s)/1000);if(t>1&&t<3600)n("timing",{props:{seconds:String(t)}})}else{_s=Date.now()}});if(sd&&"IntersectionObserver"in window){var _f=new Set,_obs=new IntersectionObserver(function(es){es.forEach(function(e){if(!e.isIntersecting)return;var d=parseInt(e.target.dataset.sd||"0",10);if(d&&!_f.has(d)){_f.add(d);n("scroll_depth",{props:{depth:String(d)}});if(_f.size===4)_obs.disconnect()}})});function _sd(){var h=document.documentElement.scrollHeight;[25,50,75,100].forEach(function(p){var el=document.createElement("div");el.dataset.sd=String(p);el.style.cssText="position:absolute;top:"+(p<100?Math.round(h*p/100):h-2)+"px;left:0;width:1px;height:1px;pointer-events:none;z-index:-1";document.body.appendChild(el);_obs.observe(el)})};document.readyState==="complete"?_sd():window.addEventListener("load",_sd,{once:true})}window.flarelytics={track:n}}();`;

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
    version: VERSION,
    queries: Object.entries(QUERY_TEMPLATES).map(([name, q]) => ({ name, description: q.description })),
    periods: Object.keys(PERIOD_MAP),
    tracking: {
      endpoint: '/track',
      method: 'POST',
      events: ['pageview', 'outbound', '(any custom event name)'],
      server_side: 'POST /track with X-API-Key header and "site" field in body — no Origin required',
      revenue: 'Add "value": <number> to any custom event payload to track revenue (stored in double3)',
    },
    filters: {
      description: 'Scope any query to a dimension via ?filter[key]=value',
      keys: Object.keys(FILTER_BLOB),
      example: '?q=top-pages&period=30d&site=yoursite.com&filter[country]=FI&filter[device]=mobile',
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
    { status: healthy ? 'healthy' : 'degraded', checks, version: VERSION },
    { status: healthy ? 200 : 503 },
  );
}

interface PublicStatsResult {
  period: string;
  site: string;
  generated: string;
  stats: {
    pageviews: number;
    visitors: number;
    topPages: Array<{ path: string; views: number }>;
    referrers: Array<{ referrer: string; visits: number }>;
    countries: Array<{ country: string; views: number }>;
    devices: Array<{ device: string; views: number }>;
    dailyViews: Array<{ date: string; views: number }>;
    botHitsTotal: number;
  };
}

async function handlePublicStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  // Public stats endpoint is callable from any origin (same as X-API-Key authenticated queries)
  const cors = corsHeaders(origin, env, true);

  const url = new URL(request.url);
  const siteParam = url.searchParams.get('site');

  if (!siteParam) {
    return Response.json(
      { error: 'Missing required param: site', hint: 'Add ?site=yoursite.com to specify which site stats to return.' },
      { status: 400, headers: cors },
    );
  }

  // Validate hostname characters to prevent SQL injection
  if (!/^[a-zA-Z0-9.\-]+$/.test(siteParam)) {
    return Response.json(
      { error: 'Invalid site param', hint: 'The site param must be a plain hostname, e.g. yoursite.com — no protocol, port, or path.' },
      { status: 400, headers: cors },
    );
  }

  // Only allow sites explicitly listed in PUBLIC_STATS_SITES
  const allowedSites = (env.PUBLIC_STATS_SITES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (allowedSites.length === 0 || !allowedSites.includes(siteParam)) {
    return Response.json(
      { error: 'Forbidden', hint: 'This site is not configured for public stats. Add it to PUBLIC_STATS_SITES.' },
      { status: 403, headers: cors },
    );
  }

  const dataset = env.DATASET_NAME;
  if (!dataset) {
    return Response.json(
      { error: 'DATASET_NAME not configured', hint: 'Set DATASET_NAME in wrangler.toml under [vars].' },
      { status: 500, headers: cors },
    );
  }

  const period = PERIOD_MAP['30d']; // fixed 30-day window
  const site = siteParam;

  const queries = {
    pageviews: `
      SELECT SUM(_sample_interval * double1) AS pageviews
      FROM ${dataset}
      WHERE timestamp > NOW() - INTERVAL ${period} AND blob4 = 'pageview' AND blob10 = '${site}'
    `,
    visitors: `
      SELECT COUNT(DISTINCT blob9) AS visitors
      FROM ${dataset}
      WHERE timestamp > NOW() - INTERVAL ${period} AND blob4 = 'pageview' AND blob10 = '${site}'
    `,
    topPages: `
      SELECT blob1 AS path, SUM(_sample_interval * double1) AS views
      FROM ${dataset}
      WHERE timestamp > NOW() - INTERVAL ${period} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY path ORDER BY views DESC LIMIT 10
    `,
    referrers: `
      SELECT blob2 AS referrer, SUM(_sample_interval * double1) AS visits
      FROM ${dataset}
      WHERE timestamp > NOW() - INTERVAL ${period} AND blob4 = 'pageview' AND blob2 != 'direct' AND blob10 = '${site}'
      GROUP BY referrer ORDER BY visits DESC LIMIT 10
    `,
    countries: `
      SELECT blob3 AS country, SUM(_sample_interval * double1) AS views
      FROM ${dataset}
      WHERE timestamp > NOW() - INTERVAL ${period} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY country ORDER BY views DESC LIMIT 10
    `,
    devices: `
      SELECT blob11 AS device, SUM(_sample_interval * double1) AS views
      FROM ${dataset}
      WHERE timestamp > NOW() - INTERVAL ${period} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY device ORDER BY views DESC
    `,
    dailyViews: `
      SELECT toDate(timestamp) AS date, SUM(_sample_interval * double1) AS views
      FROM ${dataset}
      WHERE timestamp > NOW() - INTERVAL ${period} AND blob4 = 'pageview' AND blob10 = '${site}'
      GROUP BY date ORDER BY date ASC
    `,
    botHitsTotal: `
      SELECT SUM(_sample_interval * double1) AS total_bot_hits
      FROM ${dataset}
      WHERE timestamp > NOW() - INTERVAL ${period} AND blob4 = 'bot_hit' AND blob10 = '${site}'
    `,
  };

  try {
    const [pageviewsData, visitorsData, topPagesData, referrersData, countriesData, devicesData, dailyViewsData, botHitsData] =
      await Promise.all([
        runCFQuery(queries.pageviews, env),
        runCFQuery(queries.visitors, env),
        runCFQuery(queries.topPages, env),
        runCFQuery(queries.referrers, env),
        runCFQuery(queries.countries, env),
        runCFQuery(queries.devices, env),
        runCFQuery(queries.dailyViews, env),
        runCFQuery(queries.botHitsTotal, env),
      ]);

    const result: PublicStatsResult = {
      period: '30d',
      site,
      generated: new Date().toISOString(),
      stats: {
        pageviews: Number(pageviewsData.data?.[0]?.pageviews ?? 0),
        visitors: Number(visitorsData.data?.[0]?.visitors ?? 0),
        topPages: (topPagesData.data ?? []).map((r: any) => ({ path: String(r.path), views: Number(r.views) })),
        referrers: (referrersData.data ?? []).map((r: any) => ({ referrer: String(r.referrer), visits: Number(r.visits) })),
        countries: (countriesData.data ?? []).map((r: any) => ({ country: String(r.country), views: Number(r.views) })),
        devices: (devicesData.data ?? []).map((r: any) => ({ device: String(r.device), views: Number(r.views) })),
        dailyViews: (dailyViewsData.data ?? []).map((r: any) => ({ date: String(r.date), views: Number(r.views) })),
        botHitsTotal: Number(botHitsData.data?.[0]?.total_bot_hits ?? 0),
      },
    };

    return Response.json(result, {
      headers: {
        ...cors,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (err) {
    console.log(`[public-stats] error: ${err}`);
    return Response.json(
      { error: 'Stats fetch failed', hint: 'Could not retrieve analytics data. Check that CF_API_TOKEN and CF_ACCOUNT_ID are configured correctly.' },
      { status: 502, headers: cors },
    );
  }
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
    if (pathname === '/tracker.js' && request.method === 'GET') return handleTrackerJs(request);
    if (pathname === '/config' && request.method === 'GET') return handleConfig(env);
    if (pathname === '/health' && request.method === 'GET') return handleHealth(env);
    if (pathname === '/public-stats' && request.method === 'GET') return handlePublicStats(request, env);
    if (pathname === '/query' && request.method === 'GET') return handleQuery(request, env);

    return Response.json({ error: 'Not Found', hint: 'Available endpoints: POST /track, GET /query, GET /public-stats, GET /tracker.js, GET /health, GET /config' }, { status: 404 });
  },
};
