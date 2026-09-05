/**
 * Flarelytics — Privacy-first analytics worker for Cloudflare
 *
 * Endpoints:
 *   POST   /track                     — Record an event (pageview, custom, outbound)
 *   GET    /query                     — Run a predefined analytics query (session cookie or X-API-Key)
 *   GET    /public-stats              — Public analytics summary for opted-in sites (no auth)
 *   GET    /tracker.js                — Serve auto-configured tracking script
 *   GET    /config                    — Available queries and event types
 *   GET    /health                    — Health check
 *   GET/POST/DELETE /admin/sites      — List / claim / remove the org's sites
 *   POST   /admin/sites/verify        — Verify a pending site claim via DNS TXT
 *   GET    /api/auth/login            — Start SSO login (PKCE)
 *   GET    /api/auth/oidc/callback    — Finish login, set session cookie
 *   GET    /api/auth/me               — Current user: orgs, active_org, role, sites
 *   POST   /api/auth/switch-org       — Change active organization
 *   GET    /api/auth/logout           — Clear session + OIDC end-session
 */

import { isV1Query, V1_QUERIES } from './queries/v1/index';
import { readSession } from './auth/session';
import { isAdminEmail, assertSiteAccess } from './auth/middleware';
import {
  dashboardOrigins, authCorsHeaders,
  handleLogin, handleCallback, handleLogout, handleMe, handleSwitchOrg,
} from './auth/routes';
import { timingSafeEqual } from './auth/crypto';
import type { Env } from './env';
import { corsHeaders, dataCorsHeaders, fetchAllowedOrigins } from './cors';
import { deviceType, browserName, osName } from './ua';
import { handleTrack, isBot } from './track';
import { handleAdminSites } from './admin';
import { handlePublicStats } from './public-stats';
import { handleTrackerJs } from './tracker-script';
import { QUERY_TEMPLATES, PERIOD_MAP, FILTER_BLOB, parseFilters, injectFilters, runCFQuery } from './queries/v0';

// Re-exported so existing imports of these helpers from './index' keep working.
export { parseFilters, deviceType, browserName, osName, isBot, QUERY_TEMPLATES, PERIOD_MAP };

const VERSION = '0.2.0';

/**
 * Authorize a /query request. Returns null when allowed, or an error Response.
 *  1. Valid X-API-Key → full access (back-compat, programmatic).
 *  2. Else a valid session cookie scoped to the requested site (ADMIN_EMAILS
 *     bypass any site). No session → 401; foreign/missing site → 403/400.
 */
async function authorizeQuery(
  request: Request, env: Env, site: string | null, cors: Record<string, string>,
): Promise<Response | null> {
  const apiKey = request.headers.get('X-API-Key');
  if (apiKey && env.QUERY_API_KEY && timingSafeEqual(apiKey, env.QUERY_API_KEY)) return null;

  const session = await readSession(request, env.SESSION_SECRET || '');
  if (!session) {
    return Response.json(
      { error: 'Unauthorized', hint: 'Sign in via /api/auth/login (cookie) or include X-API-Key.' },
      { status: 401, headers: cors },
    );
  }
  if (isAdminEmail(env.ADMIN_EMAILS, session.email)) return null;
  if (!site) {
    return Response.json(
      { error: 'Missing required param: site', hint: 'Add ?site=yoursite.com to scope the query.' },
      { status: 400, headers: cors },
    );
  }
  try {
    await assertSiteAccess(env.SITE_CONFIG, session, site, env.ADMIN_EMAILS);
  } catch {
    return Response.json(
      { error: 'Forbidden', hint: 'This site is not in your active organization.' },
      { status: 403, headers: cors },
    );
  }
  return null;
}

async function handleNewVsReturning(env: Env, site: string, period: string, dataset: string, cors: Record<string, string>, filterClauses: string): Promise<Response> {
  const currentSql = `SELECT blob9 AS vid FROM ${dataset} WHERE timestamp > NOW() - INTERVAL ${period} AND blob4 = 'pageview' AND blob10 = '${site}' ${filterClauses} GROUP BY blob9`;
  const priorSql   = `SELECT blob9 AS vid FROM ${dataset} WHERE timestamp <= NOW() - INTERVAL ${period} AND blob4 = 'pageview' AND blob10 = '${site}' ${filterClauses} GROUP BY blob9`;

  try {
    const [currentData, priorData] = await Promise.all([
      runCFQuery(currentSql, env),
      runCFQuery(priorSql, env),
    ]);

    const currentVids: string[] = (currentData.data ?? []).map((r: any) => r.vid);
    const priorVids = new Set<string>((priorData.data ?? []).map((r: any) => r.vid));

    let newVisitors = 0, returningVisitors = 0;
    for (const vid of currentVids) {
      if (priorVids.has(vid)) returningVisitors++;
      else newVisitors++;
    }

    return Response.json(
      { data: [{ new_visitors: newVisitors, returning_visitors: returningVisitors, total: currentVids.length }] },
      // Private: /query is API-key-protected; the key lives in a request
      // header so shared caches keying on URL+method could replay across keys.
      { headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300, must-revalidate' } },
    );
  } catch (err) {
    console.log(`[new-vs-returning] error: ${err}`);
    return Response.json({ error: 'Query execution failed', hint: 'The new-vs-returning query requires two Analytics Engine API calls. Check that CF_API_TOKEN and CF_ACCOUNT_ID are configured correctly.' }, { status: 502, headers: cors });
  }
}

async function handleQuery(request: Request, env: Env): Promise<Response> {
  const cors = dataCorsHeaders(request, env);

  const url = new URL(request.url);
  const queryName = url.searchParams.get('q');
  const periodParam = url.searchParams.get('period') || '30d';
  const siteParam = url.searchParams.get('site');

  const authError = await authorizeQuery(request, env, siteParam, cors);
  if (authError) return authError;
  const eventNameParam = url.searchParams.get('event_name') || '';
  const pageParam = url.searchParams.get('page') || '';
  const isV1 = url.searchParams.get('v') === '1';
  const filterClauses = parseFilters(url);

  // v1 path — Phase 0.5 Distribution Loop view. Reuses the same auth + site/period
  // validators as v0 but dispatches to the v1 query registry, which reads from
  // the per-family v1 datasets and aggregates in JS.
  if (isV1) {
    if (!queryName || !isV1Query(queryName)) {
      return Response.json(
        {
          error: 'Invalid v1 query',
          available: Object.entries(V1_QUERIES).map(([name, q]) => ({ name, description: q.description })),
        },
        { status: 400, headers: cors },
      );
    }
    if (!siteParam) {
      return Response.json({ error: 'Missing required param: site', hint: 'Add ?site=yoursite.com to scope the query to a single site.' }, { status: 400, headers: cors });
    }
    if (!/^[a-zA-Z0-9.\-]+$/.test(siteParam)) {
      return Response.json({ error: 'Invalid site param', hint: 'The site param must be a plain hostname.' }, { status: 400, headers: cors });
    }
    const v1Period = PERIOD_MAP[periodParam];
    if (!v1Period) {
      return Response.json({ error: 'Invalid period', available: Object.keys(PERIOD_MAP) }, { status: 400, headers: cors });
    }
    try {
      const data = await V1_QUERIES[queryName].run(env, v1Period, siteParam);
      // Private cache only — /query is API-key-protected and the key lives in
      // a request header, not the URL. Shared caches (proxies, CDNs) keying
      // on URL+method could otherwise replay a cached response across keys.
      return Response.json(data, {
        headers: { ...cors, 'Cache-Control': 'private, max-age=300, must-revalidate' },
      });
    } catch (err) {
      console.log(`[v1 query] ${queryName} failed: ${err}`);
      return Response.json({ error: 'Query execution failed', hint: `v1 query "${queryName}" could not complete. Check CF_API_TOKEN / CF_ACCOUNT_ID and that the v1 datasets exist.` }, { status: 502, headers: cors });
    }
  }

  const validQueries = [...Object.keys(QUERY_TEMPLATES), 'new-vs-returning'];
  if (!queryName || !validQueries.includes(queryName)) {
    return Response.json(
      {
        error: 'Invalid query',
        available: [
          ...Object.entries(QUERY_TEMPLATES).map(([name, q]) => ({ name, description: q.description })),
          { name: 'new-vs-returning', description: 'New vs returning visitors in the selected period' },
        ],
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

  // new-vs-returning requires two CF API calls — handled separately
  if (queryName === 'new-vs-returning') {
    return handleNewVsReturning(env, siteParam, period, dataset, cors, filterClauses);
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
    // Private: /query is API-key-protected; the key lives in a request header
    // so shared caches keying on URL+method could replay across keys. Live
    // queries stay no-store.
    const cacheControl = isLive ? 'no-store' : 'private, max-age=300, must-revalidate';
    return new Response(data, {
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cacheControl },
    });
  } catch (err) {
    console.log(`[query] fetch error: ${err}`);
    return Response.json({ error: 'Query execution failed', hint: `Could not reach the Cloudflare Analytics Engine SQL API for query "${queryName}". The request may have timed out (10 s limit) or the API may be temporarily unavailable.` }, { status: 502, headers: cors });
  }
}

function handleConfig(env: Env): Response {
  return Response.json({
    name: 'flarelytics',
    version: VERSION,
    queries: [
      ...Object.entries(QUERY_TEMPLATES).map(([name, q]) => ({ name, description: q.description })),
      { name: 'new-vs-returning', description: 'New vs returning visitors in the selected period' },
    ],
    queries_v1: Object.entries(V1_QUERIES).map(([name, q]) => ({ name, description: q.description })),
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      // Credentialed preflight for dashboard-origin requests (cookie auth).
      if (origin && dashboardOrigins(env).includes(origin)) {
        return new Response(null, { status: 204, headers: authCorsHeaders(request, env) });
      }
      const allowAny = request.headers.get('Access-Control-Request-Headers')?.includes('x-api-key') ?? false;
      const preflightOrigins = allowAny ? [] : await fetchAllowedOrigins(env);
      return new Response(null, { status: 204, headers: corsHeaders(origin, preflightOrigins, allowAny) });
    }

    // Multi-org SSO endpoints.
    if (pathname === '/api/auth/login' && request.method === 'GET') return handleLogin(request, env);
    if (pathname === '/api/auth/oidc/callback' && request.method === 'GET') return handleCallback(request, env);
    if (pathname === '/api/auth/logout') return handleLogout(request, env);
    if (pathname === '/api/auth/me' && request.method === 'GET') return handleMe(request, env);
    if (pathname === '/api/auth/switch-org' && request.method === 'POST') return handleSwitchOrg(request, env);

    if (pathname === '/track' && request.method === 'POST') return handleTrack(request, env, ctx);
    if (pathname === '/tracker.js' && request.method === 'GET') return handleTrackerJs(request);
    if (pathname === '/config' && request.method === 'GET') return handleConfig(env);
    if (pathname === '/health' && request.method === 'GET') return handleHealth(env);
    if (pathname === '/public-stats' && request.method === 'GET') return handlePublicStats(request, env);
    if (pathname === '/query' && request.method === 'GET') return handleQuery(request, env);
    if (pathname === '/admin/sites' || pathname === '/admin/sites/verify') return handleAdminSites(request, env);

    return Response.json({ error: 'Not Found', hint: 'Available endpoints: POST /track, GET /query, GET /public-stats, GET /tracker.js, GET /health, GET /config, GET|POST|DELETE /admin/sites, /api/auth/{login,oidc/callback,logout,me,switch-org}' }, { status: 404 });
  },
};
