import { describe, it, expect } from 'vitest';
import { listSites, addSite, removeSite } from './sites-store';

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

describe('sites-store', () => {
  it('lists empty when nothing configured', async () => {
    const { kv } = mockKV();
    expect(await listSites(kv, 'org-1')).toEqual([]);
  });

  it('adds a site (idempotent) and unions the origin into allowed_origins', async () => {
    const { kv, store } = mockKV();
    await addSite(kv, 'org-1', 'example.com', 'Example');
    await addSite(kv, 'org-1', 'example.com', 'Example'); // dupe → no-op
    const sites = await listSites(kv, 'org-1');
    expect(sites).toEqual([{ hostname: 'example.com', label: 'Example' }]);
    expect(JSON.parse(store.get('allowed_origins')!)).toContain('https://example.com');
  });

  it('scopes sites per org', async () => {
    const { kv } = mockKV();
    await addSite(kv, 'org-1', 'a.com');
    await addSite(kv, 'org-2', 'b.com');
    expect(await listSites(kv, 'org-1')).toEqual([{ hostname: 'a.com', label: 'a.com' }]);
    expect(await listSites(kv, 'org-2')).toEqual([{ hostname: 'b.com', label: 'b.com' }]);
  });

  it('removes a site without touching the global origins list', async () => {
    const { kv, store } = mockKV();
    await addSite(kv, 'org-1', 'a.com');
    await addSite(kv, 'org-1', 'b.com');
    const after = await removeSite(kv, 'org-1', 'a.com');
    expect(after).toEqual([{ hostname: 'b.com', label: 'b.com' }]);
    // a.com origin remains in the global allowlist (other orgs may share it).
    expect(JSON.parse(store.get('allowed_origins')!)).toContain('https://a.com');
  });

  it('tolerates corrupt KV JSON', async () => {
    const { kv, store } = mockKV();
    store.set('org:org-1:sites', '{not json');
    expect(await listSites(kv, 'org-1')).toEqual([]);
  });
});
