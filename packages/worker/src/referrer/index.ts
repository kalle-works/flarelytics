const MAX_POST_ID_BYTES = 80;

const STRIP_PREFIXES = ['www.', 'm.', 'mobile.', 'old.', 'new.'];

export function truncateUtf8(s: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(s).length <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const chBytes = encoder.encode(ch).length;
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

function stripPrefix(host: string): string {
  for (const p of STRIP_PREFIXES) {
    if (host.startsWith(p)) return host.slice(p.length);
  }
  return host;
}

function empty(): { social_platform: string; social_post_id: string } {
  return { social_platform: '', social_post_id: '' };
}

function result(platform: string, postId: string): { social_platform: string; social_post_id: string } {
  return { social_platform: platform, social_post_id: truncateUtf8(postId, MAX_POST_ID_BYTES) };
}

export function parseReferrer(url: string): { social_platform: string; social_post_id: string } {
  if (!url) return empty();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return empty();
  }

  const originalHost = u.hostname.toLowerCase();
  const host = stripPrefix(originalHost);
  const path = u.pathname;

  if (host === 'bsky.app') {
    const m = path.match(/^\/profile\/([^/]+)\/post\/([^/]+)\/?$/);
    if (m) return result('bluesky', `${m[1]}/post/${m[2]}`);
    return empty();
  }

  if (originalHost === 'l.facebook.com' || originalHost.endsWith('.facebook.com') || originalHost === 'facebook.com') {
    const storyId = u.searchParams.get('story_fbid');
    if (storyId) return result('facebook', storyId);
    return empty();
  }

  if (host === 'news.ycombinator.com') {
    if (path === '/item') {
      const id = u.searchParams.get('id');
      if (id) return result('hn', id);
    }
    return empty();
  }

  if (host === 'reddit.com') {
    const m = path.match(/^\/r\/[^/]+\/comments\/([^/]+)(?:\/|$)/);
    if (m) return result('reddit', m[1]);
    return empty();
  }

  if (originalHost === 't.co') {
    return result('x', '');
  }

  if (host === 'twitter.com' || host === 'x.com') {
    const m = path.match(/^\/[^/]+\/status\/(\d+)\/?$/);
    if (m) return result('x', m[1]);
    return empty();
  }

  const masto = path.match(/^\/@[^/]+\/(\d+)\/?$/);
  if (masto) return result('mastodon', `${originalHost}/${masto[1]}`);

  return empty();
}
