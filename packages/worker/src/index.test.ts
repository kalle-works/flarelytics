import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, { isBot, deviceType, browserName, osName, parseFilters, QUERY_TEMPLATES, PERIOD_MAP } from './index';
import { PV_SCHEMA, ENG_SCHEMA, SHARE_SCHEMA, BOT_SCHEMA, CUSTOM_SCHEMA } from './v1/emit';
import { createSessionCookie, buildOrgList } from './auth/session';

function makeEnv(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  // DIMENSIONS, ENRICH_QUEUE, ARCHIVE are stubbed to satisfy the Env type but
  // never accessed by the dual-emit code path (Phase 0.5 scope).
  return {
    ANALYTICS: { writeDataPoint: vi.fn() },
    PAGEVIEW_EVENTS: { writeDataPoint: vi.fn() },
    ENGAGEMENT_EVENTS: { writeDataPoint: vi.fn() },
    SHARE_EVENTS: { writeDataPoint: vi.fn() },
    BOT_EVENTS: { writeDataPoint: vi.fn() },
    PERFORMANCE_EVENTS: { writeDataPoint: vi.fn() },
    CUSTOM_EVENTS: { writeDataPoint: vi.fn() },
    DIMENSIONS: {} as unknown as D1Database,
    ENRICH_QUEUE: {} as unknown as Queue,
    ARCHIVE: {} as unknown as R2Bucket,
    SITE_CONFIG: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
      delete: vi.fn(async (k: string) => { store.delete(k); }),
    } as unknown as KVNamespace,
    ALLOWED_ORIGINS: 'https://example.com,https://kiiru.fi',
    QUERY_API_KEY: 'test-key',
    CF_ACCOUNT_ID: '',
    CF_API_TOKEN: '',
    DATASET_NAME: 'test',
    ...overrides,
  };
}

// Realistic UA strings used across dual-emit tests.
const HUMAN_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const GPTBOT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0; +https://openai.com/gptbot)';

function trackReq(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('https://worker.test/track', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': HUMAN_UA,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/**
 * Build an ExecutionContext that captures the promises passed to waitUntil so
 * dual-emit tests can await them before asserting. waitUntil fires the v1 emit
 * after the response goes back, so without awaiting these the test would race.
 */
function makeCtx() {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: vi.fn((p: Promise<unknown>) => { promises.push(p); }),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
  return {
    ctx,
    settle: () => Promise.all(promises),
  };
}

describe('GET /admin/sites', () => {
  it('returns 401 without api key', async () => {
    const req = new Request('https://worker.test/admin/sites');
    const res = await worker.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('returns env var origins when KV is empty', async () => {
    const req = new Request('https://worker.test/admin/sites', { headers: { 'X-API-Key': 'test-key' } });
    const res = await worker.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { sites: string[] };
    expect(body.sites).toContain('https://example.com');
  });
});

describe('POST /admin/sites', () => {
  it('adds a new origin', async () => {
    const env = makeEnv();
    const req = new Request('https://worker.test/admin/sites', {
      method: 'POST',
      headers: { 'X-API-Key': 'test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'https://newsite.com' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { sites: string[] };
    expect(body.sites).toContain('https://newsite.com');
    expect(env.SITE_CONFIG.put).toHaveBeenCalled();
  });

  it('rejects invalid origin', async () => {
    const req = new Request('https://worker.test/admin/sites', {
      method: 'POST',
      headers: { 'X-API-Key': 'test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'not-a-url' }),
    });
    const res = await worker.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('does not duplicate existing origin', async () => {
    const env = makeEnv();
    const addReq = () => new Request('https://worker.test/admin/sites', {
      method: 'POST',
      headers: { 'X-API-Key': 'test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'https://example.com' }),
    });
    await worker.fetch(addReq(), env, {} as ExecutionContext);
    const res = await worker.fetch(addReq(), env, {} as ExecutionContext);
    const body = await res.json() as { sites: string[] };
    expect(body.sites.filter((s: string) => s === 'https://example.com').length).toBe(1);
  });
});

describe('DELETE /admin/sites', () => {
  it('removes an origin', async () => {
    const env = makeEnv();
    // Seed KV
    await env.SITE_CONFIG.put('allowed_origins', JSON.stringify(['https://example.com', 'https://remove-me.com']));
    const req = new Request('https://worker.test/admin/sites', {
      method: 'DELETE',
      headers: { 'X-API-Key': 'test-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: 'https://remove-me.com' }),
    });
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { sites: string[] };
    expect(body.sites).not.toContain('https://remove-me.com');
    expect(body.sites).toContain('https://example.com');
  });
});

describe('isBot', () => {
  it('detects Googlebot', () => {
    expect(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true);
  });

  it('detects GPTBot', () => {
    expect(isBot('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.0)')).toBe(true);
  });

  it('detects ClaudeBot', () => {
    expect(isBot('ClaudeBot/1.0')).toBe(true);
  });

  it('detects Ahrefs', () => {
    expect(isBot('Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)')).toBe(true);
  });

  it('detects empty UA as bot', () => {
    expect(isBot('')).toBe(true);
  });

  it('allows Chrome desktop', () => {
    expect(isBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')).toBe(false);
  });

  it('allows Safari mobile', () => {
    expect(isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe(false);
  });

  it('allows Firefox', () => {
    expect(isBot('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0')).toBe(false);
  });

  // v0's old isBot did a flat substring match on bare strings like 'baidu'
  // and 'yandex' (no token-boundary check), so a real, human-driven browser
  // whose UA merely contains one of those words as a substring — not the
  // actual bot suffix ('baiduspider', 'yandexbot') — was misclassified as a
  // bot. Delegating to the v1 classifier's token-boundary matching fixes
  // this false-positive class (the 'gptbotmalicious' style problem): a UA
  // still gets flagged when it contains a real bot token, but no longer
  // just because it contains a substring of one.
  it('does not flag a real human browser whose UA merely contains "baidu" without the baiduspider bot token', () => {
    expect(isBot('Mozilla/5.0 (Linux; Android 9; SM-G960F) BaiduBrowser/11.4')).toBe(false);
  });

  it('does not flag a real human tool whose UA merely contains "yandex" without the yandexbot bot token', () => {
    expect(isBot('Mozilla/5.0 (Windows NT 10.0) YandexTranslate/1.0')).toBe(false);
  });
});

describe('deviceType', () => {
  it('detects mobile', () => {
    expect(deviceType('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1')).toBe('mobile');
  });

  it('detects Android mobile', () => {
    expect(deviceType('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36')).toBe('mobile');
  });

  it('detects tablet', () => {
    expect(deviceType('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1')).toBe('tablet');
  });

  it('detects desktop', () => {
    expect(deviceType('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36')).toBe('desktop');
  });
});

describe('browserName', () => {
  it('detects Chrome', () => {
    expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36')).toBe('Chrome');
  });

  it('detects Edge (not Chrome)', () => {
    expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0')).toBe('Edge');
  });

  it('detects Firefox', () => {
    expect(browserName('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0')).toBe('Firefox');
  });

  it('detects Safari desktop', () => {
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toBe('Safari');
  });

  it('detects Safari Mobile', () => {
    expect(browserName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari Mobile');
  });

  it('detects Opera', () => {
    expect(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0')).toBe('Opera');
  });

  it('returns Other for unknown', () => {
    expect(browserName('SomeRandomAgent/1.0')).toBe('Other');
  });
});

describe('osName', () => {
  it('detects Windows', () => {
    expect(osName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36')).toBe('Windows');
  });

  it('detects macOS (desktop Safari)', () => {
    expect(osName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toBe('macOS');
  });

  it('detects iOS (iPhone UA has Mac OS X but must return iOS)', () => {
    expect(osName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iOS');
  });

  it('detects iOS (iPad)', () => {
    expect(osName('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')).toBe('iOS');
  });

  it('detects Android (Android UA has Linux but must return Android)', () => {
    expect(osName('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36')).toBe('Android');
  });

  it('detects Linux (non-Android)', () => {
    expect(osName('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0')).toBe('Linux');
  });

  it('detects ChromeOS', () => {
    expect(osName('Mozilla/5.0 (X11; CrOS x86_64 15329.44.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.5481.100 Safari/537.36')).toBe('ChromeOS');
  });

  it('returns Other for unknown UA', () => {
    expect(osName('curl/8.0')).toBe('Other');
  });
});

describe('POST /track — Phase 0.5 dual-emit (Kiiru only)', () => {
  it('writes legacy + pageview_v1 for a Kiiru pageview', async () => {
    const env = makeEnv();
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'pageview', path: '/a/foo', referrer: 'bsky.app', canonical_url: 'https://kiiru.fi/a/foo' },
      { Origin: 'https://kiiru.fi' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
    await settle();
    expect(env.PAGEVIEW_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
    const v1Call = (env.PAGEVIEW_EVENTS.writeDataPoint as any).mock.calls[0][0];
    expect(v1Call.blobs[0]).toBe(PV_SCHEMA);
    expect(v1Call.blobs[1]).toBe('kiiru.fi');
    expect(v1Call.blobs[3]).toBe(''); // canonical_inferred=false → ''
    expect(v1Call.blobs[4]).toBe('/a/foo'); // path
    expect(v1Call.indexes[0]).toBe('kiiru.fi');
  });

  it('returns 204 before v1 emit completes (waitUntil mitigation)', async () => {
    // The v1 emit lives inside ctx.waitUntil — verify the response is sent
    // back without awaiting the v1 work. If waitUntil were missing, the
    // settle() count below would be 0 and the v1 emit would have already run.
    const env = makeEnv();
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'pageview', path: '/a/foo', canonical_url: 'https://kiiru.fi/a/foo' },
      { Origin: 'https://kiiru.fi' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    expect(env.PAGEVIEW_EVENTS.writeDataPoint).not.toHaveBeenCalled();
    await settle();
    expect(env.PAGEVIEW_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
  });

  it('does NOT write any v1 dataset for non-Kiiru pageview', async () => {
    const env = makeEnv();
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'pageview', path: '/foo', referrer: 'direct' },
      { Origin: 'https://example.com' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    await settle();
    expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(env.PAGEVIEW_EVENTS.writeDataPoint).not.toHaveBeenCalled();
    expect(env.ENGAGEMENT_EVENTS.writeDataPoint).not.toHaveBeenCalled();
    expect(env.SHARE_EVENTS.writeDataPoint).not.toHaveBeenCalled();
    expect(env.BOT_EVENTS.writeDataPoint).not.toHaveBeenCalled();
    expect(env.CUSTOM_EVENTS.writeDataPoint).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('flags canonical_inferred when the tracker omits canonical_url', async () => {
    const env = makeEnv();
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'pageview', path: '/a/no-canonical', referrer: 'direct' },
      { Origin: 'https://kiiru.fi' },
    );
    await worker.fetch(req, env, ctx);
    await settle();
    const v1Call = (env.PAGEVIEW_EVENTS.writeDataPoint as any).mock.calls[0][0];
    expect(v1Call.blobs[3]).toBe('1'); // canonical_inferred=true → '1'
    expect(v1Call.blobs[2]).toMatch(/^[0-9a-f]{12}$/); // canonical_url_hash still present
  });

  it('hashes a tracker-supplied canonical_url to the same value as the inferred fallback for the same target', async () => {
    const env1 = makeEnv();
    const env2 = makeEnv();
    const c1 = makeCtx();
    const c2 = makeCtx();
    await worker.fetch(
      trackReq({ event: 'pageview', path: '/a/foo', canonical_url: 'https://kiiru.fi/a/foo' }, { Origin: 'https://kiiru.fi' }),
      env1, c1.ctx,
    );
    await worker.fetch(
      trackReq({ event: 'pageview', path: '/a/foo' }, { Origin: 'https://kiiru.fi' }),
      env2, c2.ctx,
    );
    await Promise.all([c1.settle(), c2.settle()]);
    const hash1 = (env1.PAGEVIEW_EVENTS.writeDataPoint as any).mock.calls[0][0].blobs[2];
    const hash2 = (env2.PAGEVIEW_EVENTS.writeDataPoint as any).mock.calls[0][0].blobs[2];
    expect(hash1).toBe(hash2);
  });

  it('routes timing events to engagement_v1', async () => {
    const env = makeEnv();
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'timing', path: '/a/foo', props: { seconds: '42' } },
      { Origin: 'https://kiiru.fi' },
    );
    await worker.fetch(req, env, ctx);
    await settle();
    expect(env.ENGAGEMENT_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(env.PAGEVIEW_EVENTS.writeDataPoint).not.toHaveBeenCalled();
    const v1Call = (env.ENGAGEMENT_EVENTS.writeDataPoint as any).mock.calls[0][0];
    expect(v1Call.blobs[0]).toBe(ENG_SCHEMA);
    expect(v1Call.blobs[4]).toBe('timing');
    expect(v1Call.doubles[2]).toBe(42);
  });

  it('routes scroll_depth events to engagement_v1 with scroll_depth double', async () => {
    const env = makeEnv();
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'scroll_depth', path: '/a/foo', props: { depth: '75' } },
      { Origin: 'https://kiiru.fi' },
    );
    await worker.fetch(req, env, ctx);
    await settle();
    expect(env.ENGAGEMENT_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
    const v1Call = (env.ENGAGEMENT_EVENTS.writeDataPoint as any).mock.calls[0][0];
    expect(v1Call.blobs[4]).toBe('scroll_depth');
    expect(v1Call.doubles[1]).toBe(75);
  });

  it('routes outbound events to share_v1', async () => {
    const env = makeEnv();
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'outbound', path: '/a/foo', props: { url: 'bsky.app/profile/x/post/y' } },
      { Origin: 'https://kiiru.fi' },
    );
    await worker.fetch(req, env, ctx);
    await settle();
    expect(env.SHARE_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(env.PAGEVIEW_EVENTS.writeDataPoint).not.toHaveBeenCalled();
    const v1Call = (env.SHARE_EVENTS.writeDataPoint as any).mock.calls[0][0];
    expect(v1Call.blobs[0]).toBe(SHARE_SCHEMA);
    expect(v1Call.blobs[3]).toBe('bluesky'); // platform parsed from target URL
    expect(v1Call.blobs[6]).toMatch(/^[0-9a-f-]{36}$/); // share_id is UUID v4
  });

  it('routes a custom event to custom_v1 with JSON-serialized props', async () => {
    const env = makeEnv();
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'newsletter_signup', path: '/about', props: { plan: 'pro', source: 'banner' } },
      { Origin: 'https://kiiru.fi' },
    );
    await worker.fetch(req, env, ctx);
    await settle();
    expect(env.CUSTOM_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
    const v1Call = (env.CUSTOM_EVENTS.writeDataPoint as any).mock.calls[0][0];
    expect(v1Call.blobs[0]).toBe(CUSTOM_SCHEMA);
    expect(v1Call.blobs[4]).toBe('newsletter_signup');
    expect(JSON.parse(v1Call.blobs[5])).toEqual({ plan: 'pro', source: 'banner' });
  });

  it('writes bot_v1 for bot UAs on Kiiru and skips the pageview path', async () => {
    const env = makeEnv();
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'pageview', path: '/a/foo' },
      { Origin: 'https://kiiru.fi', 'User-Agent': GPTBOT_UA },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1); // legacy bot_hit
    await settle();
    expect(env.BOT_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(env.PAGEVIEW_EVENTS.writeDataPoint).not.toHaveBeenCalled();
    const v1Call = (env.BOT_EVENTS.writeDataPoint as any).mock.calls[0][0];
    expect(v1Call.blobs[0]).toBe(BOT_SCHEMA);
    expect(v1Call.blobs[3]).toBe('ai-crawler');
    expect(v1Call.blobs[4]).toBe('gptbot'); // ai_actor
  });

  it('does not write bot_v1 for bot UAs on non-Kiiru sites', async () => {
    const env = makeEnv();
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'pageview', path: '/foo' },
      { Origin: 'https://example.com', 'User-Agent': GPTBOT_UA },
    );
    await worker.fetch(req, env, ctx);
    await settle();
    expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(env.BOT_EVENTS.writeDataPoint).not.toHaveBeenCalled();
  });

  it('legacy write still succeeds when v1 emit throws (failsafe)', async () => {
    const env = makeEnv({
      PAGEVIEW_EVENTS: { writeDataPoint: vi.fn(() => { throw new Error('AE down'); }) },
    });
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'pageview', path: '/a/foo', canonical_url: 'https://kiiru.fi/a/foo' },
      { Origin: 'https://kiiru.fi' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
    await settle(); // v1 throw is swallowed inside waitUntil — must not reject
  });

  it('v1 emit still runs when legacy write throws (forward-compat)', async () => {
    const env = makeEnv({
      ANALYTICS: { writeDataPoint: vi.fn(() => { throw new Error('legacy down'); }) },
    });
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'pageview', path: '/a/foo', canonical_url: 'https://kiiru.fi/a/foo' },
      { Origin: 'https://kiiru.fi' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    await settle();
    expect(env.PAGEVIEW_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
  });

  it('rejects custom events with oversize event_props_json (>1024 bytes) on Kiiru with 400', async () => {
    const env = makeEnv();
    const { ctx } = makeCtx();
    // Build a props object whose JSON exceeds 1024 bytes
    const big = 'x'.repeat(1100);
    const req = trackReq(
      { event: 'newsletter_signup', path: '/about', props: { large_field: big } },
      { Origin: 'https://kiiru.fi' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/event_props_json exceeds/);
    // No writes should have happened — neither legacy nor v1
    expect(env.ANALYTICS.writeDataPoint).not.toHaveBeenCalled();
    expect(env.CUSTOM_EVENTS.writeDataPoint).not.toHaveBeenCalled();
  });

  it('does NOT enforce custom-event size cap on non-Kiiru sites (legacy v0 behavior preserved)', async () => {
    const env = makeEnv();
    const { ctx } = makeCtx();
    const big = 'x'.repeat(1100);
    const req = trackReq(
      { event: 'newsletter_signup', path: '/about', props: { large_field: big } },
      { Origin: 'https://example.com' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    // v0 silently truncates and writes; v1 dataset stays untouched (non-Kiiru)
    expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
    expect(env.CUSTOM_EVENTS.writeDataPoint).not.toHaveBeenCalled();
  });

  it('does NOT apply custom-event size cap to reserved event names (pageview/timing/scroll_depth/outbound)', async () => {
    const env = makeEnv();
    const { ctx, settle } = makeCtx();
    // Reserved event with large props (e.g. timing event with arbitrary metadata)
    const big = 'x'.repeat(1100);
    const req = trackReq(
      { event: 'timing', path: '/a/foo', props: { seconds: '42', meta: big } },
      { Origin: 'https://kiiru.fi' },
    );
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(204);
    await settle();
    expect(env.ENGAGEMENT_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
  });

  it('strips www. from origin when matching against Kiiru allowlist', async () => {
    const env = makeEnv({ ALLOWED_ORIGINS: 'https://www.kiiru.fi' });
    const { ctx, settle } = makeCtx();
    const req = trackReq(
      { event: 'pageview', path: '/a/foo', canonical_url: 'https://kiiru.fi/a/foo' },
      { Origin: 'https://www.kiiru.fi' },
    );
    await worker.fetch(req, env, ctx);
    await settle();
    expect(env.PAGEVIEW_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
  });
});

describe('GET /query?v=1 (Distribution Loop)', () => {
  function v1Req(qs: string, headers: Record<string, string> = { 'X-API-Key': 'test-key' }): Request {
    return new Request(`https://worker.test/query?v=1&${qs}`, { headers });
  }

  it('rejects without API key', async () => {
    const res = await worker.fetch(v1Req('q=loop-overview&site=kiiru.fi&period=30d', {}), makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('rejects unknown v1 query name', async () => {
    const res = await worker.fetch(v1Req('q=nope&site=kiiru.fi&period=30d'), makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; available: { name: string }[] };
    expect(body.error).toBe('Invalid v1 query');
    expect(body.available.map((q) => q.name)).toContain('loop-overview');
  });

  it('rejects missing site param', async () => {
    const res = await worker.fetch(v1Req('q=loop-overview&period=30d'), makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('rejects invalid site param (SQL-injection guard)', async () => {
    const res = await worker.fetch(v1Req("q=loop-overview&site=evil';DROP--&period=30d"), makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  it('rejects unsupported period', async () => {
    const res = await worker.fetch(v1Req('q=loop-overview&site=kiiru.fi&period=1y'), makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
  });

  function classifyV1Sql(sql: string): 'shares' | 'sharesTotal' | 'pageviews' | 'paths' | 'engagement' | 'socialInbound' | 'unknown' {
    // Order matters — paths and pageviews both query pageview_v1; check the
    // (canonical, path) GROUP BY first so it doesn't fall through to pageviews.
    if (sql.includes('flarelytics_engagement_v1')) return 'engagement';
    if (sql.includes('flarelytics_share_v1') && sql.includes('shares_out_total')) return 'sharesTotal';
    if (sql.includes('flarelytics_share_v1')) return 'shares';
    if (sql.includes('flarelytics_pageview_v1') && sql.includes('inbound_visits_from_social')) return 'socialInbound';
    if (sql.includes('flarelytics_pageview_v1') && sql.includes('GROUP BY canonical_url_hash, path')) return 'paths';
    if (sql.includes('flarelytics_pageview_v1')) return 'pageviews';
    return 'unknown';
  }

  function happyPathBody(bucket: ReturnType<typeof classifyV1Sql>): unknown {
    switch (bucket) {
      case 'shares': return { data: [
        { canonical_url_hash: 'a1', shares_out: 125 },
        { canonical_url_hash: 'b2', shares_out: 98 },
      ]};
      case 'sharesTotal': return { data: [{ shares_out_total: 273, articles_driving_shares: 47 }] };
      case 'pageviews': return { data: [
        { canonical_url_hash: 'a1', inbound_visits: 846 },
        { canonical_url_hash: 'b2', inbound_visits: 572 },
      ]};
      case 'paths': return { data: [
        { canonical_url_hash: 'a1', path: '/breaking', views: 800, first_seen: '2026-05-01T00:00:00Z' },
        { canonical_url_hash: 'b2', path: '/howto', views: 572, first_seen: '2026-05-03T00:00:00Z' },
      ]};
      case 'engagement': return { data: [
        { canonical_url_hash: 'a1', engaged_reads: 488 },
        { canonical_url_hash: 'b2', engaged_reads: 137 },
      ]};
      case 'socialInbound': return { data: [{ inbound_visits_from_social: 2341 }] };
      default: return { data: [] };
    }
  }

  it('aggregates the six CF SQL responses into LoopOverview shape with partial=false', async () => {
    const env = makeEnv({ CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const sql = String((init as RequestInit | undefined)?.body ?? '');
      return new Response(JSON.stringify(happyPathBody(classifyV1Sql(sql))), { status: 200 });
    });

    const res = await worker.fetch(v1Req('q=loop-overview&site=kiiru.fi&period=30d'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=300, must-revalidate');
    const body = await res.json() as {
      period: string; site: string; partial: boolean;
      status: Record<string, 'ok' | 'failed'>;
      kpis: { articles_driving_shares: number; inbound_visits_from_social: number; secondary_share_rate: number; avg_distribution_quality_score: number };
      articles: { canonical_url_hash: string; path: string; shares_out: number; inbound_visits: number; engaged_reads: number; quality_score: number }[];
    };
    expect(body.site).toBe('kiiru.fi');
    expect(body.partial).toBe(false);
    expect(Object.values(body.status).every((s) => s === 'ok')).toBe(true);
    expect(body.kpis.articles_driving_shares).toBe(47);
    expect(body.kpis.inbound_visits_from_social).toBe(2341);
    expect(body.articles).toHaveLength(2);
    expect(body.articles[0]).toMatchObject({ canonical_url_hash: 'a1', path: '/breaking', shares_out: 125, quality_score: 58 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    fetchMock.mockRestore();
  });

  it('returns 200 with partial=true when one CF SQL bucket fails (engagement)', async () => {
    const env = makeEnv({ CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const sql = String((init as RequestInit | undefined)?.body ?? '');
      const bucket = classifyV1Sql(sql);
      if (bucket === 'engagement') return new Response('engagement temporarily unavailable', { status: 500 });
      return new Response(JSON.stringify(happyPathBody(bucket)), { status: 200 });
    });

    const res = await worker.fetch(v1Req('q=loop-overview&site=kiiru.fi&period=30d'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      partial: boolean;
      status: Record<string, 'ok' | 'failed'>;
      kpis: { articles_driving_shares: number; inbound_visits_from_social: number; avg_distribution_quality_score: number | null };
      articles: { engaged_reads: number }[];
    };
    expect(body.partial).toBe(true);
    expect(body.status.engagement).toBe('failed');
    // Quality KPI requires engagement, so it nulls out
    expect(body.kpis.avg_distribution_quality_score).toBeNull();
    // Other KPIs survive
    expect(body.kpis.articles_driving_shares).toBe(47);
    expect(body.kpis.inbound_visits_from_social).toBe(2341);
    // Article rows still render with engaged_reads=0 (engagement bucket missing)
    expect(body.articles).toHaveLength(2);
    expect(body.articles[0].engaged_reads).toBe(0);
    fetchMock.mockRestore();
  });

  it('returns 200 with partial=true and all-null KPIs when every bucket fails', async () => {
    const env = makeEnv({ CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('boom', { status: 500 }));
    const res = await worker.fetch(v1Req('q=loop-overview&site=kiiru.fi&period=30d'), env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      partial: boolean;
      status: Record<string, 'ok' | 'failed'>;
      kpis: { articles_driving_shares: null; inbound_visits_from_social: null; secondary_share_rate: null; avg_distribution_quality_score: null };
      articles: unknown[];
    };
    expect(body.partial).toBe(true);
    expect(Object.values(body.status).every((s) => s === 'failed')).toBe(true);
    expect(body.kpis.articles_driving_shares).toBeNull();
    expect(body.kpis.secondary_share_rate).toBeNull();
    expect(body.articles).toEqual([]);
    fetchMock.mockRestore();
  });
});

describe('GET /config', () => {
  it('lists v1 queries alongside v0', async () => {
    const res = await worker.fetch(new Request('https://worker.test/config'), makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { queries_v1: { name: string }[]; filters: { keys: string[] } };
    expect(body.queries_v1.map((q) => q.name)).toContain('loop-overview');
    expect(body.filters.keys).toContain('country');
    expect(body.filters.keys).toContain('device');
  });

  it('does not list new-vs-returning (removed: cannot work with a daily-rotating visitor hash)', async () => {
    const res = await worker.fetch(new Request('https://worker.test/config'), makeEnv(), {} as ExecutionContext);
    const body = await res.json() as { queries: { name: string }[] };
    expect(body.queries.map((q) => q.name)).not.toContain('new-vs-returning');
  });
});

describe('GET /query?q=new-vs-returning', () => {
  it('returns 400 (query removed: cannot work with a daily-rotating visitor hash)', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/query?q=new-vs-returning&site=example.com', { headers: { 'X-API-Key': 'test-key' } }),
      makeEnv({ CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' }),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; available: { name: string }[] };
    expect(body.error).toMatch(/invalid query/i);
    expect(body.available.map((q) => q.name)).not.toContain('new-vs-returning');
  });
});

describe('parseFilters', () => {
  it('returns empty string when no filter params', () => {
    const url = new URL('https://worker.test/query?q=top-pages&site=example.com');
    expect(parseFilters(url)).toBe('');
  });

  it('parses a valid country filter', () => {
    const url = new URL('https://worker.test/query?q=top-pages&site=example.com&filter[country]=FI');
    expect(parseFilters(url)).toBe("AND blob3 = 'FI'");
  });

  it('parses multiple valid filters', () => {
    const url = new URL('https://worker.test/query?q=top-pages&site=example.com&filter[country]=FI&filter[device]=mobile');
    const result = parseFilters(url);
    expect(result).toContain("AND blob3 = 'FI'");
    expect(result).toContain("AND blob11 = 'mobile'");
  });

  it('rejects country codes with wrong format', () => {
    const url = new URL('https://worker.test/query?q=top-pages&site=example.com&filter[country]=finland');
    expect(parseFilters(url)).toBe('');
  });

  it('rejects unknown filter keys', () => {
    const url = new URL('https://worker.test/query?q=top-pages&site=example.com&filter[ip]=1.2.3.4');
    expect(parseFilters(url)).toBe('');
  });

  it('escapes single quotes in filter values', () => {
    const url = new URL('https://worker.test/query?q=top-pages&site=example.com&filter[browser]=Safari%20Mobile');
    const result = parseFilters(url);
    expect(result).toBe("AND blob12 = 'Safari Mobile'");
  });

  it('rejects device values outside the allowlist', () => {
    const url = new URL('https://worker.test/query?q=top-pages&site=example.com&filter[device]=phone');
    expect(parseFilters(url)).toBe('');
  });

  it('parses referrer filter', () => {
    const url = new URL('https://worker.test/query?q=top-pages&site=example.com&filter[referrer]=twitter.com');
    expect(parseFilters(url)).toBe("AND blob2 = 'twitter.com'");
  });
});

describe('POST /track — server-side tracking', () => {
  it('rejects server-side request without API key', async () => {
    const { ctx } = makeCtx();
    const req = new Request('https://worker.test/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': HUMAN_UA },
      body: JSON.stringify({ event: 'purchase', path: '/checkout', site: 'example.com' }),
    });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  it('rejects a server-side request whose site is missing or not a hostname with 400 and writes nothing', async () => {
    for (const site of [undefined, '', 'not a host name', 'evil.com/path']) {
      const { ctx } = makeCtx();
      const env = makeEnv();
      const req = new Request('https://worker.test/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': HUMAN_UA, 'X-API-Key': 'test-key' },
        body: JSON.stringify({ event: 'purchase', path: '/checkout', ...(site === undefined ? {} : { site }) }),
      });
      const res = await worker.fetch(req, env, ctx);
      expect(res.status, `site=${String(site)}`).toBe(400);
      expect(env.ANALYTICS.writeDataPoint).not.toHaveBeenCalled();
    }
  });

  it('accepts server-side request with valid API key and site field', async () => {
    const { ctx, settle } = makeCtx();
    const env = makeEnv();
    const req = new Request('https://worker.test/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': HUMAN_UA,
        'X-API-Key': 'test-key',
      },
      body: JSON.stringify({ event: 'purchase', path: '/checkout', site: 'example.com' }),
    });
    const res = await worker.fetch(req, env, ctx);
    await settle();
    expect(res.status).toBe(204);
    expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalled();
    const call = (env.ANALYTICS.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.blobs[9]).toBe('example.com'); // blob10 = site
  });

  it('stores revenue value in double3', async () => {
    const { ctx, settle } = makeCtx();
    const env = makeEnv();
    const req = trackReq(
      { event: 'purchase', path: '/checkout', value: 49.99 },
      { Origin: 'https://example.com' },
    );
    const res = await worker.fetch(req, env, ctx);
    await settle();
    expect(res.status).toBe(204);
    const call = (env.ANALYTICS.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.doubles[2]).toBeCloseTo(49.99);
  });

  it('stores 0 in double3 when no value field', async () => {
    const { ctx, settle } = makeCtx();
    const env = makeEnv();
    const req = trackReq({ event: 'pageview', path: '/' }, { Origin: 'https://example.com' });
    const res = await worker.fetch(req, env, ctx);
    await settle();
    expect(res.status).toBe(204);
    const call = (env.ANALYTICS.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.doubles[2]).toBe(0);
  });

  it('ignores negative value field', async () => {
    const { ctx, settle } = makeCtx();
    const env = makeEnv();
    const req = trackReq(
      { event: 'refund', path: '/checkout', value: -10 },
      { Origin: 'https://example.com' },
    );
    const res = await worker.fetch(req, env, ctx);
    await settle();
    expect(res.status).toBe(204);
    const call = (env.ANALYTICS.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.doubles[2]).toBe(0);
  });
});

describe('POST /track — request body size cap', () => {
  it('rejects a request whose Content-Length header exceeds the cap, without reading the body', async () => {
    const req = new Request('https://worker.test/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': HUMAN_UA,
        Origin: 'https://example.com',
        'Content-Length': '99999',
      },
      body: JSON.stringify({ event: 'pageview', path: '/' }),
    });
    const res = await worker.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(413);
  });

  it('rejects an oversize body even without a Content-Length header (streamed cap)', async () => {
    // No explicit Content-Length is set here — Node's Request does not compute
    // one for a string body, matching a client that streams without declaring
    // a length. The cap must still be enforced by reading the actual bytes.
    const req = new Request('https://worker.test/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': HUMAN_UA,
        Origin: 'https://example.com',
      },
      body: JSON.stringify({ event: 'pageview', path: '/', referrer: 'a'.repeat(9000) }),
    });
    expect(req.headers.get('Content-Length')).toBeNull();
    const res = await worker.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(413);
  });

  it('accepts a request comfortably under the cap', async () => {
    const { ctx, settle } = makeCtx();
    const env = makeEnv();
    const req = trackReq({ event: 'pageview', path: '/' }, { Origin: 'https://example.com' });
    const res = await worker.fetch(req, env, ctx);
    await settle();
    expect(res.status).toBe(204);
  });
});

describe('GET /public-stats', () => {
  const cfStatsResponse = {
    data: [{ pageviews: 1200, visitors: 340, total_bot_hits: 18, views: 100, visits: 50, path: '/', referrer: 'google.com', country: 'FI', device: 'desktop', date: '2025-05-01' }],
  };

  function makeCfMock() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(cfStatsResponse), { status: 200 }),
    );
  }

  it('returns 400 when site param is missing', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/public-stats'),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/site/i);
  });

  it('returns 400 when site param contains invalid characters', async () => {
    const res = await worker.fetch(
      new Request("https://worker.test/public-stats?site=evil'--"),
      makeEnv(),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when site is not in PUBLIC_STATS_SITES', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/public-stats?site=example.com'),
      makeEnv({ PUBLIC_STATS_SITES: 'other.com' }),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when PUBLIC_STATS_SITES is empty', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/public-stats?site=example.com'),
      makeEnv({ PUBLIC_STATS_SITES: '' }),
      {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });

  it('returns 200 with stats shape when site is allowed', async () => {
    const fetchMock = makeCfMock();
    const env = makeEnv({ PUBLIC_STATS_SITES: 'example.com', CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' });
    const res = await worker.fetch(
      new Request('https://worker.test/public-stats?site=example.com'),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as {
      period: string; site: string; generated: string;
      stats: { pageviews: number; visitors: number; topPages: unknown[]; referrers: unknown[]; countries: unknown[]; devices: unknown[]; dailyViews: unknown[]; botHitsTotal: number };
    };
    expect(body.period).toBe('30d');
    expect(body.site).toBe('example.com');
    expect(typeof body.generated).toBe('string');
    expect(typeof body.stats.pageviews).toBe('number');
    expect(typeof body.stats.visitors).toBe('number');
    expect(Array.isArray(body.stats.topPages)).toBe(true);
    expect(Array.isArray(body.stats.referrers)).toBe(true);
    expect(Array.isArray(body.stats.countries)).toBe(true);
    expect(Array.isArray(body.stats.devices)).toBe(true);
    expect(Array.isArray(body.stats.dailyViews)).toBe(true);
    expect(typeof body.stats.botHitsTotal).toBe('number');
    fetchMock.mockRestore();
  });

  it('sends the same SQL QUERY_TEMPLATES would generate for each metric (no duplicated inline SQL)', async () => {
    const fetchMock = makeCfMock();
    const env = makeEnv({ PUBLIC_STATS_SITES: 'example.com', CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok', DATASET_NAME: 'test' });
    await worker.fetch(
      new Request('https://worker.test/public-stats?site=example.com'),
      env,
      {} as ExecutionContext,
    );
    const sentBodies = fetchMock.mock.calls.map((call) => String((call[1] as RequestInit).body).trim());
    const period = PERIOD_MAP['30d'];
    const expectedTemplates = ['total-pageviews', 'total-visitors', 'top-pages', 'referrers', 'countries', 'devices', 'daily-views', 'bot-hits-total'];
    for (const name of expectedTemplates) {
      const expectedSql = QUERY_TEMPLATES[name].sql('test', period, 'example.com', '', '').trim();
      expect(sentBodies).toContain(expectedSql);
    }
    fetchMock.mockRestore();
  });

  it('returns 502 when CF query fails', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('CF down', { status: 503 }),
    );
    const env = makeEnv({ PUBLIC_STATS_SITES: 'example.com', CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' });
    const res = await worker.fetch(
      new Request('https://worker.test/public-stats?site=example.com'),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(502);
    fetchMock.mockRestore();
  });

  it('reflects any origin in CORS headers (open endpoint)', async () => {
    const fetchMock = makeCfMock();
    const env = makeEnv({ PUBLIC_STATS_SITES: 'example.com', CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok' });
    const res = await worker.fetch(
      new Request('https://worker.test/public-stats?site=example.com', {
        headers: { Origin: 'https://any-site.com' },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    // corsHeaders reflects the specific origin for allowAny=true endpoints (not literal *)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://any-site.com');
    fetchMock.mockRestore();
  });
});

// ── Multi-organization auth gate ──────────────────────────────────────────────
describe('multi-org auth — /query', () => {
  const SECRET = 'test-session-secret-at-least-32-chars-long';
  const ORIGIN = 'https://app.flarelytics.dev';

  function authEnv(over: Record<string, unknown> = {}) {
    return makeEnv({ SESSION_SECRET: SECRET, DASHBOARD_URL: ORIGIN, ADMIN_EMAILS: 'kalle@kalle.works', CF_ACCOUNT_ID: 'acct', CF_API_TOKEN: 'tok', ...over });
  }

  async function cookieFor(opts: Parameters<typeof createSessionCookie>[0]): Promise<string> {
    const { cookieHeader } = await createSessionCookie(opts);
    return cookieHeader.split(';')[0];
  }

  function cfMock() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ data: [], meta: [] }), { status: 200 }),
    );
  }

  it('401 when neither X-API-Key nor session present', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/query?q=top-pages&site=example.com'),
      authEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it('X-API-Key still grants full access (back-compat)', async () => {
    const fetchMock = cfMock();
    const res = await worker.fetch(
      new Request('https://worker.test/query?q=top-pages&site=anything.com', { headers: { 'X-API-Key': 'test-key' } }),
      authEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    fetchMock.mockRestore();
  });

  it('session is allowed for a site its active org owns', async () => {
    const fetchMock = cfMock();
    const env = authEnv();
    await env.SITE_CONFIG.put('org:u1:sites', JSON.stringify([{ hostname: 'example.com', label: 'example.com' }]));
    const cookie = await cookieFor({ email: 'a@b.c', sub: 'u1', orgs: buildOrgList('u1', []), active_org: 'u1', secret: SECRET });
    const res = await worker.fetch(
      new Request('https://worker.test/query?q=top-pages&site=example.com', { headers: { Cookie: cookie } }),
      env, {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    fetchMock.mockRestore();
  });

  it('session is forbidden for a site its org does not own', async () => {
    const env = authEnv();
    await env.SITE_CONFIG.put('org:u1:sites', JSON.stringify([{ hostname: 'example.com', label: 'example.com' }]));
    const cookie = await cookieFor({ email: 'a@b.c', sub: 'u1', orgs: buildOrgList('u1', []), active_org: 'u1', secret: SECRET });
    const res = await worker.fetch(
      new Request('https://worker.test/query?q=top-pages&site=foreign.com', { headers: { Cookie: cookie } }),
      env, {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });

  it('admin email bypasses org site ownership', async () => {
    const fetchMock = cfMock();
    const env = authEnv();
    const cookie = await cookieFor({ email: 'kalle@kalle.works', sub: 'u1', orgs: buildOrgList('u1', []), active_org: 'u1', secret: SECRET });
    const res = await worker.fetch(
      new Request('https://worker.test/query?q=top-pages&site=any-site.com', { headers: { Cookie: cookie } }),
      env, {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    fetchMock.mockRestore();
  });
});

describe('multi-org auth — /admin/sites (org-scoped)', () => {
  const SECRET = 'test-session-secret-at-least-32-chars-long';
  const ORIGIN = 'https://app.flarelytics.dev';

  function authEnv(over: Record<string, unknown> = {}) {
    return makeEnv({ SESSION_SECRET: SECRET, DASHBOARD_URL: ORIGIN, ...over });
  }
  async function cookieFor(opts: Parameters<typeof createSessionCookie>[0]): Promise<string> {
    const { cookieHeader } = await createSessionCookie(opts);
    return cookieHeader.split(';')[0];
  }

  it('X-API-Key keeps managing the global allowed_origins list (legacy)', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/admin/sites', { headers: { 'X-API-Key': 'test-key' } }),
      authEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { sites: string[] };
    expect(Array.isArray(body.sites)).toBe(true);
  });

  it('owner POST returns a pending DNS-TXT claim (no access until verified)', async () => {
    const env = authEnv();
    const cookie = await cookieFor({ email: 'a@b.c', sub: 'u1', orgs: buildOrgList('u1', []), active_org: 'u1', secret: SECRET });
    const res = await worker.fetch(
      new Request('https://worker.test/admin/sites', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname: 'newsite.com', label: 'New' }),
      }), env, {} as ExecutionContext,
    );
    expect(res.status).toBe(202);
    const body = await res.json() as { pending: boolean; verification: { name: string; value: string } };
    expect(body.pending).toBe(true);
    expect(body.verification.name).toBe('_flarelytics.newsite.com');
    // Not granted yet.
    const session = await env.SITE_CONFIG.get('org:u1:sites');
    expect(session).toBeNull();
  });

  it('owner can verify a claim via DNS TXT and then gains access', async () => {
    const env = authEnv();
    const cookie = await cookieFor({ email: 'a@b.c', sub: 'u1', orgs: buildOrgList('u1', []), active_org: 'u1', secret: SECRET });
    // Start the claim to mint the token.
    const claimRes = await worker.fetch(
      new Request('https://worker.test/admin/sites', {
        method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname: 'newsite.com', label: 'New' }),
      }), env, {} as ExecutionContext,
    );
    const token = ((await claimRes.json()) as { verification: { value: string } }).verification.value;
    // Mock DNS-over-HTTPS to return the matching TXT record.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('cloudflare-dns.com')) {
        return new Response(JSON.stringify({ Answer: [{ data: `"${token}"` }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const verifyRes = await worker.fetch(
      new Request('https://worker.test/admin/sites/verify', {
        method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname: 'newsite.com', label: 'New' }),
      }), env, {} as ExecutionContext,
    );
    expect(verifyRes.status).toBe(200);
    const body = await verifyRes.json() as { verified: boolean; sites: { hostname: string }[] };
    expect(body.verified).toBe(true);
    expect(body.sites.some((s) => s.hostname === 'newsite.com')).toBe(true);
    expect(await env.SITE_CONFIG.get('site_owner:newsite.com')).toBe('u1');
    fetchMock.mockRestore();
  });

  it('removing a verified site also revokes its /track CORS access (403 afterward)', async () => {
    const env = authEnv();
    const cookie = await cookieFor({ email: 'a@b.c', sub: 'u1', orgs: buildOrgList('u1', []), active_org: 'u1', secret: SECRET });
    const claimRes = await worker.fetch(
      new Request('https://worker.test/admin/sites', {
        method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname: 'newsite.com' }),
      }), env, {} as ExecutionContext,
    );
    const token = ((await claimRes.json()) as { verification: { value: string } }).verification.value;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('cloudflare-dns.com')) {
        return new Response(JSON.stringify({ Answer: [{ data: `"${token}"` }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    await worker.fetch(
      new Request('https://worker.test/admin/sites/verify', {
        method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname: 'newsite.com' }),
      }), env, {} as ExecutionContext,
    );
    fetchMock.mockRestore();

    // Before removal: /track from the newly-verified origin is accepted.
    const beforeReq = new Request('https://worker.test/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': HUMAN_UA, Origin: 'https://newsite.com' },
      body: JSON.stringify({ event: 'pageview', path: '/' }),
    });
    const { ctx: beforeCtx } = makeCtx();
    const beforeRes = await worker.fetch(beforeReq, env, beforeCtx);
    expect(beforeRes.status).toBe(204);

    const deleteRes = await worker.fetch(
      new Request('https://worker.test/admin/sites', {
        method: 'DELETE', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname: 'newsite.com' }),
      }), env, {} as ExecutionContext,
    );
    expect(deleteRes.status).toBe(200);

    // After removal: /track from that origin is rejected — the org can no
    // longer query it, so /track must stop accepting events for it too.
    const afterReq = new Request('https://worker.test/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': HUMAN_UA, Origin: 'https://newsite.com' },
      body: JSON.stringify({ event: 'pageview', path: '/' }),
    });
    const { ctx: afterCtx } = makeCtx();
    const afterRes = await worker.fetch(afterReq, env, afterCtx);
    expect(afterRes.status).toBe(403);
  });

  it('rejects claiming a hostname already owned by another org (409)', async () => {
    const env = authEnv();
    await env.SITE_CONFIG.put('site_owner:taken.com', 'someone-else');
    const cookie = await cookieFor({ email: 'a@b.c', sub: 'u1', orgs: buildOrgList('u1', []), active_org: 'u1', secret: SECRET });
    const res = await worker.fetch(
      new Request('https://worker.test/admin/sites', {
        method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname: 'taken.com' }),
      }), env, {} as ExecutionContext,
    );
    expect(res.status).toBe(409);
  });

  it('fails verification (422) when the DNS TXT record is missing', async () => {
    const env = authEnv();
    const cookie = await cookieFor({ email: 'a@b.c', sub: 'u1', orgs: buildOrgList('u1', []), active_org: 'u1', secret: SECRET });
    await worker.fetch(new Request('https://worker.test/admin/sites', {
      method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname: 'newsite.com' }),
    }), env, {} as ExecutionContext);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ Answer: [] }), { status: 200 }));
    const res = await worker.fetch(new Request('https://worker.test/admin/sites/verify', {
      method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ hostname: 'newsite.com' }),
    }), env, {} as ExecutionContext);
    expect(res.status).toBe(422);
    fetchMock.mockRestore();
  });

  it('rejects a member (insufficient role)', async () => {
    const env = authEnv();
    const cookie = await cookieFor({
      email: 'a@b.c', sub: 'u1',
      orgs: buildOrgList('u1', [{ id: 'org-a', name: 'Acme', role: 'member' }]),
      active_org: 'org-a', secret: SECRET,
    });
    const res = await worker.fetch(
      new Request('https://worker.test/admin/sites', {
        method: 'POST',
        headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname: 'x.com' }),
      }), env, {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });

  it('rejects a mutation without a same-origin header (CSRF)', async () => {
    const env = authEnv();
    const cookie = await cookieFor({ email: 'a@b.c', sub: 'u1', orgs: buildOrgList('u1', []), active_org: 'u1', secret: SECRET });
    const res = await worker.fetch(
      new Request('https://worker.test/admin/sites', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname: 'x.com' }),
      }), env, {} as ExecutionContext,
    );
    expect(res.status).toBe(403);
  });

  it('GET returns the active org site list for a session', async () => {
    const env = authEnv();
    await env.SITE_CONFIG.put('org:u1:sites', JSON.stringify([{ hostname: 'mine.com', label: 'Mine' }]));
    const cookie = await cookieFor({ email: 'a@b.c', sub: 'u1', orgs: buildOrgList('u1', []), active_org: 'u1', secret: SECRET });
    const res = await worker.fetch(
      new Request('https://worker.test/admin/sites', { headers: { Cookie: cookie } }),
      env, {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { sites: { hostname: string }[] };
    expect(body.sites).toEqual([{ hostname: 'mine.com', label: 'Mine' }]);
  });
});

// ── Timing-safe X-API-Key comparisons ─────────────────────────────────────────
// makeEnv()'s QUERY_API_KEY is 'test-key' (8 chars). 'test-kex' is the same
// length, differing only in the last byte — a key that would defeat a naive
// early-exit === comparison's timing signal but must still be rejected.
describe('X-API-Key comparisons are timing-safe (equal-length, last-byte-different key rejected)', () => {
  const WRONG_KEY_SAME_LENGTH = 'test-kex';

  it('GET /query rejects a same-length wrong key (falls through to 401, no session)', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/query?q=top-pages&site=example.com', {
        headers: { 'X-API-Key': WRONG_KEY_SAME_LENGTH },
      }),
      makeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });

  it('POST /track (server-side, no Origin) rejects a same-length wrong key', async () => {
    const { ctx } = makeCtx();
    const req = new Request('https://worker.test/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': HUMAN_UA,
        'X-API-Key': WRONG_KEY_SAME_LENGTH,
      },
      body: JSON.stringify({ event: 'purchase', path: '/checkout', site: 'example.com' }),
    });
    const res = await worker.fetch(req, makeEnv(), ctx);
    expect(res.status).toBe(401);
  });

  it('legacy /admin/sites rejects a same-length wrong key (falls through to 401, no session)', async () => {
    const res = await worker.fetch(
      new Request('https://worker.test/admin/sites', { headers: { 'X-API-Key': WRONG_KEY_SAME_LENGTH } }),
      makeEnv(), {} as ExecutionContext,
    );
    expect(res.status).toBe(401);
  });
});
