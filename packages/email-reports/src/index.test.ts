import { describe, expect, it, vi, afterEach } from 'vitest';
import { generateReport, queryAnalytics, siteHost, type Env } from './index';

// What this report must guarantee, stated before reading the implementation:
//
// 1. Every query is scoped to the site it is reporting on. The analytics
//    worker is multi-tenant and rejects an unscoped query, so an unscoped
//    report has no data at all.
// 2. A failed query is never rendered as a zero. "0 views" is a claim about
//    the site; a broken pipeline is a claim about us, and the two must not
//    look identical to a reader glancing at a subject line.
// 3. A genuinely empty week still reports zero, plainly. Guarding (2) is
//    worthless if it also swallows the real answer.

function env(overrides: Partial<Env> = {}): Env {
  return {
    ANALYTICS_WORKER_URL: 'https://analytics.example.dev',
    ANALYTICS_API_KEY: 'k',
    EMAIL_API_URL: 'https://api.euromail.dev',
    EMAIL_API_KEY: 'k',
    EMAIL_FROM: 'analytics@example.com',
    ADMIN_API_KEY: 'k',
    REPORT_RECIPIENTS: {} as KVNamespace,
    SITE_NAME: 'Example',
    SITE_URL: 'https://example.com',
    ...overrides,
  } as Env;
}

/** Stub fetch with a fixed response and record the URLs it was called with. */
function stubFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.body ?? { data: [] },
      text: async () => JSON.stringify(response.body ?? {}),
    } as unknown as Response;
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('siteHost', () => {
  it('reduces the configured site URL to a plain hostname', () => {
    // The worker validates the param against /^[a-zA-Z0-9.\-]+$/, so a scheme
    // or a path would be rejected outright.
    expect(siteHost(env({ SITE_URL: 'https://mailtoolfinder.com' }))).toBe('mailtoolfinder.com');
    expect(siteHost(env({ SITE_URL: 'https://mailtoolfinder.com/' }))).toBe('mailtoolfinder.com');
    expect(siteHost(env({ SITE_URL: 'mailtoolfinder.com' }))).toBe('mailtoolfinder.com');
  });

  it('returns empty rather than a guess when the URL is unusable', () => {
    expect(siteHost(env({ SITE_URL: '' }))).toBe('');
    expect(siteHost(env({ SITE_URL: '   ' }))).toBe('');
  });
});

describe('queryAnalytics', () => {
  it('scopes the query to the site', async () => {
    // The bug this guards: without `site` the worker answers
    // 400 "Missing required param: site" and the whole report reads zero.
    const calls = stubFetch({ ok: true, body: { data: [{ views: 5 }] } });

    const out = await queryAnalytics(env(), 'daily-views', '7d');

    expect(out.failed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('site=example.com');
    expect(calls[0]).toContain('q=daily-views');
    expect(calls[0]).toContain('period=7d');
  });

  it('reports a failure instead of an empty result set', async () => {
    stubFetch({ ok: false, status: 400, body: { error: 'Missing required param: site' } });

    const out = await queryAnalytics(env(), 'daily-views', '7d');

    expect(out.failed).toBe(true);
    expect(out.rows).toEqual([]);
  });

  it('reports a failure when the site cannot be determined, without calling out', async () => {
    const calls = stubFetch({ ok: true, body: { data: [] } });

    const out = await queryAnalytics(env({ SITE_URL: '' }), 'daily-views', '7d');

    expect(out.failed).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('reports a failure when the request throws', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('timeout');
    });

    const out = await queryAnalytics(env(), 'daily-views', '7d');

    expect(out.failed).toBe(true);
  });
});

describe('generateReport', () => {
  it('refuses to put a number it could not read in the subject', async () => {
    stubFetch({ ok: false, status: 400, body: { error: 'Missing required param: site' } });

    const { subject, html } = await generateReport(env());

    // The subject is the part read at a glance. "0 views" there would be a
    // statement about the site when the truth is that nothing was measured.
    expect(subject).not.toContain('0 views');
    expect(subject).toContain('unavailable');
    expect(html).toContain('could not be read');
    // And the tiles must not display fabricated zeros either.
    expect(html).not.toMatch(/font-weight:700;color:#1a1a1a;">0</);
  });

  it('still reports a genuinely quiet week as zero', async () => {
    // The discrimination that matters: a working query returning nothing is a
    // real answer and must survive the guard above.
    stubFetch({ ok: true, body: { data: [] } });

    const { subject, html } = await generateReport(env());

    expect(subject).toContain('0 views');
    expect(subject).not.toContain('unavailable');
    expect(html).not.toContain('could not be read');
  });

  it('reports the real totals when the data is there', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const rows = String(url).includes('daily-views')
        ? [{ views: 25 }, { views: 58 }]
        : String(url).includes('daily-unique-visitors')
          ? [{ unique_visitors: 18 }, { unique_visitors: 30 }]
          : [];
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: rows }),
        text: async () => '',
      } as unknown as Response;
    });

    const { subject } = await generateReport(env());

    expect(subject).toContain('83 views');
    expect(subject).toContain('48 visitors');
  });
});
