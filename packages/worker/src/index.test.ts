import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, { isBot, deviceType, browserName } from './index';

function makeEnv(overrides: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  return {
    ANALYTICS: { writeDataPoint: vi.fn() },
    SITE_CONFIG: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    } as unknown as KVNamespace,
    ALLOWED_ORIGINS: 'https://example.com',
    QUERY_API_KEY: 'test-key',
    CF_ACCOUNT_ID: '',
    CF_API_TOKEN: '',
    DATASET_NAME: 'test',
    ...overrides,
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
