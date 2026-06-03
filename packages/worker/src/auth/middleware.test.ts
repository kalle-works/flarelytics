import { describe, it, expect } from 'vitest';
import {
  activeOrgId, activeRole, canManage, canView, requireOrgRole,
  isAdminEmail, isSameOrigin, assertSiteAccess,
} from './middleware';
import { addSite } from './sites-store';
import type { SessionPayload } from './session';

function session(over: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sid: 's', email: 'a@b.c', name: '', picture: '', sub: 'u1',
    orgs: [
      { id: 'u1', name: 'Henkilökohtainen', role: 'owner' },
      { id: 'org-a', name: 'Acme', role: 'member' },
    ],
    active_org: 'u1', orgs_refreshed_at: 0, iat: 0, exp: 9999999999,
    ...over,
  };
}

function mockKV() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  } as unknown as KVNamespace;
}

describe('org scoping', () => {
  it('activeOrgId falls back to sub', () => {
    expect(activeOrgId(session({ active_org: null }))).toBe('u1');
    expect(activeOrgId(session({ active_org: 'org-a' }))).toBe('org-a');
  });

  it('activeRole reads the active org role', () => {
    expect(activeRole(session({ active_org: 'u1' }))).toBe('owner');
    expect(activeRole(session({ active_org: 'org-a' }))).toBe('member');
  });

  it('canManage only for owner/admin; canView for any member', () => {
    expect(canManage(session({ active_org: 'u1' }))).toBe(true);
    expect(canManage(session({ active_org: 'org-a' }))).toBe(false);
    expect(canView(session({ active_org: 'org-a' }))).toBe(true);
  });

  it('requireOrgRole throws a 403 Response when role insufficient', () => {
    expect(() => requireOrgRole(session({ active_org: 'org-a' }), ['owner', 'admin'])).toThrow();
    try {
      requireOrgRole(session({ active_org: 'org-a' }), ['owner']);
    } catch (e) {
      expect(e).toBeInstanceOf(Response);
      expect((e as Response).status).toBe(403);
    }
  });
});

describe('isAdminEmail', () => {
  it('matches a comma-separated list', () => {
    expect(isAdminEmail('kalle@kalle.works, x@y.z', 'kalle@kalle.works')).toBe(true);
    expect(isAdminEmail('kalle@kalle.works', 'other@x.y')).toBe(false);
    expect(isAdminEmail(undefined, 'a@b.c')).toBe(false);
    expect(isAdminEmail('a@b.c', undefined)).toBe(false);
  });
});

describe('isSameOrigin (CSRF guard)', () => {
  const allowed = ['https://app.flarelytics.dev'];
  it('allows a matching Origin', () => {
    const r = new Request('https://api/x', { headers: { Origin: 'https://app.flarelytics.dev' } });
    expect(isSameOrigin(r, allowed)).toBe(true);
  });
  it('rejects a foreign Origin', () => {
    const r = new Request('https://api/x', { headers: { Origin: 'https://evil.com' } });
    expect(isSameOrigin(r, allowed)).toBe(false);
  });
  it('falls back to Referer when Origin absent', () => {
    const r = new Request('https://api/x', { headers: { Referer: 'https://app.flarelytics.dev/path' } });
    expect(isSameOrigin(r, allowed)).toBe(true);
  });
  it('rejects when neither present', () => {
    expect(isSameOrigin(new Request('https://api/x'), allowed)).toBe(false);
  });
});

describe('assertSiteAccess', () => {
  it('allows a site owned by the active org', async () => {
    const kv = mockKV();
    await addSite(kv, 'org-a', 'acme.com');
    await expect(assertSiteAccess(kv, session({ active_org: 'org-a' }), 'acme.com')).resolves.toBe('org-a');
  });

  it('rejects a foreign site with a 403 Response', async () => {
    const kv = mockKV();
    await addSite(kv, 'org-a', 'acme.com');
    await expect(assertSiteAccess(kv, session({ active_org: 'org-a' }), 'other.com')).rejects.toBeInstanceOf(Response);
  });

  it('admin email bypasses site ownership', async () => {
    const kv = mockKV();
    await expect(
      assertSiteAccess(kv, session({ active_org: 'org-a', email: 'kalle@kalle.works' }), 'anything.com', 'kalle@kalle.works'),
    ).resolves.toBeTruthy();
  });
});
