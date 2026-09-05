import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import worker, { deviceType, browserName, osName, isBot, parseFilters, QUERY_TEMPLATES as TEMPLATE_QUERY_TEMPLATES } from '../templates/worker-source.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, '..', 'templates', 'worker-source.ts');
const TEMPLATE_SOURCE = readFileSync(TEMPLATE_PATH, 'utf-8');

// The CLI template is a single-tenant, hand-maintained copy of the real
// worker's v0 query surface. It's meant to be an exact match at the
// QUERY_TEMPLATES level — the worker has no v0 query that doesn't make sense
// for a self-hosted single-site worker. If that ever changes (a v1-only,
// multi-org, or auth-internal query gets added to the worker's v0 object),
// add its name here with a comment explaining why the template intentionally
// omits it, rather than loosening the assertion below.
const INTENTIONAL_WORKER_ONLY_QUERIES: string[] = [];

// Static import from the worker's query module. A refactor that moves or
// renames the template table must fail this test loudly rather than skip it.
import { QUERY_TEMPLATES as WORKER_QUERY_TEMPLATES } from '../../worker/src/queries/v0';
const workerQueryNames: string[] = Object.keys(WORKER_QUERY_TEMPLATES);
function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    ANALYTICS: { writeDataPoint: vi.fn() },
    ALLOWED_ORIGINS: 'https://example.com',
    QUERY_API_KEY: 'super-secret-key',
    CF_ACCOUNT_ID: 'account123',
    CF_API_TOKEN: 'token123',
    DATASET_NAME: 'my-site',
    ...overrides,
  };
}

const REAL_BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

function trackRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://worker.example.com/track', {
    method: 'POST',
    // isBot() treats a missing User-Agent as a bot and short-circuits before
    // any of the fields under test are read, so every non-bot test needs a
    // real-looking UA unless it's overridden to test something UA-specific.
    headers: { 'Content-Type': 'application/json', 'User-Agent': REAL_BROWSER_UA, ...headers },
    body: JSON.stringify(body),
  });
}

describe('handleTrack — server-side auth gate (no Origin header)', () => {
  it('rejects a request with no Origin and no X-API-Key with 401, and never writes the event', async () => {
    const env = makeEnv();
    const res = await worker.fetch(trackRequest({ event: 'pageview', path: '/', site: 'example.com' }), env as any, {} as any);

    expect(res.status).toBe(401);
    expect(env.ANALYTICS.writeDataPoint).not.toHaveBeenCalled();
  });

  it('rejects a request with no Origin and a wrong X-API-Key with 401, and never writes the event', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      trackRequest({ event: 'pageview', path: '/', site: 'example.com' }, { 'X-API-Key': 'wrong-key' }),
      env as any,
      {} as any,
    );

    expect(res.status).toBe(401);
    expect(env.ANALYTICS.writeDataPoint).not.toHaveBeenCalled();
  });

  it('accepts a request with no Origin when X-API-Key matches, deriving the site from the body', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      trackRequest({ event: 'pageview', path: '/pricing', site: 'example.com' }, { 'X-API-Key': 'super-secret-key' }),
      env as any,
      {} as any,
    );

    expect(res.status).toBe(204);
    expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
    const call = env.ANALYTICS.writeDataPoint.mock.calls[0][0];
    expect(call.blobs[9]).toBe('example.com'); // blob10: site hostname, from body.site
  });

  it('still allows browser requests with a valid Origin and no X-API-Key', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      trackRequest({ event: 'pageview', path: '/' }, { Origin: 'https://example.com' }),
      env as any,
      {} as any,
    );

    expect(res.status).toBe(204);
    expect(env.ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
  });
});

describe('handleTrack — salted, per-site visitor hash', () => {
  async function blob9For(env: ReturnType<typeof makeEnv>, origin: string): Promise<string> {
    env.ANALYTICS.writeDataPoint.mockClear();
    const res = await worker.fetch(trackRequest({ event: 'pageview', path: '/' }, { Origin: origin }), env as any, {} as any);
    expect(res.status).toBe(204);
    return env.ANALYTICS.writeDataPoint.mock.calls[0][0].blobs[8];
  }

  it('gives the same visitor a different blob9 on each site', async () => {
    const env = makeEnv({ ALLOWED_ORIGINS: 'https://site-a.com,https://site-b.com' });
    const a = await blob9For(env, 'https://site-a.com');
    const b = await blob9For(env, 'https://site-b.com');
    expect(a).toHaveLength(16);
    expect(a).not.toBe(b);
  });

  it('changes blob9 when VISITOR_SALT changes', async () => {
    const a = await blob9For(makeEnv({ VISITOR_SALT: 'salt-one' }), 'https://example.com');
    const b = await blob9For(makeEnv({ VISITOR_SALT: 'salt-two' }), 'https://example.com');
    expect(a).not.toBe(b);
  });
});

describe('handleTrack — OS detection and revenue tracking parity', () => {
  it('stores the operating system in blob13', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      trackRequest(
        { event: 'pageview', path: '/' },
        {
          Origin: 'https://example.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
        },
      ),
      env as any,
      {} as any,
    );

    expect(res.status).toBe(204);
    const call = env.ANALYTICS.writeDataPoint.mock.calls[0][0];
    expect(call.blobs[12]).toBe('Windows'); // blob13: operating system
  });

  it('stores a numeric "value" field as revenue in double3', async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      trackRequest({ event: 'purchase', path: '/checkout', value: 19.99 }, { Origin: 'https://example.com' }),
      env as any,
      {} as any,
    );

    expect(res.status).toBe(204);
    const call = env.ANALYTICS.writeDataPoint.mock.calls[0][0];
    expect(call.doubles[2]).toBe(19.99); // double3: revenue value
  });

  it('coerces a negative value to 0 rather than storing it', async () => {
    const env = makeEnv();
    await worker.fetch(
      trackRequest({ event: 'purchase', path: '/checkout', value: -5 }, { Origin: 'https://example.com' }),
      env as any,
      {} as any,
    );

    const call = env.ANALYTICS.writeDataPoint.mock.calls[0][0];
    expect(call.doubles[2]).toBe(0);
  });
});

describe('classification helpers (unit)', () => {
  it('osName recognizes Windows, macOS, iOS, Android, Linux', () => {
    expect(osName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
    expect(osName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macOS');
    expect(osName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('iOS');
    expect(osName('Mozilla/5.0 (Linux; Android 14)')).toBe('Android');
    expect(osName('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux');
  });

  it('deviceType and browserName still classify correctly (regression guard)', () => {
    expect(deviceType('Mozilla/5.0 (Linux; Android 14)')).toBe('mobile');
    expect(browserName('Mozilla/5.0 Chrome/120.0')).toBe('Chrome');
  });

  it('isBot flags known crawler user agents', () => {
    expect(isBot('Googlebot/2.1')).toBe(true);
    expect(isBot('Mozilla/5.0 Chrome/120.0')).toBe(false);
  });
});

describe('query filters (parity with the main worker)', () => {
  it('parses a valid ?filter[os]= param into a SQL clause', () => {
    const url = new URL('https://worker.example.com/query?q=top-pages&filter[os]=Windows');
    expect(parseFilters(url)).toBe("AND blob13 = 'Windows'");
  });

  it('drops a filter value that fails its pattern', () => {
    const url = new URL('https://worker.example.com/query?q=top-pages&filter[country]=not-a-country-code');
    expect(parseFilters(url)).toBe('');
  });
});

describe('QUERY_TEMPLATES parity with the main worker', () => {
  it(
    'the CLI template offers every v0 query the main worker offers, minus documented exceptions',
    () => {
      const templateNames = new Set(Object.keys(TEMPLATE_QUERY_TEMPLATES));
      const missing = workerQueryNames.filter(
        (name) => !INTENTIONAL_WORKER_ONLY_QUERIES.includes(name) && !templateNames.has(name),
      );
      expect(missing, `template is missing worker queries: ${missing.join(', ')}`).toEqual([]);
    },
  );

  it('has no query the worker does not also have', () => {
    const workerNames = new Set(workerQueryNames);
    const extra = Object.keys(TEMPLATE_QUERY_TEMPLATES).filter((name) => !workerNames.has(name));
    expect(extra, `template has queries the worker no longer offers: ${extra.join(', ')}`).toEqual([]);
  });
});

describe('handleQuery — constant-time API key comparison', () => {
  function queryRequest(qs: string, apiKey?: string) {
    return new Request(`https://worker.example.com/query?${qs}`, {
      headers: apiKey ? { 'X-API-Key': apiKey } : {},
    });
  }

  it('rejects a wrong X-API-Key with 401', async () => {
    const env = makeEnv();
    const res = await worker.fetch(queryRequest('q=top-pages&site=example.com', 'nope'), env as any, {} as any);
    expect(res.status).toBe(401);
  });

  it('the "operating-systems" and revenue queries are registered and reachable', async () => {
    const env = makeEnv();
    // Missing period/site short-circuits before the network call for every
    // query name below, so this only asserts the name is recognized, not the
    // full 502 network round trip (which mocked fetch would require).
    for (const q of ['operating-systems', 'revenue-by-event', 'revenue-over-time']) {
      const res = await worker.fetch(queryRequest(`q=${q}`, 'super-secret-key'), env as any, {} as any);
      const json = (await res.json()) as { error?: string };
      expect(json.error).not.toBe('Invalid query');
    }
  });
});

describe('template source — no non-constant-time API key comparisons', () => {
  it('never compares an incoming key with a plain === / !== against env.QUERY_API_KEY', () => {
    expect(TEMPLATE_SOURCE).not.toMatch(/===\s*env\.QUERY_API_KEY/);
    expect(TEMPLATE_SOURCE).not.toMatch(/!==\s*env\.QUERY_API_KEY/);
  });

  it('gates the no-Origin path on X-API-Key before any Analytics Engine write', () => {
    expect(TEMPLATE_SOURCE).toMatch(/if \(!origin\) \{/);
    expect(TEMPLATE_SOURCE).toMatch(/timingSafeEqual\(incomingKey, env\.QUERY_API_KEY\)/);
  });
});
