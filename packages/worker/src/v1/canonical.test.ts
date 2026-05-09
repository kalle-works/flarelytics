import { describe, it, expect } from 'vitest';
import {
  CANONICAL_HASH_HEX_LEN,
  normalizeCanonicalUrl,
  canonicalUrlHash,
  referrerUrlHash,
} from './canonical';

describe('normalizeCanonicalUrl', () => {
  it('lowercases the hostname', () => {
    expect(normalizeCanonicalUrl('https://Kiiru.FI/a/foo')).toBe('https://kiiru.fi/a/foo');
  });

  it('strips default port :443 for https', () => {
    expect(normalizeCanonicalUrl('https://kiiru.fi:443/a/foo')).toBe('https://kiiru.fi/a/foo');
  });

  it('strips default port :80 for http', () => {
    expect(normalizeCanonicalUrl('http://kiiru.fi:80/a/foo')).toBe('http://kiiru.fi/a/foo');
  });

  it('keeps non-default ports', () => {
    expect(normalizeCanonicalUrl('https://kiiru.fi:8443/a/foo')).toBe('https://kiiru.fi:8443/a/foo');
  });

  it('strips the fragment', () => {
    expect(normalizeCanonicalUrl('https://kiiru.fi/a/foo#section-2')).toBe('https://kiiru.fi/a/foo');
  });

  it('strips trailing slash on non-root paths', () => {
    expect(normalizeCanonicalUrl('https://kiiru.fi/a/foo/')).toBe('https://kiiru.fi/a/foo');
  });

  it('keeps the root slash', () => {
    expect(normalizeCanonicalUrl('https://kiiru.fi/')).toBe('https://kiiru.fi/');
  });

  it('strips userinfo', () => {
    expect(normalizeCanonicalUrl('https://user:pass@kiiru.fi/a/foo')).toBe('https://kiiru.fi/a/foo');
  });

  it('returns null for non-http(s) schemes', () => {
    expect(normalizeCanonicalUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeCanonicalUrl('ftp://kiiru.fi/foo')).toBeNull();
    expect(normalizeCanonicalUrl('data:text/plain,hi')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(normalizeCanonicalUrl('')).toBeNull();
    expect(normalizeCanonicalUrl('not a url at all')).toBeNull();
  });

  it('preserves query string', () => {
    expect(normalizeCanonicalUrl('https://kiiru.fi/a/foo?x=1&y=2')).toBe('https://kiiru.fi/a/foo?x=1&y=2');
  });
});

describe('canonicalUrlHash', () => {
  it('produces a 12-char hex string', async () => {
    const h = await canonicalUrlHash('https://kiiru.fi/a/foo');
    expect(h).toHaveLength(CANONICAL_HASH_HEX_LEN);
    expect(/^[0-9a-f]{12}$/.test(h)).toBe(true);
  });

  it('is deterministic — same input → same hash', async () => {
    const a = await canonicalUrlHash('https://kiiru.fi/a/foo');
    const b = await canonicalUrlHash('https://kiiru.fi/a/foo');
    expect(a).toBe(b);
  });

  it('different inputs produce different hashes', async () => {
    const a = await canonicalUrlHash('https://kiiru.fi/a/foo');
    const b = await canonicalUrlHash('https://kiiru.fi/a/bar');
    expect(a).not.toBe(b);
  });

  it('case difference in unnormalized input produces different hash (caller must normalize)', async () => {
    const a = await canonicalUrlHash('https://kiiru.fi/a/foo');
    const b = await canonicalUrlHash('https://Kiiru.FI/a/foo');
    expect(a).not.toBe(b);
  });

  it('normalize then hash makes case-/port-/fragment-/slash-variants collapse to one hash', async () => {
    const inputs = [
      'https://kiiru.fi/a/foo',
      'https://Kiiru.FI/a/foo',
      'https://kiiru.fi:443/a/foo',
      'https://kiiru.fi/a/foo#section',
      'https://kiiru.fi/a/foo/',
      'https://user:pw@kiiru.fi/a/foo',
    ];
    const hashes = await Promise.all(
      inputs.map(async (raw) => canonicalUrlHash(normalizeCanonicalUrl(raw)!)),
    );
    const unique = new Set(hashes);
    expect(unique.size).toBe(1);
  });
});

describe('referrerUrlHash', () => {
  it('returns empty string for empty input', async () => {
    expect(await referrerUrlHash('')).toBe('');
  });

  it('returns 12-char hex for non-empty input', async () => {
    const h = await referrerUrlHash('https://bsky.app/profile/x/post/y');
    expect(h).toHaveLength(CANONICAL_HASH_HEX_LEN);
    expect(/^[0-9a-f]{12}$/.test(h)).toBe(true);
  });

  it('matches canonicalUrlHash for the same string (same hash function)', async () => {
    const a = await referrerUrlHash('https://bsky.app/profile/x/post/y');
    const b = await canonicalUrlHash('https://bsky.app/profile/x/post/y');
    expect(a).toBe(b);
  });
});
