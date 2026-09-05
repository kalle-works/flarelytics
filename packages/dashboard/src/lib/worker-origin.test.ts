import { describe, it, expect } from 'vitest';
import { resolveWorkerOrigin } from './worker-origin';

describe('resolveWorkerOrigin', () => {
  it('accepts an https origin and strips any path or trailing slash', () => {
    expect(resolveWorkerOrigin('https://api.example.com/', '')).toBe('https://api.example.com');
    expect(resolveWorkerOrigin('https://api.example.com/query?x=1', '')).toBe('https://api.example.com');
  });

  it('rejects javascript: and data: values and falls back to the configured base', () => {
    expect(resolveWorkerOrigin('javascript:alert(1)//', 'https://api.flarelytics.dev')).toBe('https://api.flarelytics.dev');
    expect(resolveWorkerOrigin('data:text/html,hi', 'https://api.flarelytics.dev')).toBe('https://api.flarelytics.dev');
  });

  it('falls back when the param is missing or not a URL', () => {
    expect(resolveWorkerOrigin(null, 'https://api.flarelytics.dev/')).toBe('https://api.flarelytics.dev');
    expect(resolveWorkerOrigin('not a url', '')).toBe('');
  });
});
