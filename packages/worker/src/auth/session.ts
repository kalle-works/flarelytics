/**
 * Signed (HMAC-SHA256) stateless session cookie. The cookie carries the user's
 * identity, their organizations, and the active organization — no server-side
 * session store. Org→site scoping is resolved per-request from KV, so it is
 * deliberately NOT embedded here (keeps the cookie small and makes site edits
 * take effect immediately).
 *
 * Cookie security (secure by default): `__Secure-` prefix, HttpOnly, Secure.
 * When COOKIE_DOMAIN is set (e.g. `flarelytics.dev`) the cookie is scoped to
 * that registrable domain with SameSite=Lax, making `app.` ↔ `api.` requests
 * first-party same-site — robust against Safari/Chrome third-party-cookie
 * blocking. Without a domain (local/preview) it falls back to the degraded
 * SameSite=None cross-site mode.
 *
 * Ported from the helpparibotti worker (worker/lib/session.js), minus billing.
 */

import {
  base64urlEncode, base64urlDecode, hmacSha256, timingSafeEqual,
  randomBytes, utf8ToBytes, bytesToUtf8,
} from './crypto';

export const SESSION_COOKIE_NAME = '__Secure-fl_session';
const COOKIE_MAXAGE = 8 * 60 * 60;

export interface Org {
  id: string;
  name: string;
  role: string;
}

export interface SessionPayload {
  sid: string;
  email: string;
  name: string;
  picture: string;
  sub: string | null;
  orgs: Org[];
  active_org: string | null;
  orgs_refreshed_at: number;
  iat: number;
  exp: number;
}

export interface CookieOptions {
  /** Registrable domain for the cookie (e.g. `flarelytics.dev`). Empty → no Domain attr, SameSite=None. */
  cookieDomain?: string;
}

/**
 * Synthetic personal workspace. The user's own `sub` is the org id, so a user
 * always has at least one workspace and existing per-`sub` data stays visible.
 */
export function personalOrg(sub: string): Org {
  return { id: sub, name: 'Henkilökohtainen', role: 'owner' };
}

/**
 * Merge the synthetic personal org with the provider's org memberships into one
 * list. Personal is always first (default workspace). De-dupes by id.
 */
export function buildOrgList(sub: string | null, claimOrgs?: Array<{ id?: string; name?: string; role?: string }>): Org[] {
  const list: Org[] = sub ? [personalOrg(sub)] : [];
  for (const o of claimOrgs || []) {
    if (!o || !o.id || o.id === sub) continue;
    list.push({ id: o.id, name: o.name || '', role: o.role || 'member' });
  }
  return list;
}

function buildCookieHeader(name: string, value: string, maxAge: number, opts: CookieOptions): string {
  const attrs = [`${name}=${value}`, `Path=/`, `HttpOnly`, `Secure`, `Max-Age=${maxAge}`];
  if (opts.cookieDomain) {
    attrs.push(`Domain=${opts.cookieDomain}`, `SameSite=Lax`);
  } else {
    // Degraded cross-site mode (no shared registrable domain). Required for the
    // cookie to be sent at all when dashboard and worker are on different sites.
    attrs.push(`SameSite=None`);
  }
  return attrs.join('; ');
}

export async function createSessionCookie(
  {
    email, name, picture, sub, orgs, active_org, secret,
    sid: keepSid, exp: keepExp, orgs_refreshed_at, cookieDomain,
  }: {
    email: string;
    name?: string;
    picture?: string;
    sub: string | null;
    orgs?: Org[];
    active_org?: string | null;
    secret: string;
    sid?: string;
    exp?: number;
    orgs_refreshed_at?: number;
    cookieDomain?: string;
  },
): Promise<{ cookieHeader: string; sid: string; payload: SessionPayload }> {
  if (!secret) throw new Error('SESSION_SECRET puuttuu');
  const sid = keepSid || base64urlEncode(randomBytes(16));
  const now = Math.floor(Date.now() / 1000);
  const orgList = (Array.isArray(orgs) && orgs.length) ? orgs : buildOrgList(sub, []);
  // active_org is always explicit and must belong to orgs; otherwise default to sub.
  const active = orgList.some((o) => o.id === active_org) ? (active_org as string) : (sub || null);
  const exp = keepExp || (now + COOKIE_MAXAGE);
  const payload: SessionPayload = {
    sid, email,
    name: name || '',
    picture: picture || '',
    sub: sub || null,
    orgs: orgList,
    active_org: active,
    orgs_refreshed_at: orgs_refreshed_at || now,
    iat: now,
    exp,
  };
  const payloadB64 = base64urlEncode(utf8ToBytes(JSON.stringify(payload)));
  const macBytes = await hmacSha256(secret, payloadB64);
  const value = `${payloadB64}.${base64urlEncode(macBytes)}`;
  const maxAge = Math.max(1, exp - now);
  const cookieHeader = buildCookieHeader(SESSION_COOKIE_NAME, value, maxAge, { cookieDomain });
  return { cookieHeader, sid, payload };
}

export function clearSessionCookieHeader(cookieDomain?: string): string {
  return buildCookieHeader(SESSION_COOKIE_NAME, '', 0, { cookieDomain });
}

export async function readSession(request: Request, secret: string): Promise<SessionPayload | null> {
  if (!secret) return null;
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(
    new RegExp('(?:^|;\\s*)' + SESSION_COOKIE_NAME.replace(/[-]/g, '\\$&') + '=([^;]+)'),
  );
  if (!match) return null;
  const value = match[1];
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const payloadB64 = value.slice(0, dot);
  const macB64 = value.slice(dot + 1);
  let expectedMac: Uint8Array;
  try { expectedMac = await hmacSha256(secret, payloadB64); } catch { return null; }
  let receivedMac: Uint8Array;
  try { receivedMac = base64urlDecode(macB64); } catch { return null; }
  if (!timingSafeEqual(expectedMac, receivedMac)) return null;
  let payload: SessionPayload;
  try { payload = JSON.parse(bytesToUtf8(base64urlDecode(payloadB64))); } catch { return null; }
  if (!payload || typeof payload.exp !== 'number') return null;
  if (payload.exp * 1000 < Date.now()) return null;
  if (!Array.isArray(payload.orgs)) {
    payload.orgs = buildOrgList(payload.sub, []);
    payload.active_org = payload.sub;
  }
  if (typeof payload.orgs_refreshed_at !== 'number') {
    payload.orgs_refreshed_at = payload.iat || 0;
  }
  return payload;
}
