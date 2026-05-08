import { describe, it, expect } from 'vitest';
import { parseReferrer, truncateUtf8 } from './index';

describe('parseReferrer', () => {
  it('parses bsky.app post URLs', () => {
    expect(parseReferrer('https://bsky.app/profile/alice.bsky.social/post/3kabc')).toEqual({
      social_platform: 'bluesky',
      social_post_id: 'alice.bsky.social/post/3kabc',
    });
  });

  it('parses l.facebook.com with story_fbid', () => {
    expect(
      parseReferrer('https://l.facebook.com/?u=https%3A%2F%2Fexample.com&story_fbid=1234567890')
    ).toEqual({ social_platform: 'facebook', social_post_id: '1234567890' });
  });

  it('parses m.facebook.com with story_fbid', () => {
    expect(parseReferrer('https://m.facebook.com/somepath?story_fbid=42')).toEqual({
      social_platform: 'facebook',
      social_post_id: '42',
    });
  });

  it('returns empty for facebook.com without story_fbid', () => {
    expect(parseReferrer('https://www.facebook.com/somepage')).toEqual({
      social_platform: '',
      social_post_id: '',
    });
  });

  it('parses Hacker News item URLs', () => {
    expect(parseReferrer('https://news.ycombinator.com/item?id=42000000')).toEqual({
      social_platform: 'hn',
      social_post_id: '42000000',
    });
  });

  it('parses reddit.com comment URLs (www subdomain)', () => {
    expect(
      parseReferrer('https://www.reddit.com/r/programming/comments/abc123/some_title/')
    ).toEqual({ social_platform: 'reddit', social_post_id: 'abc123' });
  });

  it('parses reddit.com comment URLs (old subdomain)', () => {
    expect(
      parseReferrer('https://old.reddit.com/r/programming/comments/abc123/some_title/')
    ).toEqual({ social_platform: 'reddit', social_post_id: 'abc123' });
  });

  it('parses reddit.com comment URLs (new subdomain)', () => {
    expect(
      parseReferrer('https://new.reddit.com/r/programming/comments/abc123/some_title/')
    ).toEqual({ social_platform: 'reddit', social_post_id: 'abc123' });
  });

  it('parses t.co with empty post_id (no HTTP resolve per decision 2A)', () => {
    expect(parseReferrer('https://t.co/Xyz123')).toEqual({
      social_platform: 'x',
      social_post_id: '',
    });
  });

  it('parses twitter.com status URLs', () => {
    expect(parseReferrer('https://twitter.com/dril/status/1234')).toEqual({
      social_platform: 'x',
      social_post_id: '1234',
    });
  });

  it('parses x.com status URLs', () => {
    expect(parseReferrer('https://x.com/dril/status/1234')).toEqual({
      social_platform: 'x',
      social_post_id: '1234',
    });
  });

  it('parses mastodon.social post URLs', () => {
    expect(parseReferrer('https://mastodon.social/@gargron/123456789')).toEqual({
      social_platform: 'mastodon',
      social_post_id: 'mastodon.social/123456789',
    });
  });

  it('parses Mastodon on a less-known instance', () => {
    expect(parseReferrer('https://hachyderm.io/@user/987654321')).toEqual({
      social_platform: 'mastodon',
      social_post_id: 'hachyderm.io/987654321',
    });
  });

  it('rejects Mastodon-shaped path with non-numeric post id', () => {
    expect(parseReferrer('https://mastodon.social/@user/notanid')).toEqual({
      social_platform: '',
      social_post_id: '',
    });
  });

  it('returns empty for empty string', () => {
    expect(parseReferrer('')).toEqual({ social_platform: '', social_post_id: '' });
  });

  it('returns empty for unparseable URL', () => {
    expect(parseReferrer('not a url')).toEqual({ social_platform: '', social_post_id: '' });
  });

  it('returns empty for unrecognized URLs', () => {
    expect(parseReferrer('https://example.com/foo')).toEqual({
      social_platform: '',
      social_post_id: '',
    });
  });

  it('preserves the original host (with no www-strip) for Mastodon post_id', () => {
    expect(parseReferrer('https://www.mastodon.example/@user/12345')).toEqual({
      social_platform: 'mastodon',
      social_post_id: 'www.mastodon.example/12345',
    });
  });

  it('truncates Mastodon post_id to <= 80 UTF-8 bytes when instance is long', () => {
    const longHost = 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.example.com';
    const url = `https://${longHost}/@user/9876543210`;
    const out = parseReferrer(url);
    expect(out.social_platform).toBe('mastodon');
    const bytes = new TextEncoder().encode(out.social_post_id).length;
    expect(bytes).toBeLessThanOrEqual(80);
    expect(bytes).toBeGreaterThan(70);
  });
});

describe('truncateUtf8', () => {
  it('returns input unchanged when within byte budget', () => {
    expect(truncateUtf8('hello', 80)).toBe('hello');
  });

  it('truncates ASCII at exact byte count', () => {
    const out = truncateUtf8('a'.repeat(100), 80);
    expect(out.length).toBe(80);
    expect(new TextEncoder().encode(out).length).toBe(80);
  });

  it('respects code-point boundaries for multi-byte chars (Cyrillic)', () => {
    const s = 'я'.repeat(50);
    const out = truncateUtf8(s, 11);
    const bytes = new TextEncoder().encode(out).length;
    expect(bytes).toBeLessThanOrEqual(11);
    expect(bytes % 2).toBe(0);
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(new TextEncoder().encode(out));
    expect(decoded).toBe(out);
    expect(out).not.toContain('�');
  });

  it('respects code-point boundaries for emoji (4-byte sequences)', () => {
    const s = '🌍'.repeat(20);
    const out = truncateUtf8(s, 10);
    const bytes = new TextEncoder().encode(out).length;
    expect(bytes).toBeLessThanOrEqual(10);
    expect(bytes % 4).toBe(0);
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(new TextEncoder().encode(out));
    expect(decoded).toBe(out);
    expect(out).not.toContain('�');
  });

  it('returns empty string when budget is smaller than first code point', () => {
    expect(truncateUtf8('🌍foo', 3)).toBe('');
  });
});
