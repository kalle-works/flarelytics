import { describe, expect, it, vi, afterEach } from 'vitest';
import { generateReport, queryAnalytics, siteHost, previousWeekWindow, sumInWeek, type Env } from './index';

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
// 4. The previous-week baseline is the 7 calendar days immediately before
//    the current week, found by date — not by array position, because
//    Analytics Engine omits zero-traffic days entirely and a positional
//    slice silently drifts onto the wrong days when that happens.
// 5. Visitor-controlled strings (page path, referrer, user agent) are
//    HTML-escaped in the email body; the plain-text alternative carries the
//    raw values, since it isn't rendered as markup.
// 6. A traffic swing only becomes an "Alert" once the previous week's
//    baseline is large enough that the swing isn't just noise.

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

// ---------------------------------------------------------------------------
// Test helpers shared by the sections below.

function daysAgoISO(now: Date, n: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive range of ISO date strings, `fromAgo` and `toAgo` counted in days before `now`. */
function datesRange(now: Date, fromAgo: number, toAgo: number): string[] {
  const out: string[] = [];
  for (let n = fromAgo; n <= toAgo; n++) out.push(daysAgoISO(now, n));
  return out;
}

// ---------------------------------------------------------------------------

describe('previous-week baseline (F1)', () => {
  it('windows the previous 7 calendar days by date, not by array position', () => {
    const now = new Date('2026-09-05T08:00:00Z');
    const { start, end } = previousWeekWindow(now);

    // today = 2026-09-05 (0 days ago); previous week = 7-13 days ago.
    expect(start).toBe('2026-08-23');
    expect(end).toBe('2026-08-29');

    const rows = [
      // The week before the previous one — what the old `.slice(-21, -14)`
      // bug would actually have summed. Must be excluded.
      ...datesRange(now, 14, 20).map((date) => ({ date, views: 999 })),
      // The real previous week: 7 days at 20 views = 140.
      ...datesRange(now, 7, 13).map((date) => ({ date, views: 20 })),
      // The current week — not part of this window either.
      ...datesRange(now, 0, 6).map((date) => ({ date, views: 10 })),
    ];

    expect(sumInWeek(rows, 'views', start, end)).toBe(140);
  });

  it('is unaffected by a day missing from the array (Analytics Engine omits empty days)', () => {
    const now = new Date('2026-09-05T08:00:00Z');
    const { start, end } = previousWeekWindow(now);

    const rows = datesRange(now, 7, 13)
      .filter((date) => date !== '2026-08-26') // one quiet day, entirely absent
      .map((date) => ({ date, views: 20 }));

    expect(rows).toHaveLength(6);
    expect(sumInWeek(rows, 'views', start, end)).toBe(120);
  });

  it("wires the date-based window into generateReport's week-over-week percentage", async () => {
    const now = new Date('2026-09-05T08:00:00Z');
    const dailyViews30d = [
      ...datesRange(now, 14, 29).map((date) => ({ date, views: 999 })),
      ...datesRange(now, 7, 13).map((date) => ({ date, views: 20 })), // sums to 140
      ...datesRange(now, 0, 6).map((date) => ({ date, views: 10 })),
    ];

    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('q=daily-views') && u.includes('period=30d')) {
        return { ok: true, status: 200, json: async () => ({ data: dailyViews30d }), text: async () => '' } as unknown as Response;
      }
      if (u.includes('q=daily-views') && u.includes('period=7d')) {
        // Current week total equals the correct previous-week total (140),
        // so the correct comparison reads 0.0%. The buggy code would have
        // compared 140 against 999*7=6993 and shown a large negative swing.
        return { ok: true, status: 200, json: async () => ({ data: [{ views: 140 }] }), text: async () => '' } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '' } as unknown as Response;
    });

    const { html } = await generateReport(env(), now);

    expect(html).toContain('0.0%');
  });
});

describe('HTML escaping and plain-text alternative (F2)', () => {
  const evil = '"><img src=x onerror=alert(1)>';

  it('escapes a visitor-controlled page path in the html but not the text part', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('q=top-pages')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ path: evil, views: 3 }] }), text: async () => '' } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '' } as unknown as Response;
    });

    const { html, text } = await generateReport(env());

    expect(html).not.toContain(evil);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(text).toContain(evil);
  });
});

describe('anomaly minimum sample size', () => {
  function fixtureWithPrevWeekTotal(now: Date, prevTotal: number, currentTotal: number) {
    const perDay = Math.floor(prevTotal / 7);
    const remainder = prevTotal - perDay * 7;
    const prevWeekDates = datesRange(now, 7, 13);
    const dailyViews30d = prevWeekDates.map((date, i) => ({
      date,
      views: perDay + (i === 0 ? remainder : 0),
    }));
    return vi.stubGlobal('fetch', async (url: string) => {
      const u = String(url);
      if (u.includes('q=daily-views') && u.includes('period=30d')) {
        return { ok: true, status: 200, json: async () => ({ data: dailyViews30d }), text: async () => '' } as unknown as Response;
      }
      if (u.includes('q=daily-views') && u.includes('period=7d')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ views: currentTotal }] }), text: async () => '' } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '' } as unknown as Response;
    });
  }

  it('does not alert on a huge percentage swing from a tiny baseline (1 -> 2 views)', async () => {
    const now = new Date('2026-09-05T08:00:00Z');
    fixtureWithPrevWeekTotal(now, 1, 2); // +100%, but previous week total is far below the minimum sample

    const { html } = await generateReport(env(), now);

    expect(html).not.toContain('Alert');
    expect(html).not.toContain('Traffic spike');
  });

  it('alerts on the same +30%+ swing once the baseline clears the minimum sample size', async () => {
    const now = new Date('2026-09-05T08:00:00Z');
    fixtureWithPrevWeekTotal(now, 100, 140); // +40%, previous week total is 100 (>= minimum)

    const { html } = await generateReport(env(), now);

    expect(html).toContain('Traffic spike');
  });

  it('alerts on a matching drop once the baseline clears the minimum sample size', async () => {
    const now = new Date('2026-09-05T08:00:00Z');
    fixtureWithPrevWeekTotal(now, 100, 50); // -50%, previous week total is 100 (>= minimum)

    const { html } = await generateReport(env(), now);

    expect(html).toContain('Traffic drop');
  });
});
