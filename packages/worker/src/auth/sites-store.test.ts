import { describe, it, expect } from 'vitest';
import {
  listSites, siteOwner, claimSite, verifySite, removeSite,
  SiteConflictError, NoClaimError, VerificationError,
  type PendingClaim,
} from './sites-store';

function mockKV() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
      delete: async (k: string) => { store.delete(k); },
    } as unknown as KVNamespace,
  };
}

/** Fake DNS-over-HTTPS that returns a TXT record containing `value`. */
function dohWith(value: string | null): typeof fetch {
  return (async () => new Response(
    JSON.stringify(value ? { Answer: [{ data: `"${value}"` }] } : { Answer: [] }),
    { status: 200 },
  )) as unknown as typeof fetch;
}

describe('claimSite', () => {
  it('returns a pending DNS-TXT claim for an unowned hostname (no access granted yet)', async () => {
    const { kv } = mockKV();
    const result = await claimSite(kv, 'org-1', 'example.com', 'Example') as PendingClaim;
    expect(result.pending).toBe(true);
    expect(result.verification.type).toBe('dns-txt');
    expect(result.verification.name).toBe('_flarelytics.example.com');
    expect(result.verification.value).toMatch(/^flarelytics-site-verification=/);
    // Not added to the org and not owned until verified.
    expect(await listSites(kv, 'org-1')).toEqual([]);
    expect(await siteOwner(kv, 'example.com')).toBeNull();
  });

  it('reuses a stable token across repeated claims', async () => {
    const { kv } = mockKV();
    const a = await claimSite(kv, 'org-1', 'example.com') as PendingClaim;
    const b = await claimSite(kv, 'org-1', 'example.com') as PendingClaim;
    expect(a.verification.value).toBe(b.verification.value);
  });

  it('rejects claiming a hostname owned by another org (IDOR/cross-tenant)', async () => {
    const { kv } = mockKV();
    await kv.put('site_owner:example.com', 'org-2');
    await expect(claimSite(kv, 'org-1', 'example.com')).rejects.toBeInstanceOf(SiteConflictError);
  });

  it('is idempotent when the org already owns the hostname', async () => {
    const { kv } = mockKV();
    await kv.put('site_owner:example.com', 'org-1');
    const result = await claimSite(kv, 'org-1', 'example.com', 'Example');
    expect(result).toEqual([{ hostname: 'example.com', label: 'Example' }]);
  });
});

describe('verifySite', () => {
  it('grants ownership when the DNS TXT record matches', async () => {
    const { kv, store } = mockKV();
    const claim = await claimSite(kv, 'org-1', 'example.com', 'Example') as PendingClaim;
    const token = claim.verification.value;
    const sites = await verifySite(kv, 'org-1', 'example.com', 'Example', dohWith(token));
    expect(sites).toEqual([{ hostname: 'example.com', label: 'Example' }]);
    expect(await siteOwner(kv, 'example.com')).toBe('org-1');
    expect(store.get('site_claim:org-1:example.com')).toBeUndefined(); // claim consumed
    expect(JSON.parse(store.get('allowed_origins')!)).toContain('https://example.com');
  });

  it('fails verification when the TXT record is absent', async () => {
    const { kv } = mockKV();
    await claimSite(kv, 'org-1', 'example.com');
    await expect(verifySite(kv, 'org-1', 'example.com', undefined, dohWith(null))).rejects.toBeInstanceOf(VerificationError);
    expect(await siteOwner(kv, 'example.com')).toBeNull();
  });

  it('fails verification when the TXT token does not match', async () => {
    const { kv } = mockKV();
    await claimSite(kv, 'org-1', 'example.com');
    await expect(verifySite(kv, 'org-1', 'example.com', undefined, dohWith('flarelytics-site-verification=wrong'))).rejects.toBeInstanceOf(VerificationError);
  });

  it('throws NoClaimError when verifying without a pending claim', async () => {
    const { kv } = mockKV();
    await expect(verifySite(kv, 'org-1', 'example.com', undefined, dohWith('x'))).rejects.toBeInstanceOf(NoClaimError);
  });

  it('rejects verification if another org grabbed ownership first', async () => {
    const { kv } = mockKV();
    await claimSite(kv, 'org-1', 'example.com');
    await kv.put('site_owner:example.com', 'org-2');
    await expect(verifySite(kv, 'org-1', 'example.com', undefined, dohWith('x'))).rejects.toBeInstanceOf(SiteConflictError);
  });
});

describe('removeSite', () => {
  it('removes the site and releases global ownership', async () => {
    const { kv, store } = mockKV();
    const claim = await claimSite(kv, 'org-1', 'a.com') as PendingClaim;
    await verifySite(kv, 'org-1', 'a.com', undefined, dohWith(claim.verification.value));
    const after = await removeSite(kv, 'org-1', 'a.com');
    expect(after).toEqual([]);
    expect(await siteOwner(kv, 'a.com')).toBeNull(); // released for re-claim
    // Global /track origin remains (other tooling may rely on it).
    expect(JSON.parse(store.get('allowed_origins')!)).toContain('https://a.com');
  });

  it('does not release ownership held by a different org', async () => {
    const { kv } = mockKV();
    await kv.put('site_owner:a.com', 'org-2');
    await removeSite(kv, 'org-1', 'a.com');
    expect(await siteOwner(kv, 'a.com')).toBe('org-2');
  });
});

describe('listSites', () => {
  it('returns empty when nothing configured', async () => {
    const { kv } = mockKV();
    expect(await listSites(kv, 'org-1')).toEqual([]);
  });

  it('tolerates corrupt KV JSON', async () => {
    const { kv, store } = mockKV();
    store.set('org:org-1:sites', '{not json');
    expect(await listSites(kv, 'org-1')).toEqual([]);
  });
});
