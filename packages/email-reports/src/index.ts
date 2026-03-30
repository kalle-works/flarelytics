/**
 * Flarelytics Email Reports — Cloudflare Worker with cron trigger
 *
 * Sends weekly/monthly analytics digest emails via configurable email provider.
 * Runs on a schedule, queries the analytics worker, generates HTML email, sends.
 *
 * TODO: Implement in Phase 1.5
 */

interface Env {
  ANALYTICS_WORKER_URL: string;
  ANALYTICS_API_KEY: string;
  EMAIL_API_KEY: string;
  EMAIL_FROM: string;
  REPORT_RECIPIENTS: KVNamespace;
}

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[flarelytics-reports] Cron triggered at ${new Date().toISOString()}`);
    // TODO: Implement report generation and sending
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', service: 'flarelytics-email-reports' });
    }

    // TODO: Add recipient management endpoints
    // POST /recipients — add email
    // DELETE /recipients/:email — remove email
    // GET /recipients — list (authenticated)

    return new Response('Not Found', { status: 404 });
  },
};
