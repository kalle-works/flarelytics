/**
 * OpenID Connect client for the palvelureppu identity provider
 * (https://id.palvelureppu.fi). Authorization Code flow with PKCE, signed
 * flow-state cookie, full ES256 ID-token verification against the provider's
 * JWKS, refresh-token grant, and userinfo lookup.
 *
 * Ported from the helpparibotti worker (worker/lib/oidc.js). The provider
 * signs ID tokens with ES256 (P-256), which we verify here — never trusting
 * unverified token claims.
 */

import {
  base64urlEncode, base64urlDecode, hmacSha256, timingSafeEqual,
  randomBytes, utf8ToBytes, bytesToUtf8, sha256Base64Url, verifyEs256,
} from './crypto';

const FLOW_COOKIE = '__Host-fl_oidc_flow';
const FLOW_COOKIE_TTL = 10 * 60;
const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECS = 30;

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

interface Jwks {
  keys?: Array<{ kid?: string; use?: string; kty?: string; crv?: string; x?: string; y?: string }>;
}

export interface OidcTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
}

export interface OidcClaims {
  sub?: string;
  email?: string;
  name?: string;
  picture?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  iat?: number;
  nonce?: string;
  orgs?: Array<{ id: string; name?: string; role?: string }>;
  roles?: string[];
}

export interface OidcFlowState {
  state: string;
  nonce: string;
  verifier: string;
  return_to: string;
  iat: number;
}

const _memCache = new Map<string, { data: unknown; expiresAt: number }>();

export async function fetchDiscovery(issuer: string): Promise<OidcDiscovery> {
  return cachedJson(trimSlash(issuer) + '/.well-known/openid-configuration') as Promise<OidcDiscovery>;
}

export async function fetchJwks(jwksUri: string): Promise<Jwks> {
  return cachedJson(jwksUri) as Promise<Jwks>;
}

async function cachedJson(url: string): Promise<unknown> {
  const cached = _memCache.get(url);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.data;
  const res = await fetch(url, {
    cf: { cacheTtl: 300, cacheEverything: true },
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`OIDC fetch ${res.status} ${url}`);
  const data = await res.json();
  _memCache.set(url, { data, expiresAt: now + DISCOVERY_TTL_MS });
  return data;
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = await sha256Base64Url(verifier);
  return { verifier, challenge };
}

export function generateState(): string { return base64urlEncode(randomBytes(24)); }
export function generateNonce(): string { return base64urlEncode(randomBytes(24)); }

export async function buildOidcFlowCookie(
  { state, nonce, verifier, returnTo, secret }:
  { state: string; nonce: string; verifier: string; returnTo?: string; secret: string },
): Promise<string> {
  if (!secret) throw new Error('SESSION_SECRET puuttuu');
  const payload: OidcFlowState = { state, nonce, verifier, return_to: returnTo || '/', iat: Math.floor(Date.now() / 1000) };
  const payloadB64 = base64urlEncode(utf8ToBytes(JSON.stringify(payload)));
  const mac = await hmacSha256(secret, payloadB64);
  const value = `${payloadB64}.${base64urlEncode(mac)}`;
  return [`${FLOW_COOKIE}=${value}`, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=${FLOW_COOKIE_TTL}`].join('; ');
}

export function clearOidcFlowCookieHeader(): string {
  return [`${FLOW_COOKIE}=`, `Path=/`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Max-Age=0`].join('; ');
}

export async function readOidcFlowCookie(request: Request, secret: string): Promise<OidcFlowState | null> {
  if (!secret) return null;
  const cookieHeader = request.headers.get('Cookie') || '';
  const re = new RegExp('(?:^|;\\s*)' + FLOW_COOKIE.replace(/[-]/g, '\\$&') + '=([^;]+)');
  const match = cookieHeader.match(re);
  if (!match) return null;
  const value = match[1];
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const payloadB64 = value.slice(0, dot);
  const macB64 = value.slice(dot + 1);
  let expected: Uint8Array, received: Uint8Array;
  try {
    expected = await hmacSha256(secret, payloadB64);
    received = base64urlDecode(macB64);
  } catch { return null; }
  if (!timingSafeEqual(expected, received)) return null;
  let payload: OidcFlowState;
  try { payload = JSON.parse(bytesToUtf8(base64urlDecode(payloadB64))); } catch { return null; }
  if (!payload || typeof payload.iat !== 'number') return null;
  if (payload.iat + FLOW_COOKIE_TTL < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export async function buildAuthorizeUrl(
  { issuer, clientId, redirectUri, scope, state, nonce, codeChallenge }:
  { issuer: string; clientId: string; redirectUri: string; scope?: string; state: string; nonce: string; codeChallenge: string },
): Promise<string> {
  const disc = await fetchDiscovery(issuer);
  const url = new URL(disc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope || 'openid email profile orgs roles');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeCode(
  { issuer, clientId, clientSecret, code, codeVerifier, redirectUri }:
  { issuer: string; clientId: string; clientSecret?: string; code: string; codeVerifier: string; redirectUri: string },
): Promise<OidcTokens> {
  const disc = await fetchDiscovery(issuer);
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (clientSecret) headers['Authorization'] = 'Basic ' + btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(disc.token_endpoint, { method: 'POST', headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OIDC /token ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json() as OidcTokens;
  if (!data.id_token) throw new Error('OIDC /token vastaus ilman id_token');
  return data;
}

/**
 * Exchange a refresh token for a new access token. The provider rotates refresh
 * tokens, so the response may carry a new refresh_token that must replace the
 * stored one.
 */
export async function refreshTokens(
  { issuer, clientId, clientSecret, refreshToken }:
  { issuer: string; clientId: string; clientSecret?: string; refreshToken: string },
): Promise<OidcTokens> {
  const disc = await fetchDiscovery(issuer);
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (clientSecret) headers['Authorization'] = 'Basic ' + btoa(`${clientId}:${clientSecret}`);
  const res = await fetch(disc.token_endpoint, { method: 'POST', headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OIDC refresh ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json() as OidcTokens;
  if (!data.access_token) throw new Error('refresh-vastaus ilman access_token');
  return data;
}

/**
 * Fetch the user's current claims (sub, orgs, roles, email…) from the userinfo
 * endpoint with an access token. This reflects live org membership from the
 * provider, used by silent refresh rather than a stale ID token.
 */
export async function fetchUserinfo(issuer: string, accessToken: string): Promise<OidcClaims> {
  const disc = await fetchDiscovery(issuer);
  if (!disc.userinfo_endpoint) throw new Error('discovery ilman userinfo_endpoint');
  const res = await fetch(disc.userinfo_endpoint, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OIDC userinfo ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<OidcClaims>;
}

export async function verifyIdToken(
  { idToken, issuer, clientId, expectedNonce }:
  { idToken: string; issuer: string; clientId: string; expectedNonce?: string },
): Promise<OidcClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('id_token: ei JWS Compact -muotoa');
  const [headerB64, payloadB64, sigB64] = parts;
  let header: { alg?: string; kid?: string }, payload: OidcClaims;
  try {
    header = JSON.parse(bytesToUtf8(base64urlDecode(headerB64)));
    payload = JSON.parse(bytesToUtf8(base64urlDecode(payloadB64)));
  } catch { throw new Error('id_token: header/payload ei JSON'); }
  if (header.alg !== 'ES256') throw new Error(`id_token: vain ES256 sallittu, sai ${header.alg}`);
  const disc = await fetchDiscovery(issuer);
  const jwks = await fetchJwks(disc.jwks_uri);
  const keys = jwks.keys || [];
  const jwk = keys.find((k) => k.kid === header.kid) || keys.find((k) => k.use === 'sig' && k.kty === 'EC');
  if (!jwk) throw new Error('id_token: vastaavaa avainta ei löytynyt JWKSistä');
  const sig = base64urlDecode(sigB64);
  if (sig.length !== 64) throw new Error('id_token: ES256-allekirjoituksen pitää olla 64 tavua');
  const ok = await verifyEs256(jwk, `${headerB64}.${payloadB64}`, sig);
  if (!ok) throw new Error('id_token: allekirjoitus virheellinen');
  const now = Math.floor(Date.now() / 1000);
  const expectedIss = trimSlash(issuer);
  if (trimSlash(payload.iss || '') !== expectedIss) throw new Error(`id_token: iss virheellinen (${payload.iss})`);
  const audOk = Array.isArray(payload.aud) ? payload.aud.includes(clientId) : payload.aud === clientId;
  if (!audOk) throw new Error('id_token: aud ei vastaa client_id:tä');
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SECS < now) throw new Error('id_token: vanhentunut');
  if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_SECS > now) throw new Error('id_token: iat tulevaisuudessa');
  if (expectedNonce && payload.nonce !== expectedNonce) throw new Error('id_token: nonce ei täsmää');
  return payload;
}

export async function buildEndSessionUrl(
  { issuer, idTokenHint, postLogoutRedirectUri }:
  { issuer: string; idTokenHint?: string; postLogoutRedirectUri?: string },
): Promise<string | null> {
  const disc = await fetchDiscovery(issuer);
  const endpoint = disc.end_session_endpoint;
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
  if (postLogoutRedirectUri) url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri);
  return url.toString();
}

function trimSlash(s: string): string { return String(s || '').replace(/\/+$/, ''); }
