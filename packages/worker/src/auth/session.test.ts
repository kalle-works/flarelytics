import { describe, it, expect } from 'vitest';
import {
  createSessionCookie, readSession, clearSessionCookieHeader,
  buildOrgList, personalOrg, SESSION_COOKIE_NAME,
} from './session';

const SECRET = 'test-session-secret-at-least-32-chars-long';

function reqWithCookie(header: string): Request {
  // Extract just the `name=value` pair from a Set-Cookie header.
  const pair = header.split(';')[0];
  return new Request('https://api.flarelytics.dev/api/auth/me', { headers: { Cookie: pair } });
}

describe('buildOrgList / personalOrg', () => {
  it('always puts the personal workspace first', () => {
    const list = buildOrgList('user-123', [{ id: 'org-a', name: 'Acme', role: 'admin' }]);
    expect(list[0]).toEqual({ id: 'user-123', name: 'Henkilökohtainen', role: 'owner' });
    expect(list[1]).toEqual({ id: 'org-a', name: 'Acme', role: 'admin' });
  });

  it('de-dupes the personal org id and defaults role to member', () => {
    const list = buildOrgList('user-123', [
      { id: 'user-123', name: 'dupe' },
      { id: 'org-b' },
    ]);
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual({ id: 'org-b', name: '', role: 'member' });
  });

  it('returns empty when sub is null and no orgs', () => {
    expect(buildOrgList(null, [])).toEqual([]);
  });

  it('personalOrg uses sub as id with owner role', () => {
    expect(personalOrg('s')).toEqual({ id: 's', name: 'Henkilökohtainen', role: 'owner' });
  });
});

describe('createSessionCookie cookie attributes', () => {
  it('uses __Secure- prefix, HttpOnly, Secure always', async () => {
    const { cookieHeader } = await createSessionCookie({ email: 'a@b.c', sub: 'u1', secret: SECRET });
    expect(cookieHeader).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('Secure');
    expect(cookieHeader).toContain('Path=/');
  });

  it('with COOKIE_DOMAIN → Domain + SameSite=Lax (first-party same-site)', async () => {
    const { cookieHeader } = await createSessionCookie({ email: 'a@b.c', sub: 'u1', secret: SECRET, cookieDomain: 'flarelytics.dev' });
    expect(cookieHeader).toContain('Domain=flarelytics.dev');
    expect(cookieHeader).toContain('SameSite=Lax');
    expect(cookieHeader).not.toContain('SameSite=None');
  });

  it('without COOKIE_DOMAIN → SameSite=None (degraded cross-site), no Domain', async () => {
    const { cookieHeader } = await createSessionCookie({ email: 'a@b.c', sub: 'u1', secret: SECRET });
    expect(cookieHeader).toContain('SameSite=None');
    expect(cookieHeader).not.toContain('Domain=');
  });
});

describe('readSession round-trip + integrity', () => {
  it('reads back a valid signed session', async () => {
    const { cookieHeader } = await createSessionCookie({
      email: 'a@b.c', name: 'Aa', sub: 'u1',
      orgs: buildOrgList('u1', [{ id: 'org-a', name: 'Acme', role: 'admin' }]),
      active_org: 'org-a', secret: SECRET,
    });
    const session = await readSession(reqWithCookie(cookieHeader), SECRET);
    expect(session).not.toBeNull();
    expect(session!.email).toBe('a@b.c');
    expect(session!.active_org).toBe('org-a');
    expect(session!.orgs).toHaveLength(2);
  });

  it('rejects a tampered payload', async () => {
    const { cookieHeader } = await createSessionCookie({ email: 'a@b.c', sub: 'u1', secret: SECRET });
    const pair = cookieHeader.split(';')[0];
    // Flip a character in the payload (before the dot).
    const eq = pair.indexOf('=');
    const value = pair.slice(eq + 1);
    const dot = value.lastIndexOf('.');
    const tampered = value.slice(0, 5) + (value[5] === 'A' ? 'B' : 'A') + value.slice(6, dot) + value.slice(dot);
    const req = new Request('https://x/', { headers: { Cookie: `${SESSION_COOKIE_NAME}=${tampered}` } });
    expect(await readSession(req, SECRET)).toBeNull();
  });

  it('rejects a session signed with a different secret', async () => {
    const { cookieHeader } = await createSessionCookie({ email: 'a@b.c', sub: 'u1', secret: SECRET });
    expect(await readSession(reqWithCookie(cookieHeader), 'wrong-secret')).toBeNull();
  });

  it('rejects an expired session', async () => {
    const { cookieHeader } = await createSessionCookie({ email: 'a@b.c', sub: 'u1', secret: SECRET, exp: 1 });
    expect(await readSession(reqWithCookie(cookieHeader), SECRET)).toBeNull();
  });

  it('returns null when no cookie present', async () => {
    const req = new Request('https://x/');
    expect(await readSession(req, SECRET)).toBeNull();
  });

  it('returns null when secret is empty', async () => {
    const { cookieHeader } = await createSessionCookie({ email: 'a@b.c', sub: 'u1', secret: SECRET });
    expect(await readSession(reqWithCookie(cookieHeader), '')).toBeNull();
  });
});

describe('clearSessionCookieHeader', () => {
  it('expires the cookie (Max-Age=0)', () => {
    expect(clearSessionCookieHeader('flarelytics.dev')).toContain('Max-Age=0');
    expect(clearSessionCookieHeader('flarelytics.dev')).toContain('Domain=flarelytics.dev');
  });
});
