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

interface Env {
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

// Fetch analytics data from the Flarelytics worker
async function queryAnalytics(
  env: Env,
  queryName: string,
  period = '7d',
): Promise<AnalyticsRow[]> {
  const url = `${env.ANALYTICS_WORKER_URL}/query?q=${queryName}&period=${period}`;
  const res = await fetch(url, {
    headers: { 'X-API-Key': env.ANALYTICS_API_KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return [];
  const data = await res.json() as { data?: AnalyticsRow[] } | AnalyticsRow[];
  return Array.isArray(data) ? data : (data.data || []);
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
async function generateReport(env: Env): Promise<{ subject: string; html: string }> {
  // Fetch current and previous period data
  const [
    dailyViews,
    dailyVisitors,
    topPages,
    referrers,
    countries,
    customEvents,
    prevDailyViews,
    prevDailyVisitors,
  ] = await Promise.all([
    queryAnalytics(env, 'daily-views', '7d'),
    queryAnalytics(env, 'daily-unique-visitors', '7d'),
    queryAnalytics(env, 'top-pages', '7d'),
    queryAnalytics(env, 'referrers', '7d'),
    queryAnalytics(env, 'countries', '7d'),
    queryAnalytics(env, 'custom-events', '7d'),
    queryAnalytics(env, 'daily-views', '30d'),
    queryAnalytics(env, 'daily-unique-visitors', '30d'),
  ]);

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

  // Detect anomalies (>30% change)
  const anomalies: string[] = [];
  const viewsChangeNum = prevViews > 0 ? ((totalViews - prevViews) / prevViews) * 100 : 0;
  if (viewsChangeNum > 30) anomalies.push(`Traffic spike: pageviews up ${viewsDelta} vs last week`);
  if (viewsChangeNum < -30) anomalies.push(`Traffic drop: pageviews down ${viewsDelta} vs last week`);

  const subject = `${siteName} — Weekly Analytics: ${num(totalViews)} views, ${num(totalVisitors)} visitors`;

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

  <!-- KPI Cards -->
  <div style="display:flex;gap:12px;margin-bottom:24px;">
    <div style="flex:1;background:white;border:1px solid #e5e5e3;border-radius:4px;padding:12px;">
      <div style="font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.05em;">Pageviews</div>
      <div style="font-size:24px;font-weight:700;color:#1a1a1a;">${num(totalViews)}</div>
      <div style="font-size:12px;color:${viewsChangeNum >= 0 ? '#16a34a' : '#dc2626'};">${viewsDelta}</div>
    </div>
    <div style="flex:1;background:white;border:1px solid #e5e5e3;border-radius:4px;padding:12px;">
      <div style="font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.05em;">Visitors</div>
      <div style="font-size:24px;font-weight:700;color:#1a1a1a;">${num(totalVisitors)}</div>
      <div style="font-size:12px;color:${viewsChangeNum >= 0 ? '#16a34a' : '#dc2626'};">${visitorsDelta}</div>
    </div>
    <div style="flex:1;background:white;border:1px solid #e5e5e3;border-radius:4px;padding:12px;">
      <div style="font-size:11px;color:#8a8a8a;text-transform:uppercase;letter-spacing:0.05em;">Events</div>
      <div style="font-size:24px;font-weight:700;color:#1a1a1a;">${num(totalEvents)}</div>
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
