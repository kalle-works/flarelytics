import { describe, it, expect } from 'vitest';
import { visitorHash } from './track';

describe('visitorHash', () => {
  it('scopes the hash per-site: same ip/ua/date on two different sites produces different hashes', async () => {
    const env = { VISITOR_SALT: undefined, QUERY_API_KEY: 'shared-key' };
    const a = await visitorHash(env, '1.2.3.4', 'Mozilla/5.0', 'site-a.com');
    const b = await visitorHash(env, '1.2.3.4', 'Mozilla/5.0', 'site-b.com');
    expect(a).not.toBe(b);
  });

  it('changes when the salt changes (VISITOR_SALT overrides QUERY_API_KEY)', async () => {
    const withoutSalt = await visitorHash({ VISITOR_SALT: undefined, QUERY_API_KEY: 'key-1' }, '1.2.3.4', 'Mozilla/5.0', 'site-a.com');
    const withSalt = await visitorHash({ VISITOR_SALT: 'dedicated-salt', QUERY_API_KEY: 'key-1' }, '1.2.3.4', 'Mozilla/5.0', 'site-a.com');
    expect(withoutSalt).not.toBe(withSalt);
  });

  it('falls back to QUERY_API_KEY when VISITOR_SALT is unset (same hash as an explicit salt equal to the key)', async () => {
    const fallback = await visitorHash({ VISITOR_SALT: undefined, QUERY_API_KEY: 'key-1' }, '1.2.3.4', 'Mozilla/5.0', 'site-a.com');
    const explicit = await visitorHash({ VISITOR_SALT: 'key-1', QUERY_API_KEY: 'key-1' }, '1.2.3.4', 'Mozilla/5.0', 'site-a.com');
    expect(fallback).toBe(explicit);
  });
});
