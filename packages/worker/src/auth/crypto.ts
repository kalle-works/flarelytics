/**
 * Web-crypto helpers for the auth layer — HMAC-SHA256 session signing,
 * base64url, timing-safe comparison, and ES256 JWS verification for OIDC
 * ID tokens. Pure Web Crypto (no Node APIs) so it runs unchanged on Workers.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8ToBytes(s: string): Uint8Array {
  return enc.encode(s);
}

export function bytesToUtf8(b: Uint8Array): string {
  return dec.decode(b);
}

export function base64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(data: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? utf8ToBytes(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function hmacSha256(key: string | Uint8Array, data: string | Uint8Array): Promise<Uint8Array> {
  const keyBytes = typeof key === 'string' ? utf8ToBytes(key) : key;
  const dataBytes = typeof data === 'string' ? utf8ToBytes(data) : data;
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, dataBytes));
}

export function timingSafeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const aa = a instanceof Uint8Array ? a : utf8ToBytes(String(a));
  const bb = b instanceof Uint8Array ? b : utf8ToBytes(String(b));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

interface EcJwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export async function verifyEs256(jwk: EcJwk, signingInput: string | Uint8Array, signature: Uint8Array): Promise<boolean> {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false;
  const key = await crypto.subtle.importKey(
    'jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  );
  const dataBytes = typeof signingInput === 'string' ? utf8ToBytes(signingInput) : signingInput;
  return crypto.subtle.verify({ name: 'ECDSA', hash: { name: 'SHA-256' } }, key, signature, dataBytes);
}

export async function sha256Base64Url(s: string): Promise<string> {
  return base64urlEncode(await sha256(s));
}
