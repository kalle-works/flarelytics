/**
 * GET /public-stats — unauthenticated 30-day summary for sites explicitly
 * opted in via PUBLIC_STATS_SITES.
 */
import type { Env } from './env';
import { corsHeaders } from './cors';
import { PERIOD_MAP, runCFQuery } from './queries/v0';

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

export async function handlePublicStats(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, [], true);

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
