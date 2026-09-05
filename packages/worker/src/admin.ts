/**
 * /admin/sites: org-scoped site management (session auth) plus the legacy
 * X-API-Key path that manages the global `allowed_origins` CORS list.
 */
import type { Env } from './env';
import { readSession } from './auth/session';
import { isSameOrigin, canManage, activeOrgId } from './auth/middleware';
import { dashboardOrigins } from './auth/routes';
import {
  listSites, claimSite, verifySite, removeSite,
  SiteConflictError, NoClaimError, VerificationError,
} from './auth/sites-store';
import { timingSafeEqual } from './auth/crypto';
import { dataCorsHeaders, getAllowedOrigins } from './cors';

export async function handleAdminSites(request: Request, env: Env): Promise<Response> {
  const cors = dataCorsHeaders(request, env);

  if (!env.SITE_CONFIG) {
    return Response.json({ error: 'KV not configured', hint: 'Add a [[kv_namespaces]] binding named SITE_CONFIG to wrangler.toml and deploy.' }, { status: 503, headers: cors });
  }

  // Legacy mode: a valid X-API-Key manages the GLOBAL allowed_origins list
  // (programmatic/admin), unchanged for back-compat.
  const apiKey = request.headers.get('X-API-Key');
  if (apiKey && env.QUERY_API_KEY && timingSafeEqual(apiKey, env.QUERY_API_KEY)) {
    return handleAdminSitesLegacy(request, env, cors);
  }

  // Session mode: org-scoped management of the active organization's sites.
  const session = await readSession(request, env.SESSION_SECRET || '');
  if (!session) {
    return Response.json({ error: 'Unauthorized', hint: 'Sign in via /api/auth/login or include X-API-Key.' }, { status: 401, headers: cors });
  }
  const orgId = activeOrgId(session);
  if (!orgId) return Response.json({ error: 'No active organization' }, { status: 403, headers: cors });

  if (request.method === 'GET') {
    const sites = await listSites(env.SITE_CONFIG, orgId);
    return Response.json({ sites }, { headers: cors });
  }

  // Mutations require owner/admin role + a same-origin request (CSRF defense).
  if (request.method === 'POST' || request.method === 'DELETE') {
    if (!isSameOrigin(request, dashboardOrigins(env))) {
      return Response.json({ error: 'Forbidden' }, { status: 403, headers: cors });
    }
    if (!canManage(session)) {
      return Response.json({ error: 'Rooli ei riitä tähän toimintoon' }, { status: 403, headers: cors });
    }
    const body = await request.json().catch(() => ({})) as { hostname?: string; origin?: string; label?: string };
    const hostname = normalizeHostname(body.hostname || body.origin);
    if (!hostname) return Response.json({ error: 'hostname required', hint: 'Pass a plain hostname, e.g. example.com' }, { status: 400, headers: cors });

    const isVerify = new URL(request.url).pathname.endsWith('/verify');

    if (request.method === 'DELETE') {
      const sites = await removeSite(env.SITE_CONFIG, orgId, hostname);
      return Response.json({ sites }, { headers: cors });
    }

    // POST: either start/resume a claim, or verify a pending claim. A hostname
    // is only added to the org (and granted query access) once DNS-verified, so
    // an org can't read a site it doesn't provably control.
    try {
      if (isVerify) {
        const sites = await verifySite(env.SITE_CONFIG, orgId, hostname, body.label);
        return Response.json({ verified: true, sites }, { headers: cors });
      }
      const result = await claimSite(env.SITE_CONFIG, orgId, hostname, body.label);
      if ('pending' in result) {
        return Response.json(result, { status: 202, headers: cors });
      }
      return Response.json({ sites: result }, { headers: cors });
    } catch (err) {
      if (err instanceof SiteConflictError) {
        return Response.json({ error: 'conflict', hint: 'This hostname is already verified by another organization.' }, { status: 409, headers: cors });
      }
      if (err instanceof NoClaimError) {
        return Response.json({ error: 'no_claim', hint: 'Start a claim with POST /admin/sites before verifying.' }, { status: 400, headers: cors });
      }
      if (err instanceof VerificationError) {
        return Response.json({
          error: 'verification_failed',
          hint: `Add a DNS TXT record at ${err.recordName} with value "${err.recordValue}", then verify again. DNS changes can take a few minutes.`,
          verification: { type: 'dns-txt', name: err.recordName, value: err.recordValue },
        }, { status: 422, headers: cors });
      }
      throw err;
    }
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405, headers: cors });
}

/** Accepts a bare hostname or an origin URL and returns a plain hostname, or null if invalid. */
export function normalizeHostname(input: string | undefined): string | null {
  const raw = (input || '').trim();
  if (!raw) return null;
  let host = raw;
  if (raw.includes('://')) {
    try { host = new URL(raw).hostname; } catch { return null; }
  } else if (raw.includes('/')) {
    host = raw.split('/')[0];
  }
  host = host.toLowerCase();
  // Require a real dotted hostname: labels of [a-z0-9-] (no leading/trailing
  // hyphen), at least two labels, no leading/trailing/double dots.
  const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
  return HOSTNAME.test(host) ? host : null;
}

/** Legacy X-API-Key path: CRUD over the global allowed_origins CORS list. */
async function handleAdminSitesLegacy(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  const KV_KEY = 'allowed_origins';

  async function readSites(): Promise<string[]> {
    const raw = await env.SITE_CONFIG.get(KV_KEY);
    if (raw) return JSON.parse(raw);
    return getAllowedOrigins(env);
  }

  if (request.method === 'GET') {
    const sites = await readSites();
    return Response.json({ sites }, { headers: cors });
  }

  if (request.method === 'POST') {
    const body = await request.json() as { origin?: string };
    const origin = body?.origin?.trim();
    if (!origin) return Response.json({ error: 'origin required' }, { status: 400, headers: cors });
    try { new URL(origin); } catch {
      return Response.json({ error: 'origin must be a valid URL, e.g. https://example.com' }, { status: 400, headers: cors });
    }
    const sites = await readSites();
    if (!sites.includes(origin)) {
      sites.push(origin);
      await env.SITE_CONFIG.put(KV_KEY, JSON.stringify(sites));
    }
    return Response.json({ sites }, { headers: cors });
  }

  if (request.method === 'DELETE') {
    const body = await request.json() as { origin?: string };
    const origin = body?.origin?.trim();
    if (!origin) return Response.json({ error: 'origin required' }, { status: 400, headers: cors });
    const sites = (await readSites()).filter((s) => s !== origin);
    await env.SITE_CONFIG.put(KV_KEY, JSON.stringify(sites));
    return Response.json({ sites }, { headers: cors });
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405, headers: cors });
}
