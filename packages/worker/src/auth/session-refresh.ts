/**
 * Silent refresh of org memberships and roles. The session cookie is signed and
 * stateless, so without this a removed member or a downgraded role would persist
 * for the full 8h session lifetime. Here we periodically re-fetch live claims
 * from the provider (via a refresh token stored in KV keyed by `sid`) and
 * re-issue the cookie — without forcing re-login.
 *
 * Ported from the helpparibotti worker (worker/lib/session-refresh.js).
 */

import { refreshTokens, fetchUserinfo } from './oidc';
import { createSessionCookie, buildOrgList } from './session';
import type { SessionPayload } from './session';

// How stale orgs/roles may be before a silent refresh. 15 min narrows the
// staleness window from 8h to ~15min.
const REFRESH_INTERVAL_SECS = 15 * 60;
const REFRESH_KV_TTL = 8 * 60 * 60;

export const REFRESH_KV_PREFIX = 'fl_refresh:';
const REFRESH_LOCK_PREFIX = 'fl_refresh_lock:';
const REFRESH_LOCK_TTL = 20; // s — best-effort lock for concurrent refreshes

export interface RefreshEnv {
  SITE_CONFIG: KVNamespace;
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  COOKIE_DOMAIN?: string;
}

/** Store the session's refresh token in KV keyed by sid. */
export async function storeRefreshToken(env: RefreshEnv, sid: string, refreshToken: string, ttl = REFRESH_KV_TTL): Promise<void> {
  if (!env.SITE_CONFIG || !sid || !refreshToken) return;
  try {
    await env.SITE_CONFIG.put(REFRESH_KV_PREFIX + sid, refreshToken, { expirationTtl: Math.max(60, ttl) });
  } catch (e) {
    console.warn('[session-refresh] KV put epäonnistui:', (e as Error).message);
  }
}

/** Remove the session's refresh token (logout). */
export async function deleteRefreshToken(env: RefreshEnv, sid: string): Promise<void> {
  if (!env.SITE_CONFIG || !sid) return;
  try { await env.SITE_CONFIG.delete(REFRESH_KV_PREFIX + sid); } catch { /* best-effort */ }
}

/**
 * Refresh the session's orgs/roles from the provider if stale.
 *
 * Returns { session, cookieHeader }:
 *  - cookieHeader != null → caller must set Set-Cookie; returned session is fresh.
 *  - cookieHeader == null → no change (fresh, no refresh token, or refresh
 *    failed — the session stands until the hard 8h expiry).
 *
 * sid and exp are preserved (KV key stays, absolute lifetime does not slide). A
 * network error never locks the user out.
 */
export async function maybeRefreshSession(
  _request: Request, env: RefreshEnv, session: SessionPayload | null,
): Promise<{ session: SessionPayload | null; cookieHeader: string | null }> {
  if (!session) return { session, cookieHeader: null };

  const now = Math.floor(Date.now() / 1000);
  const lastRefresh = session.orgs_refreshed_at || session.iat || 0;
  if (now - lastRefresh < REFRESH_INTERVAL_SECS) return { session, cookieHeader: null };
  if (!env.SITE_CONFIG || !session.sid) return { session, cookieHeader: null };

  const refreshToken = await env.SITE_CONFIG.get(REFRESH_KV_PREFIX + session.sid);
  if (!refreshToken) return { session, cookieHeader: null };

  // Best-effort lock so two concurrent /me calls don't both rotate the refresh
  // token and invalidate the family. KV is eventually consistent — covers the
  // common case, not a hard guarantee.
  const lockKey = REFRESH_LOCK_PREFIX + session.sid;
  if (await env.SITE_CONFIG.get(lockKey)) return { session, cookieHeader: null };
  try { await env.SITE_CONFIG.put(lockKey, '1', { expirationTtl: REFRESH_LOCK_TTL }); } catch { /* best-effort */ }

  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret, SESSION_SECRET: secret } = env;
  if (!issuer || !clientId || !secret) return { session, cookieHeader: null };

  const now2 = Math.floor(Date.now() / 1000);
  let tokens, userinfo;
  try {
    tokens = await refreshTokens({ issuer, clientId, clientSecret, refreshToken });
    userinfo = await fetchUserinfo(issuer, tokens.access_token as string);
    // The userinfo sub must match the session — never let another subject's
    // orgs land in this session due to an IdP bug or token mix-up.
    if (userinfo.sub && userinfo.sub !== session.sub) {
      throw new Error('userinfo sub ei täsmää sessioon');
    }
  } catch (e) {
    console.warn('[session-refresh] refresh epäonnistui:', (e as Error).message);
    try { await env.SITE_CONFIG.delete(lockKey); } catch { /* best-effort */ }
    return { session, cookieHeader: null };
  }

  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    await storeRefreshToken(env, session.sid, tokens.refresh_token, (session.exp || now2) - now2);
  }
  try { await env.SITE_CONFIG.delete(lockKey); } catch { /* best-effort */ }

  const orgs = buildOrgList(session.sub, Array.isArray(userinfo.orgs) ? userinfo.orgs : []);
  const { cookieHeader, payload } = await createSessionCookie({
    email: session.email, name: session.name, picture: session.picture,
    sub: session.sub, orgs, active_org: session.active_org,
    sid: session.sid, exp: session.exp, orgs_refreshed_at: now, secret,
    cookieDomain: env.COOKIE_DOMAIN,
  });
  return { session: payload, cookieHeader };
}
