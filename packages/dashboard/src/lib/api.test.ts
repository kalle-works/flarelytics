import { describe, it, expect, vi } from 'vitest';
import { fetchJson, buildQueryUrl, AuthError, QueryError } from './api';

function fakeResponse(status: number, body: unknown, ok = status >= 200 && status < 300): Response {
  return {
    status,
    ok,
    json: async () => body,
  } as Response;
}

describe('fetchJson', () => {
  it('throws AuthError with status 401 on an unauthorized response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(401, {}));
    await expect(fetchJson('https://api.example/query', { fetchImpl })).rejects.toMatchObject({
      name: 'AuthError',
      status: 401,
    });
  });

  it('throws AuthError with status 403 on a forbidden response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(403, {}));
    await expect(fetchJson('https://api.example/query', { fetchImpl })).rejects.toMatchObject({
      name: 'AuthError',
      status: 403,
    });
  });

  it('throws QueryError (not AuthError) on a 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(500, {}));
    await expect(fetchJson('https://api.example/query', { fetchImpl })).rejects.toBeInstanceOf(QueryError);
  });

  it('throws QueryError on a network failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(fetchJson('https://api.example/query', { fetchImpl })).rejects.toBeInstanceOf(QueryError);
  });

  it('resolves with the parsed JSON body on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(200, { data: [1, 2, 3] }));
    await expect(fetchJson('https://api.example/query', { fetchImpl })).resolves.toEqual({ data: [1, 2, 3] });
  });

  it('is not an instance of QueryError when it is an AuthError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse(401, {}));
    try {
      await fetchJson('https://api.example/query', { fetchImpl });
      throw new Error('expected fetchJson to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthError);
      expect(e).not.toBeInstanceOf(QueryError);
    }
  });
});

describe('buildQueryUrl', () => {
  it('builds a base query URL with q/period/site', () => {
    const url = buildQueryUrl('https://api.example', 'top-pages', { period: '7d', site: 'foo.com' });
    expect(url).toBe('https://api.example/query?q=top-pages&period=7d&site=foo.com');
  });

  it('appends filter[key]=value pairs in filter[...] form', () => {
    const url = buildQueryUrl('https://api.example', 'top-pages', {
      period: '7d',
      site: 'foo.com',
      filters: { country: 'FI' },
    });
    expect(url).toContain('&filter%5Bcountry%5D=FI');
  });

  it('merges extra params (e.g. page) before filters', () => {
    const url = buildQueryUrl('https://api.example', 'referrers-by-page', {
      period: '30d',
      site: 'foo.com',
      extra: { page: '/a/x' },
    });
    expect(url).toContain('page=%2Fa%2Fx');
  });
});
