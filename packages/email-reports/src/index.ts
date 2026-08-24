/**
 * Flarelytics Email Reports — Cloudflare Worker with cron trigger
 *
 * Sends weekly analytics digest emails. Queries the analytics worker,
 * generates an HTML email, sends via Euromail or any HTTP email API.
 *
 * Endpoints:
 *   POST /recipients    — Add email recipient (API key auth)
 *   DELETE /recipients   — Remove recipient (API key auth)
 *   GET  /recipients    — List recipients (API key auth)
 *   POST /test          — Send test report now (API key auth)
 *   GET  /health        — Health check
 *
 * Cron: runs weekly (configured in wrangler.toml)
 */

export interface Env {
  ANALYTICS_WORKER_URL: string;
  ANALYTICS_API_KEY: string;
  EMAIL_API_URL: string;
  EMAIL_API_KEY: string;
  EMAIL_FROM: string;
  ADMIN_API_KEY: string;
  REPORT_RECIPIENTS: KVNamespace;
  SITE_NAME: string;
  SITE_URL: string;
}

interface AnalyticsRow {
  [key: string]: string | number;
}

// The analytics worker is multi-tenant and scopes every query to one site.
// It wants a plain hostname, so derive it from the site URL the report is
// already configured with rather than adding a second setting that could
// drift from it.
export function siteHost(env: Env): string {
  const raw = (env.SITE_URL || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
  } catch {
    return '';
  }
}

// A query either returns rows or fails. Those are different facts and the
// report must not confuse them: an empty week and a broken query both render
// as "0 views", and a report that quietly says zero when it could not read
// anything is worse than no report — it actively signals "nothing to see".
interface QueryOutcome {
  rows: AnalyticsRow[];
  failed: boolean;
}

// Fetch analytics data from the Flarelytics worker
export async function queryAnalytics(
  env: Env,
  queryName: string,
  period = '7d',
): Promise<QueryOutcome> {
  const site = siteHost(env);
  if (!site) {
    console.error('[report] SITE_URL is unset or unparseable; cannot scope the query');
    return { rows: [], failed: true };
  }
  const url =
    `${env.ANALYTICS_WORKER_URL}/query?q=${queryName}` +
    `&period=${period}&site=${encodeURIComponent(site)}`;
  try {
    const res = await fetch(url, {
      headers: { 'X-API-Key': env.ANALYTICS_API_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(
        `[report] query ${queryName} (${period}) failed: HTTP ${res.status} ${await res.text()}`,
      );
      return { rows: [], failed: true };
    }
    const data = (await res.json()) as { data?: AnalyticsRow[] } | AnalyticsRow[];
    return { rows: Array.isArray(data) ? data : data.data || [], failed: false };
  } catch (err) {
    console.error(`[report] query ${queryName} (${period}) threw:`, err);
    return { rows: [], failed: true };
  }
}

function num(n: number | string | null | undefined): string {
  if (n == null || isNaN(Number(n))) return '0';
  return Math.round(Number(n)).toLocaleString('en-US');
}

function pctChange(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? '+∞' : '0%';
  const change = ((current - previous) / previous) * 100;
  const sign = change > 0 ? '+' : '';
  return `${sign}${change.toFixed(1)}%`;
}

function sum(rows: AnalyticsRow[], field: string): number {
  return rows.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
}

// Generate the HTML email report
export async function generateReport(env: Env): Promise<{ subject: string; html: string }> {
  // Fetch current and previous period data
  const outcomes = await Promise.all([
    queryAnalytics(env, 'daily-views', '7d'),
    queryAnalytics(env, 'daily-unique-visitors', '7d'),
    queryAnalytics(env, 'top-pages', '7d'),
    queryAnalytics(env, 'referrers', '7d'),
    queryAnalytics(env, 'countries', '7d'),
    queryAnalytics(env, 'custom-events', '7d'),
    queryAnalytics(env, 'daily-views', '30d'),
    queryAnalytics(env, 'daily-unique-visitors', '30d'),
    queryAnalytics(env, 'bot-hits', '7d'),
    queryAnalytics(env, 'bot-hits-total', '7d'),
  ]);

  // Any failure poisons the numbers below, because a missing row set is
  // indistinguishable from a quiet week once it has been summed.
  const queriesFailed = outcomes.some((o) => o.failed);
  const [
    dailyViews,
    dailyVisitors,
    topPages,
    referrers,
    countries,
    customEvents,
    prevDailyViews,
    prevDailyVisitors,
    botHits,
    botHitsTotal,
  ] = outcomes.map((o) => o.rows);

  const totalViews = sum(dailyViews, 'views');
  const totalVisitors = sum(dailyVisitors, 'unique_visitors');
  const totalEvents = sum(customEvents, 'count');

  // Previous 7 days (from 30d data, take days 8-14)
  const prevViews = sum(prevDailyViews.slice(-21, -14), 'views');
  const prevVisitors = sum(prevDailyVisitors.slice(-21, -14), 'unique_visitors');

  const viewsDelta = pctChange(totalViews, prevViews);
  const visitorsDelta = pctChange(totalVisitors, prevVisitors);

  const siteName = env.SITE_NAME || 'Your Site';
  const siteUrl = env.SITE_URL || '';

  const top5Pages = topPages.slice(0, 5);
  const top3Referrers = referrers.slice(0, 3);
  const top3Countries = countries.slice(0, 3);
  const totalBotHits = Number(botHitsTotal[0]?.total_bot_hits || 0);
  const top5Bots = botHits.slice(0, 5);

  // Detect anomalies (>30% change)
  const anomalies: string[] = [];
  const viewsChangeNum = prevViews > 0 ? ((totalViews - prevViews) / prevViews) * 100 : 0;
  if (viewsChangeNum > 30) anomalies.push(`Traffic spike: pageviews up ${viewsDelta} vs last week`);
  if (viewsChangeNum < -30) anomalies.push(`Traffic drop: pageviews down ${viewsDelta} vs last week`);

  // Never put a fabricated zero in the subject line: it is the part that gets
  // read at a glance, and "0 views" reads as a fact about the site rather than
  // a fact about the pipeline.
  const subject = queriesFailed
    ? `${siteName} — Weekly Analytics unavailable (could not read the data)`
    : `${siteName} — Weekly Analytics: ${num(totalViews)} views, ${num(totalVisitors)} visitors`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#fafaf9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:24px 16px;">

  <!-- Header -->
  <div style="text-align:center;padding:16px 0 24px;">
    <div style="display:inline-block;width:32px;height:32px;background:#dc6b14;border-radius:6px;"></div>
    <h1 style="margin:8px 0 0;font-size:20px;color:#1a1a1a;">Weekly Report</h1>
    <p style="margin:4px 0 0;font-size:13px;color:#8a8a8a;">${siteName} — Last 7 days</p>
  </div>
${queriesFailed ? `
  <!-- Data could not be read -->
  <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:4px;padding:12px 14px;margin-bottom:24px;">
    <div style="font-size:13px;font-weight:600;color:#991b1b;">These numbers could not be read.</div>
    <div style="font-size:13px;color:#991b1b;margin-top:4px;">
      At least one query to the analytics worker failed, so the figures below are missing rather than zero.
      Do not read this as a quiet week. Check the reports worker logs.
    </div>
  </div>` : ''}
  <!-- KPI Cards -->
  <div style="display:flex;gap:12px;margin-bottom:24px;">
    <div style="flex:1;background:white;border:1px solid #e5e5e3;border-radius:4px;padding:12px;">
      <div style="font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.05em;">Pageviews</div>
      <div style="font-size:24px;font-weight:700;color:#1a1a1a;">${queriesFailed ? '—' : num(totalViews)}</div>
      <div style="font-size:12px;color:${viewsChangeNum >= 0 ? '#16a34a' : '#dc2626'};">${viewsDelta}</div>
    </div>
    <div style="flex:1;background:white;border:1px solid #e5e5e3;border-radius:4px;padding:12px;">
      <div style="font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.05em;">Visitors</div>
      <div style="font-size:24px;font-weight:700;color:#1a1a1a;">${queriesFailed ? '—' : num(totalVisitors)}</div>
      <div style="font-size:12px;color:${viewsChangeNum >= 0 ? '#16a34a' : '#dc2626'};">${visitorsDelta}</div>
    </div>
    <div style="flex:1;background:white;border:1px solid #e5e5e3;border-radius:4px;padding:12px;">
      <div style="font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.05em;">Events</div>
      <div style="font-size:24px;font-weight:700;color:#1a1a1a;">${queriesFailed ? '—' : num(totalEvents)}</div>
    </div>
  </div>

  ${anomalies.length > 0 ? `
  <!-- Anomaly Alert -->
  <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:4px;padding:12px;margin-bottom:24px;">
    <div style="font-size:12px;font-weight:600;color:#ea580c;margin-bottom:4px;">Alert</div>
    ${anomalies.map((a) => `<div style="font-size:13px;color:#9a3412;">${a}</div>`).join('')}
  </div>` : ''}

  <!-- Top Pages -->
  <div style="margin-bottom:24px;">
    <h2 style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:8px;">Top Pages</h2>
    <div style="background:white;border:1px solid #e5e5e3;border-radius:4px;overflow:hidden;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:2px solid #e5e5e3;">
            <th style="text-align:left;padding:8px 12px;font-size:11px;color:#8a8a8a;text-transform:uppercase;">Path</th>
            <th style="text-align:right;padding:8px 12px;font-size:11px;color:#8a8a8a;text-transform:uppercase;">Views</th>
          </tr>
        </thead>
        <tbody>
          ${top5Pages.map((p) => `
          <tr style="border-bottom:1px solid #f0f0ee;">
            <td style="padding:8px 12px;color:#4a4a4a;">${siteUrl}${p.path}</td>
            <td style="padding:8px 12px;color:#4a4a4a;text-align:right;font-variant-numeric:tabular-nums;">${num(p.views)}</td>
          </tr>`).join('')}
          ${top5Pages.length === 0 ? '<tr><td colspan="2" style="padding:16px;text-align:center;color:#8a8a8a;">No data</td></tr>' : ''}
        </tbody>
      </table>
    </div>
  </div>

  <!-- Referrers -->
  ${top3Referrers.length > 0 ? `
  <div style="margin-bottom:24px;">
    <h2 style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:8px;">Top Referrers</h2>
    <div style="background:white;border:1px solid #e5e5e3;border-radius:4px;padding:12px;">
      ${top3Referrers.map((r) => `
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;">
        <span style="color:#4a4a4a;">${r.referrer}</span>
        <span style="color:#8a8a8a;font-variant-numeric:tabular-nums;">${num(r.visits)}</span>
      </div>`).join('')}
    </div>
  </div>` : ''}

  <!-- Countries -->
  ${top3Countries.length > 0 ? `
  <div style="margin-bottom:24px;">
    <h2 style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:8px;">Top Countries</h2>
    <div style="background:white;border:1px solid #e5e5e3;border-radius:4px;padding:12px;">
      ${top3Countries.map((c) => `
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;">
        <span style="color:#4a4a4a;">${c.country}</span>
        <span style="color:#8a8a8a;font-variant-numeric:tabular-nums;">${num(c.views)}</span>
      </div>`).join('')}
    </div>
  </div>` : ''}

  <!-- Bot Traffic -->
  ${totalBotHits > 0 ? `
  <div style="margin-bottom:24px;">
    <h2 style="font-size:14px;font-weight:600;color:#1a1a1a;margin-bottom:8px;">Bot Traffic</h2>
    <div style="background:white;border:1px solid #e5e5e3;border-radius:4px;padding:12px;">
      <div style="font-size:13px;color:#4a4a4a;margin-bottom:8px;">
        <strong>${num(totalBotHits)}</strong> bot requests blocked
        ${totalViews > 0 ? ` (${((totalBotHits / (totalViews + totalBotHits)) * 100).toFixed(1)}% of all traffic)` : ''}
      </div>
      ${top5Bots.length > 0 ? `
      <div style="font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">Top bots</div>
      ${top5Bots.map((b) => `
      <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:12px;">
        <span style="color:#6a6a6a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:400px;">${String(b.user_agent).slice(0, 60)}</span>
        <span style="color:#8a8a8a;font-variant-numeric:tabular-nums;flex-shrink:0;margin-left:8px;">${num(b.hits)}</span>
      </div>`).join('')}` : ''}
    </div>
  </div>` : ''}

  <!-- Footer -->
  <div style="text-align:center;padding:16px 0;border-top:1px solid #e5e5e3;">
    <p style="font-size:12px;color:#8a8a8a;">
      Sent by <a href="https://flarelytics.dev" style="color:#dc6b14;text-decoration:none;">Flarelytics</a>
      ${siteUrl ? ` — <a href="${siteUrl}" style="color:#dc6b14;text-decoration:none;">View site</a>` : ''}
    </p>
  </div>
</div>
</body>
</html>`;

  return { subject, html };
}

// Send email via HTTP API (Euromail, Resend, SendGrid, etc.)
async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  try {
    const apiUrl = env.EMAIL_API_URL.replace(/\/$/, '');
    const res = await fetch(`${apiUrl}/v1/emails`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.EMAIL_API_KEY}`,
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to,
        subject,
        html_body: html,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.log(`[reports] Email API error ${res.status}: ${errText}`);
    }
    return res.ok;
  } catch (err) {
    console.log(`[reports] Failed to send to ${to}: ${err}`);
    return false;
  }
}

// Get all recipients from KV
async function getRecipients(env: Env): Promise<string[]> {
  const list = await env.REPORT_RECIPIENTS.list();
  return list.keys.map((k) => k.name);
}

function isAuthenticated(request: Request, env: Env): boolean {
  const key = request.headers.get('X-API-Key');
  return !!key && key === env.ADMIN_API_KEY;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[reports] Cron triggered at ${new Date().toISOString()}`);

    const recipients = await getRecipients(env);
    if (recipients.length === 0) {
      console.log('[reports] No recipients configured, skipping');
      return;
    }

    const { subject, html } = await generateReport(env);

    let sent = 0;
    let failed = 0;
    for (const email of recipients) {
      const ok = await sendEmail(env, email, subject, html);
      if (ok) sent++;
      else failed++;
    }

    console.log(`[reports] Sent to ${sent}/${recipients.length} recipients (${failed} failed)`);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/health') {
      return Response.json({
        status: 'ok',
        service: 'flarelytics-email-reports',
        analytics_worker: env.ANALYTICS_WORKER_URL,
        email_configured: !!env.EMAIL_API_URL && !!env.EMAIL_API_KEY,
      });
    }

    // All other endpoints require auth
    if (!isAuthenticated(request, env)) {
      return new Response('Unauthorized', { status: 401 });
    }

    // List recipients
    if (pathname === '/recipients' && request.method === 'GET') {
      const recipients = await getRecipients(env);
      return Response.json({ recipients });
    }

    // Add recipient
    if (pathname === '/recipients' && request.method === 'POST') {
      const body = await request.json() as { email?: string };
      if (!body.email || !body.email.includes('@')) {
        return Response.json({ error: 'Invalid email' }, { status: 400 });
      }
      await env.REPORT_RECIPIENTS.put(body.email, new Date().toISOString());
      return Response.json({ ok: true, email: body.email });
    }

    // Remove recipient
    if (pathname === '/recipients' && request.method === 'DELETE') {
      const body = await request.json() as { email?: string };
      if (!body.email) {
        return Response.json({ error: 'Missing email' }, { status: 400 });
      }
      await env.REPORT_RECIPIENTS.delete(body.email);
      return Response.json({ ok: true, removed: body.email });
    }

    // Send test report
    if (pathname === '/test' && request.method === 'POST') {
      const body = await request.json() as { email?: string };
      const email = body.email;
      if (!email || !email.includes('@')) {
        return Response.json({ error: 'Provide email to send test to' }, { status: 400 });
      }

      const { subject, html } = await generateReport(env);
      const ok = await sendEmail(env, email, subject, html);
      return Response.json({ ok, subject, sentTo: email });
    }

    return new Response('Not Found', { status: 404 });
  },
};
