import { describe, it, expect } from 'vitest';
import { parseUrlState, withUrlState } from './url-state';

describe('parseUrlState', () => {
  it('reads site and period from the query string', () => {
    expect(parseUrlState('?site=foo.com&period=30d')).toEqual({ site: 'foo.com', period: '30d' });
  });

  it('rejects an unrecognized period rather than passing it through', () => {
    expect(parseUrlState('?period=1337d').period).toBeNull();
  });

  it('returns nulls when nothing is present', () => {
    expect(parseUrlState('')).toEqual({ site: null, period: null });
  });
});

describe('withUrlState', () => {
  it('adds site and period without disturbing other params', () => {
    const qs = withUrlState('?worker=http://localhost:8787', { site: 'foo.com', period: '90d' });
    const usp = new URLSearchParams(qs);
    expect(usp.get('worker')).toBe('http://localhost:8787');
    expect(usp.get('site')).toBe('foo.com');
    expect(usp.get('period')).toBe('90d');
  });

  it('leaves an existing param untouched when the new value is falsy', () => {
    const qs = withUrlState('?site=old.com', { site: null, period: '7d' });
    expect(new URLSearchParams(qs).get('site')).toBe('old.com');
  });
});
