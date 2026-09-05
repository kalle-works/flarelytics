import { describe, it, expect, vi } from 'vitest';
import { visitorHash, handleTrack } from './track';
import { handleTrackerJs } from './tracker-script';
import type { Env } from './env';

describe('visitorHash', () => {
  it('scopes the hash per-site: same ip/ua/date on two different sites produces different hashes', async () => {
    const env = { VISITOR_SALT: undefined, QUERY_API_KEY: 'shared-key' };
    const a = await visitorHash(env, '1.2.3.4', 'Mozilla/5.0', 'site-a.com');
    const b = await visitorHash(env, '1.2.3.4', 'Mozilla/5.0', 'site-b.com');
    expect(a).not.toBe(b);
  });

  it('changes when the salt changes (VISITOR_SALT overrides QUERY_API_KEY)', async () => {
    const withoutSalt = await visitorHash({ VISITOR_SALT: undefined, QUERY_API_KEY: 'key-1' }, '1.2.3.4', 'Mozilla/5.0', 'site-a.com');
    const withSalt = await visitorHash({ VISITOR_SALT: 'dedicated-salt', QUERY_API_KEY: 'key-1' }, '1.2.3.4', 'Mozilla/5.0', 'site-a.com');
    expect(withoutSalt).not.toBe(withSalt);
  });

  it('falls back to QUERY_API_KEY when VISITOR_SALT is unset (same hash as an explicit salt equal to the key)', async () => {
    const fallback = await visitorHash({ VISITOR_SALT: undefined, QUERY_API_KEY: 'key-1' }, '1.2.3.4', 'Mozilla/5.0', 'site-a.com');
    const explicit = await visitorHash({ VISITOR_SALT: 'key-1', QUERY_API_KEY: 'key-1' }, '1.2.3.4', 'Mozilla/5.0', 'site-a.com');
    expect(fallback).toBe(explicit);
  });
});

describe('handleTrackerJs', () => {
  it('serves the built tracker bundle with the worker origin as the default endpoint', async () => {
    const res = handleTrackerJs(new Request('https://api.example.com/tracker.js'));

    expect(res.headers.get('Content-Type')).toBe('application/javascript');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');

    const body = await res.text();
    expect(body).toContain('https://api.example.com');
    // The tracker's default-endpoint placeholder must be fully substituted —
    // a leftover placeholder means auto-init falls back to "no endpoint" and
    // a bare <script src=".../tracker.js"> with no data-endpoint silently
    // never sends anything.
    expect(body).not.toContain('__ENDPOINT__');
  });

  it('substitutes the requesting worker\'s own origin, not a hardcoded one', async () => {
    const res = handleTrackerJs(new Request('https://other-worker.example.net/tracker.js'));
    const body = await res.text();
    expect(body).toContain('https://other-worker.example.net');
    expect(body).not.toContain('https://api.example.com');
  });
});

describe('handleTrack — props serialization (blob5)', () => {
  function makeEnv(): Env {
    return {
      ANALYTICS: { writeDataPoint: vi.fn() },
      QUERY_API_KEY: 'test-key',
      ALLOWED_ORIGINS: '',
    } as unknown as Env;
  }

  function makeCtx(): ExecutionContext {
    return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  }

  it('escapes a literal "|" inside a prop value so it cannot desync the pipe-joined blob5 format', async () => {
    const env = makeEnv();
    const req = new Request('https://worker.test/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', 'X-API-Key': 'test-key' },
      body: JSON.stringify({
        event: 'share',
        path: '/post',
        site: 'example.com',
        props: { url: 'a|b', x: 'c' },
      }),
    });

    const res = await handleTrack(req, env, makeCtx());
    expect(res.status).toBe(204);

    const call = (env.ANALYTICS.writeDataPoint as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const blob5 = call.blobs[4];
    expect(blob5).toBe('a%7Cb|c');
  });
});
