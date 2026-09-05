import { describe, expect, it, vi, afterEach } from 'vitest';
import worker, {
  generateReport,
  queryAnalytics,
  siteHost,
  previousWeekWindow,
  sumInWeek,
  type Env,
} from './index';

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
// 7. A cron retry for a period that has already been sent sends nothing.
// 8. The admin API key check accepts the right key and rejects any other,
//    and a failed send is logged without the recipient's address.
// 9. `POST /recipients` rejects anything that isn't a plausible email, and
//    the recipient list survives more than one page of KV keys.

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

// ---------------------------------------------------------------------------
// Test helpers for the delivery/admin surface below.

/** In-memory KVNamespace stand-in supporting get/put/delete/list. */
function createFakeKV(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    put: async (key: string, value: string) => {
      store.set(key, String(value));
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async () => ({
      keys: Array.from(store.keys()).map((name) => ({ name })),
      list_complete: true,
      cacheStatus: null,
    }),
  } as unknown as KVNamespace;
}

/** Every fetch (analytics query or email API) succeeds with empty data. */
function stubAllOk() {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
      text: async () => '',
    } as unknown as Response;
  });
  return calls;
}

function fakeScheduledEvent(scheduledTime: number): ScheduledEvent {
  return { scheduledTime, cron: '0 8 * * 1', noRetry: vi.fn(), waitUntil: () => {} } as unknown as ScheduledEvent;
}

const fakeCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

async function json(res: Response): Promise<any> {
  return res.json();
}

// ---------------------------------------------------------------------------

describe('scheduled() idempotency', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends once per ISO week and skips a retry for the same period', async () => {
    const kv = createFakeKV({ 'a@example.com': 'x' });
    const e = env({ REPORT_RECIPIENTS: kv });
    const emailCalls = stubAllOk();
    const scheduledEvent = fakeScheduledEvent(Date.parse('2026-09-07T08:00:00Z'));

    await worker.scheduled(scheduledEvent, e, fakeCtx);
    const sendsAfterFirst = emailCalls.filter((u) => u.includes('/v1/emails')).length;
    expect(sendsAfterFirst).toBe(1);

    await worker.scheduled(scheduledEvent, e, fakeCtx);
    const sendsAfterSecond = emailCalls.filter((u) => u.includes('/v1/emails')).length;
    expect(sendsAfterSecond).toBe(1); // the second run must send nothing
  });

  it('opts out of the platform retry once a send has gone out and something afterward throws', async () => {
    const kv = createFakeKV({ 'a@example.com': 'x' });
    const originalPut = kv.put.bind(kv);
    kv.put = (async (key: string, value: string) => {
      if (String(key).startsWith('sent:weekly:')) throw new Error('kv outage while marking sent');
      return originalPut(key, value);
    }) as typeof kv.put;
    const e = env({ REPORT_RECIPIENTS: kv });
    stubAllOk();
    const noRetry = vi.fn();
    const scheduledEvent = { ...fakeScheduledEvent(Date.now()), noRetry } as unknown as ScheduledEvent;

    await expect(worker.scheduled(scheduledEvent, e, fakeCtx)).rejects.toThrow('kv outage');
    expect(noRetry).toHaveBeenCalledTimes(1);
  });
});

describe('admin auth and recipient handling', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('GET /health needs no auth', async () => {
    const res = await worker.fetch(new Request('https://x.example/health'), env());
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe('ok');
  });

  it('rejects every other route without the admin key', async () => {
    const res = await worker.fetch(new Request('https://x.example/recipients'), env({ ADMIN_API_KEY: 'k' }));
    expect(res.status).toBe(401);
  });

  it('rejects a same-length wrong key and a different-length wrong key alike', async () => {
    const e = env({ ADMIN_API_KEY: 'correct-key' }); // 11 chars
    const sameLen = await worker.fetch(
      new Request('https://x.example/recipients', { headers: { 'X-API-Key': 'wrong-key11' } }), // also 11 chars
      e,
    );
    const shorter = await worker.fetch(
      new Request('https://x.example/recipients', { headers: { 'X-API-Key': 'x' } }),
      e,
    );
    expect(sameLen.status).toBe(401);
    expect(shorter.status).toBe(401);
  });

  it('accepts the correct admin key', async () => {
    const kv = createFakeKV();
    const res = await worker.fetch(
      new Request('https://x.example/recipients', { headers: { 'X-API-Key': 'k' } }),
      env({ ADMIN_API_KEY: 'k', REPORT_RECIPIENTS: kv }),
    );
    expect(res.status).toBe(200);
  });

  it('adds, lists, and removes a recipient', async () => {
    const kv = createFakeKV();
    const e = env({ ADMIN_API_KEY: 'k', REPORT_RECIPIENTS: kv });
    const headers = { 'X-API-Key': 'k', 'Content-Type': 'application/json' };

    const add = await worker.fetch(
      new Request('https://x.example/recipients', { method: 'POST', headers, body: JSON.stringify({ email: 'person@example.com' }) }),
      e,
    );
    expect(add.status).toBe(200);

    const list = await worker.fetch(new Request('https://x.example/recipients', { headers }), e);
    expect((await json(list)).recipients).toEqual(['person@example.com']);

    const del = await worker.fetch(
      new Request('https://x.example/recipients', { method: 'DELETE', headers, body: JSON.stringify({ email: 'person@example.com' }) }),
      e,
    );
    expect(del.status).toBe(200);

    const listAfter = await worker.fetch(new Request('https://x.example/recipients', { headers }), e);
    expect((await json(listAfter)).recipients).toEqual([]);
  });

  it.each(['not-an-email', '@example.com', 'person@', 'person@example', ''])(
    'rejects %j as a recipient',
    async (bad) => {
      const e = env({ ADMIN_API_KEY: 'k', REPORT_RECIPIENTS: createFakeKV() });
      const res = await worker.fetch(
        new Request('https://x.example/recipients', {
          method: 'POST',
          headers: { 'X-API-Key': 'k', 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: bad }),
        }),
        e,
      );
      expect(res.status).toBe(400);
    },
  );

  it('paginates past a single KV list() page', async () => {
    const pages = [
      { keys: [{ name: 'user0@example.com' }], list_complete: false, cursor: 'c1', cacheStatus: null },
      { keys: [{ name: 'user1@example.com' }], list_complete: false, cursor: 'c2', cacheStatus: null },
      { keys: [{ name: 'user2@example.com' }], list_complete: true, cacheStatus: null },
    ];
    let call = 0;
    const kv = { list: vi.fn(async () => pages[call++]) } as unknown as KVNamespace;
    const e = env({ ADMIN_API_KEY: 'k', REPORT_RECIPIENTS: kv });

    const res = await worker.fetch(new Request('https://x.example/recipients', { headers: { 'X-API-Key': 'k' } }), e);

    expect((await json(res)).recipients).toEqual(['user0@example.com', 'user1@example.com', 'user2@example.com']);
    expect(kv.list).toHaveBeenCalledTimes(3);
  });

  it('does not surface the idempotency marker key as a recipient', async () => {
    const kv = createFakeKV({ 'a@example.com': 'x', 'sent:weekly:2026-W36': new Date().toISOString() });
    const e = env({ ADMIN_API_KEY: 'k', REPORT_RECIPIENTS: kv });

    const res = await worker.fetch(new Request('https://x.example/recipients', { headers: { 'X-API-Key': 'k' } }), e);

    expect((await json(res)).recipients).toEqual(['a@example.com']);
  });

  it('sends a test report to an explicit address', async () => {
    stubAllOk();
    const res = await worker.fetch(
      new Request('https://x.example/test', {
        method: 'POST',
        headers: { 'X-API-Key': 'k', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'someone@example.com' }),
      }),
      env({ ADMIN_API_KEY: 'k' }),
    );
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(body.sentTo).toBe('someone@example.com');
  });

  it('404s on an unknown route', async () => {
    const res = await worker.fetch(new Request('https://x.example/nope', { headers: { 'X-API-Key': 'k' } }), env({ ADMIN_API_KEY: 'k' }));
    expect(res.status).toBe(404);
  });

  it('logs a failed send at error level without the recipient address', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/v1/emails')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '' } as unknown as Response;
    });

    const kv = createFakeKV({ 'secret-address@example.com': 'x' });
    await worker.scheduled(fakeScheduledEvent(Date.now()), env({ REPORT_RECIPIENTS: kv }), fakeCtx);

    const loggedText = [...errorSpy.mock.calls, ...logSpy.mock.calls].flat().map(String).join(' ');
    expect(loggedText).not.toContain('secret-address@example.com');
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});
