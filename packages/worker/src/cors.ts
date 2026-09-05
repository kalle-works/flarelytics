/**
 * CORS policy helpers. Three variants are needed:
 *  - `corsHeaders` — the plain per-site allowlist used by /track and (with
 *    allowAny) /public-stats.
 *  - `dataCorsHeaders` — the authenticated data endpoints (/query,
 *    /admin/sites), which additionally grant credentialed CORS to dashboard
 *    origins so the session cookie flows.
 */
import type { Env } from './env';
import { dashboardOrigins } from './auth/routes';

export function getAllowedOrigins(env: Env): string[] {
  return env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean) : [];
}

// Reads from KV first; falls back to ALLOWED_ORIGINS env var for backwards compat.
export async function fetchAllowedOrigins(env: Env): Promise<string[]> {
  if (env.SITE_CONFIG) {
    const raw = await env.SITE_CONFIG.get('allowed_origins');
    if (raw) return JSON.parse(raw) as string[];
  }
  return getAllowedOrigins(env);
}

export function corsHeaders(origin: string | null, allowedOrigins: string[], allowAny = false): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Max-Age': '86400',
  };
  if (allowAny && origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  } else if (origin && allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

/**
 * CORS for the authenticated data endpoints (/query, /admin/sites). Dashboard
 * origins get credentialed CORS (exact origin echo + credentials) so the
 * session cookie flows; other origins get a plain echo for legacy X-API-Key
 * programmatic use (no credentials). Never `*` on a credentialed response.
 */
export function dataCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && dashboardOrigins(env).includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  } else if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}
