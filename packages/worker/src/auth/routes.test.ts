import { describe, it, expect } from 'vitest';
import { safeReturnTo, dashboardOrigins, authCorsHeaders, handleMe, handleSwitchOrg, handleLogin } from './routes';
import type { AuthEnv } from './routes';
import { createSessionCookie, buildOrgList } from './session';

const SECRET = 'test-session-secret-at-least-32-chars-long';

function mockKV() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
    delete: async (k: string) => { store.delete(k); },
  } as unknown as KVNamespace;
}

function makeEnv(over: Partial<AuthEnv> = {}): AuthEnv {
  return {
    SITE_CONFIG: mockKV(),
    OIDC_ISSUER: 'https://id.palvelureppu.fi',
    OIDC_CLIENT_ID: 'flarelytics',
    SESSION_SECRET: SECRET,
    DASHBOARD_URL: 'https://app.flarelytics.dev',
    COOKIE_DOMAIN: 'flarelytics.dev',
    ADMIN_EMAILS: 'kalle@kalle.works',
    ...over,
  };
}

async function signedCookiePair(env: AuthEnv, opts: Parameters<typeof createSessionCookie>[0]) {
  const { cookieHeader } = await createSessionCookie(opts);
  return cookieHeader.split(';')[0];
}

describe('safeReturnTo', () => {
  it('allows same-origin relative paths', () => {
    expect(safeReturnTo('/dashboard')).toBe('/dashboard');
    expect(safeReturnTo('/?site=a.com')).toBe('/?site=a.com');
  });
  it('rejects absolute, protocol-relative, backslash and control chars', () => {
    expect(safeReturnTo('https://evil.com')).toBe('/');
    expect(safeReturnTo('//evil.com')).toBe('/');
    expect(safeReturnTo('/\\evil')).toBe('/');
    expect(safeReturnTo('/a\x00b')).toBe('/');
    expect(safeReturnTo(null)).toBe('/');
  });
});

describe('dashboardOrigins / authCorsHeaders', () => {
  it('includes the configured dashboard origin and excludes localhost in production', () => {
    const origins = dashboardOrigins(makeEnv());
    expect(origins).toContain('https://app.flarelytics.dev');
    expect(origins).not.toContain('http://localhost:4321');
  });

  it('includes localhost only when no production dashboard is configured', () => {
    expect(dashboardOrigins(makeEnv({ DASHBOARD_URL: undefined }))).toContain('http://localhost:4321');
  });
  it('echoes an allowed origin with credentials', () => {
    const req = new Request('https://api/x', { headers: { Origin: 'https://app.flarelytics.dev' } });
    const h = authCorsHeaders(req, makeEnv());
    expect(h['Access-Control-Allow-Origin']).toBe('https://app.flarelytics.dev');
    expect(h['Access-Control-Allow-Credentials']).toBe('true');
  });
  it('does not echo a foreign origin', () => {
    const req = new Request('https://api/x', { headers: { Origin: 'https://evil.com' } });
    const h = authCorsHeaders(req, makeEnv());
    expect(h['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('handleLogin', () => {
  it('returns 503 when SSO is not configured', async () => {
    const res = await handleLogin(new Request('https://api/api/auth/login'), makeEnv({ OIDC_ISSUER: undefined }));
    expect(res.status).toBe(503);
  });
});

describe('handleMe', () => {
  it('401 when unauthenticated', async () => {
    const res = await handleMe(new Request('https://api/api/auth/me'), makeEnv());
    expect(res.status).toBe(401);
    expect(((await res.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });

  it('returns orgs, active_org, role and the org site list when authenticated', async () => {
    const env = makeEnv();
    await env.SITE_CONFIG.put('org:org-a:sites', JSON.stringify([{ hostname: 'acme.com', label: 'Acme' }]));
    const cookie = await signedCookiePair(env, {
      email: 'm@b.c', sub: 'u1',
      orgs: buildOrgList('u1', [{ id: 'org-a', name: 'Acme', role: 'admin' }]),
      active_org: 'org-a', secret: SECRET, cookieDomain: 'flarelytics.dev',
    });
    const res = await handleMe(new Request('https://api/api/auth/me', { headers: { Cookie: cookie } }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { authenticated: boolean; active_org: string; role: string; sites: unknown[] };
    expect(body.authenticated).toBe(true);
    expect(body.active_org).toBe('org-a');
    expect(body.role).toBe('admin');
    expect(body.sites).toEqual([{ hostname: 'acme.com', label: 'Acme' }]);
  });
});

describe('handleSwitchOrg', () => {
  const ORIGIN = 'https://app.flarelytics.dev';

  it('rejects without a same-origin header (CSRF)', async () => {
    const env = makeEnv();
    const cookie = await signedCookiePair(env, { email: 'a@b.c', sub: 'u1', secret: SECRET });
    const res = await handleSwitchOrg(new Request('https://api/api/auth/switch-org', {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: 'u1' }),
    }), env);
    expect(res.status).toBe(403);
  });

  it('rejects switching to an org the user is not a member of (IDOR)', async () => {
    const env = makeEnv();
    const cookie = await signedCookiePair(env, {
      email: 'a@b.c', sub: 'u1', orgs: buildOrgList('u1', []), active_org: 'u1', secret: SECRET,
    });
    const res = await handleSwitchOrg(new Request('https://api/api/auth/switch-org', {
      method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: 'org-not-mine' }),
    }), env);
    expect(res.status).toBe(403);
  });

  it('switches to a member org and re-issues the cookie', async () => {
    const env = makeEnv();
    const cookie = await signedCookiePair(env, {
      email: 'a@b.c', sub: 'u1',
      orgs: buildOrgList('u1', [{ id: 'org-a', name: 'Acme', role: 'admin' }]),
      active_org: 'u1', secret: SECRET,
    });
    const res = await handleSwitchOrg(new Request('https://api/api/auth/switch-org', {
      method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: 'org-a' }),
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; active_org: string };
    expect(body.ok).toBe(true);
    expect(body.active_org).toBe('org-a');
    expect(res.headers.get('Set-Cookie')).toContain('__Secure-fl_session=');
  });

  it('401 when unauthenticated even with a same-origin header', async () => {
    const env = makeEnv();
    const res = await handleSwitchOrg(new Request('https://api/api/auth/switch-org', {
      method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ org_id: 'u1' }),
    }), env);
    expect(res.status).toBe(401);
  });
});
