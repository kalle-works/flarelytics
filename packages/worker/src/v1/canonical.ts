/**
 * Server-side canonical_url normalization and SHA-256 hashing.
 * Mirrors the tracker-side normalization in packages/tracker/src/tracker.ts so
 * tracker-emitted canonical_url and worker-inferred fallback hash to the same
 * value for identical input.
 *
 * Schema cap (per MIGRATION_PLAN.md §3): canonical_url_hash is the first 12 hex
 * chars of SHA-256(canonical_url). 48 bits of entropy — collision-safe at the
 * portfolio's content scale (~120k rows in 12 months, §9 task D).
 */

export const CANONICAL_HASH_HEX_LEN = 12;

/**
 * Normalize a canonical URL using the same rules as the tracker:
 *   - lowercase host
 *   - strip default port (:80 for http, :443 for https)
 *   - strip fragment
 *   - strip trailing slash unless path is the root "/"
 *   - strip userinfo
 *   - http(s) only — returns null for any other scheme or unparseable input
 */
export function normalizeCanonicalUrl(raw: string): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.username = '';
  u.password = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  u.hash = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

async function sha256Hex12(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest).slice(0, CANONICAL_HASH_HEX_LEN / 2);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * SHA-256(canonical)[0:12] in hex. Caller is responsible for normalizing first
 * (call normalizeCanonicalUrl); this function does NOT normalize so callers can
 * hash already-canonical inputs without paying URL parsing twice.
 */
export function canonicalUrlHash(canonical: string): Promise<string> {
  return sha256Hex12(canonical);
}

/**
 * SHA-256(referrer_url)[0:12] in hex. Same hash function as canonical;
 * separate name so call sites read clearly. Empty/non-string input returns ''.
 */
export async function referrerUrlHash(url: string): Promise<string> {
  if (typeof url !== 'string' || url === '') return '';
  return sha256Hex12(url);
}
