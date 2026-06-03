/**
 * Auth HTTP handlers: OIDC login, callback, logout, current-user, and
 * switch-org. Mirrors the helpparibotti auth route, with the palvelureppu
 * subscription/billing check removed — any authenticated palvelureppu user gets
 * their organizations.
 *
 * `handleMe` additionally returns the active org's site list so the dashboard
 * can populate its site switcher in a single round-trip.
 */

import {
  generatePkce, generateState, generateNonce,
  buildOidcFlowCookie, readOidcFlowCookie, clearOidcFlowCookieHeader,
  buildAuthorizeUrl, exchangeCode, verifyIdToken, buildEndSessionUrl,
} from './oidc';
import {
  createSessionCookie, readSession, clearSessionCookieHeader, buildOrgList,
} from './session';
import {
  maybeRefreshSession, storeRefreshToken, deleteRefreshToken,
} from './session-refresh';
import { activeOrgId, isSameOrigin } from './middleware';
import { listSites } from './sites-store';

const CALLBACK_PATH = '/api/auth/oidc/callback';
const OIDC_SCOPE = 'openid email profile orgs roles offline_access';

export interface AuthEnv {
  SITE_CONFIG: KVNamespace;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  SESSION_SECRET?: string;
  DASHBOARD_URL?: string;
  COOKIE_DOMAIN?: string;
  ADMIN_EMAILS?: string;
}

/** Dashboard origins permitted for credentialed CORS + the CSRF same-origin guard. */
export function dashboardOrigins(env: AuthEnv): string[] {
  const origins: string[] = [];
  if (env.DASHBOARD_URL) {
    try { origins.push(new URL(env.DASHBOARD_URL).origin); } catch { /* ignore */ }
  }
  origins.push('http://localhost:4321');
  return origins;
}

/** Credentialed CORS headers — echoes the request origin only if it is an allowed dashboard origin. */
export function authCorsHeaders(request: Request, env: AuthEnv): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowed = dashboardOrigins(env).includes(origin);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function homeUrl(env: AuthEnv): string {
  return env.DASHBOARD_URL || 'http://localhost:4321/';
}

function originOf(request: Request): string {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

/**
 * Allow only same-origin relative paths in the post-login redirect. Open-redirect
 * (OWASP A01) defense: `return_to` comes from the user and must not redirect out
 * of the service after authentication. Rejects absolute URLs, protocol-relative
 * (`//evil`), backslash tricks (`/\evil`) and control characters.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/';
  if (raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return '/';
  return raw;
}

/** Resolve a return_to path into an absolute dashboard URL. */
function dashboardRedirect(env: AuthEnv, returnTo: string): string {
  const base = homeUrl(env).replace(/\/+$/, '');
  return base + safeReturnTo(returnTo);
}

export async function handleLogin(request: Request, env: AuthEnv): Promise<Response> {
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, SESSION_SECRET: secret } = env;
  if (!issuer || !clientId || !secret) {
    return new Response('SSO ei ole konfiguroitu', { status: 503 });
  }
  const redirectUri = env.OIDC_REDIRECT_URI || originOf(request) + CALLBACK_PATH;
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('return_to'));
  const { verifier, challenge } = await generatePkce();
  const state = generateState();
  const nonce = generateNonce();
  const [authorizeUrl, flowCookie] = await Promise.all([
    buildAuthorizeUrl({ issuer, clientId, redirectUri, scope: OIDC_SCOPE, state, nonce, codeChallenge: challenge }),
    buildOidcFlowCookie({ state, nonce, verifier, returnTo, secret }),
  ]);
  const headers = new Headers({ Location: authorizeUrl, 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', flowCookie);
  return new Response(null, { status: 302, headers });
}

export async function handleCallback(request: Request, env: AuthEnv): Promise<Response> {
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret, SESSION_SECRET: secret } = env;
  if (!issuer || !clientId || !secret) {
    return new Response('SSO ei ole konfiguroitu', { status: 503 });
  }
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');
  const clearFlow = clearOidcFlowCookieHeader();

  function errResponse(msg: string, status = 400): Response {
    const h = new Headers({ 'Content-Type': 'text/plain; charset=utf-8' });
    h.append('Set-Cookie', clearFlow);
    return new Response(msg, { status, headers: h });
  }

  if (errorParam) return errResponse('Kirjautuminen peruutettu: ' + errorParam);
  if (!code || !state) return errResponse('Virheellinen callback-pyyntö');

  const flow = await readOidcFlowCookie(request, secret);
  if (!flow || flow.state !== state) return errResponse('Istunto vanhentunut tai CSRF-virhe');

  let idToken: string | undefined, grantedScope = '', refreshToken: string | null = null;
  try {
    const redirectUri = env.OIDC_REDIRECT_URI || originOf(request) + CALLBACK_PATH;
    const tokens = await exchangeCode({ issuer, clientId, clientSecret, code, codeVerifier: flow.verifier, redirectUri });
    idToken = tokens.id_token;
    grantedScope = tokens.scope || '';
    refreshToken = tokens.refresh_token || null;
  } catch (e) {
    return errResponse('Token-vaihto epäonnistui: ' + (e as Error).message, 502);
  }

  let claims;
  try {
    claims = await verifyIdToken({ idToken: idToken as string, issuer, clientId, expectedNonce: flow.nonce });
  } catch (e) {
    return errResponse('ID-token virheellinen: ' + (e as Error).message, 401);
  }

  const { email, name, picture, sub } = claims;
  if (!sub) return errResponse('ID-token ilman subjektia', 401);

  // Fail-safe: if the orgs scope was not granted the org model is misconfigured.
  // Don't read that as "0 organizations" — distinguish a non-granted scope from a
  // genuinely empty membership.
  const orgsGranted = grantedScope.split(/\s+/).includes('orgs');
  if (!orgsGranted) {
    return errResponse('Organisaatiotuki ei ole konfiguroitu (orgs-scope puuttuu)', 503);
  }

  const orgs = buildOrgList(sub, Array.isArray(claims.orgs) ? claims.orgs : []);
  const active_org = sub; // default workspace is personal; switching is explicit

  const { cookieHeader, sid } = await createSessionCookie({
    email: email || '', name, picture, sub, orgs, active_org, secret,
    cookieDomain: env.COOKIE_DOMAIN,
  });

  // Store the refresh token in KV keyed by sid → enables silent orgs/roles
  // refresh without re-login.
  if (refreshToken) await storeRefreshToken(env, sid, refreshToken);

  const headers = new Headers({ Location: dashboardRedirect(env, flow.return_to), 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', cookieHeader);
  headers.append('Set-Cookie', clearFlow);
  return new Response(null, { status: 302, headers });
}

export async function handleLogout(request: Request, env: AuthEnv): Promise<Response> {
  const { OIDC_ISSUER: issuer } = env;
  const session = await readSession(request, env.SESSION_SECRET || '').catch(() => null);
  if (session && session.sid) await deleteRefreshToken(env, session.sid);
  const clearSession = clearSessionCookieHeader(env.COOKIE_DOMAIN);
  const clearFlow = clearOidcFlowCookieHeader();
  let redirectUrl = homeUrl(env);
  if (issuer) {
    try {
      redirectUrl = (await buildEndSessionUrl({ issuer, postLogoutRedirectUri: homeUrl(env) })) || homeUrl(env);
    } catch { /* fall back to home */ }
  }
  const headers = new Headers({ Location: redirectUrl });
  headers.append('Set-Cookie', clearSession);
  headers.append('Set-Cookie', clearFlow);
  return new Response(null, { status: 302, headers });
}

export async function handleMe(request: Request, env: AuthEnv): Promise<Response> {
  const cors = authCorsHeaders(request, env);
  let session = await readSession(request, env.SESSION_SECRET || '');
  if (!session) {
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 401, headers: { 'Content-Type': 'application/json', ...cors },
    });
  }

  // Silent refresh: pull fresh orgs/roles if stale and set an updated cookie.
  let refreshCookie: string | null = null;
  try {
    const r = await maybeRefreshSession(request, env, session);
    session = r.session as typeof session;
    refreshCookie = r.cookieHeader;
  } catch (e) {
    console.warn('[auth/me] refresh ohitettu:', (e as Error).message);
  }

  const activeId = activeOrgId(session);
  const active = (session.orgs || []).find((o) => o.id === activeId) || null;
  const sites = activeId ? await listSites(env.SITE_CONFIG, activeId) : [];

  const headers = new Headers({ 'Content-Type': 'application/json', ...cors });
  if (refreshCookie) headers.append('Set-Cookie', refreshCookie);
  return new Response(JSON.stringify({
    authenticated: true,
    email: session.email,
    name: session.name,
    picture: session.picture,
    sub: session.sub,
    orgs: session.orgs || [],
    active_org: activeId,
    role: active ? active.role : null,
    sites,
  }), { headers });
}

/**
 * POST /api/auth/switch-org — change the active workspace.
 *
 * IDOR defense: the target org must exist in the session's orgs list (derived
 * from the signed ID token), otherwise 403. CSRF defense: the request must come
 * from an allowed dashboard origin.
 */
export async function handleSwitchOrg(request: Request, env: AuthEnv): Promise<Response> {
  const cors = authCorsHeaders(request, env);
  if (!isSameOrigin(request, dashboardOrigins(env))) {
    return jsonError('Forbidden', 403, cors);
  }
  const session = await readSession(request, env.SESSION_SECRET || '');
  if (!session) return jsonError('Unauthorized', 401, cors);

  let body: { org_id?: string };
  try { body = await request.json(); } catch { return jsonError('Virheellinen pyyntö', 400, cors); }
  const targetId = body && body.org_id;
  if (!targetId) return jsonError('org_id puuttuu', 400, cors);

  const target = (session.orgs || []).find((o) => o.id === targetId);
  if (!target) return jsonError('Forbidden', 403, cors); // no membership → no existence hint

  const { cookieHeader } = await createSessionCookie({
    email: session.email, name: session.name, picture: session.picture,
    sub: session.sub, orgs: session.orgs, active_org: target.id,
    sid: session.sid, exp: session.exp, orgs_refreshed_at: session.orgs_refreshed_at,
    secret: env.SESSION_SECRET || '', cookieDomain: env.COOKIE_DOMAIN,
  });
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
  headers.append('Set-Cookie', cookieHeader);
  return new Response(JSON.stringify({ ok: true, active_org: target.id, role: target.role }), { headers });
}

function jsonError(message: string, status: number, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json', ...cors },
  });
}
