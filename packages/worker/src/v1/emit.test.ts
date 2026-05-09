import { describe, it, expect, vi } from 'vitest';
import {
  PV_SCHEMA, ENG_SCHEMA, SHARE_SCHEMA, BOT_SCHEMA, CUSTOM_SCHEMA, CAPS,
  emitPageviewV1, emitEngagementV1, emitShareV1, emitBotV1, emitCustomV1,
} from './emit';

interface CapturedWrite {
  blobs: string[];
  doubles: number[];
  indexes: string[];
}

function makeDataset() {
  const calls: CapturedWrite[] = [];
  const ds: AnalyticsEngineDataset = {
    writeDataPoint: vi.fn((point: AnalyticsEngineDataPoint) => {
      calls.push({
        blobs: (point.blobs ?? []) as string[],
        doubles: (point.doubles ?? []) as number[],
        indexes: (point.indexes ?? []) as string[],
      });
    }),
  };
  return { ds, calls };
}

const byteLen = (s: string) => new TextEncoder().encode(s).length;

const baseKiiruPV = {
  site_id: 'kiiru.fi',
  canonical_url_hash: 'abc123def456',
  canonical_inferred: false,
  path: '/a/some-story',
  referrer_domain: 'bsky.app',
  referrer_url_hash: '999888777666',
  social_platform: 'bluesky',
  social_post_id: 'did:plc:abc/post/xyz',
  utm_source: 'bsky',
  utm_medium: 'social',
  utm_campaign: '2026-spring',
  visitor_hash: '0123456789abcdef',
  country: 'FI',
  device_type: 'desktop',
  browser: 'Chrome',
  bot_class: 'human',
  ai_actor: '',
  locale: '',
  content_type_hint: 'article',
  viewport_width: 1920,
  viewport_height: 1080,
};

describe('emitPageviewV1', () => {
  it('writes pv.v1.0 schema in blob1', () => {
    const { ds, calls } = makeDataset();
    expect(emitPageviewV1(ds, baseKiiruPV)).toBe(true);
    expect(calls[0].blobs[0]).toBe(PV_SCHEMA);
  });

  it('places site_id in blob2 and indexes', () => {
    const { ds, calls } = makeDataset();
    emitPageviewV1(ds, baseKiiruPV);
    expect(calls[0].blobs[1]).toBe('kiiru.fi');
    expect(calls[0].indexes[0]).toBe('kiiru.fi');
  });

  it('encodes canonical_inferred as "1" or empty string', () => {
    const { ds, calls } = makeDataset();
    emitPageviewV1(ds, baseKiiruPV);
    emitPageviewV1(ds, { ...baseKiiruPV, canonical_inferred: true });
    expect(calls[0].blobs[3]).toBe('');
    expect(calls[1].blobs[3]).toBe('1');
  });

  it('caps site_id to 64 bytes (index ceiling)', () => {
    const longSite = 'a'.repeat(200);
    const { ds, calls } = makeDataset();
    emitPageviewV1(ds, { ...baseKiiruPV, site_id: longSite });
    expect(byteLen(calls[0].blobs[1])).toBeLessThanOrEqual(CAPS.SITE_ID_BYTES);
    expect(byteLen(calls[0].indexes[0])).toBeLessThanOrEqual(CAPS.SITE_ID_BYTES);
  });

  it('caps path to 500 bytes', () => {
    const longPath = '/' + 'x'.repeat(900);
    const { ds, calls } = makeDataset();
    emitPageviewV1(ds, { ...baseKiiruPV, path: longPath });
    expect(byteLen(calls[0].blobs[4])).toBeLessThanOrEqual(CAPS.PATH_BYTES);
  });

  it('caps each utm field to 200 bytes', () => {
    const long = 'u'.repeat(500);
    const { ds, calls } = makeDataset();
    emitPageviewV1(ds, { ...baseKiiruPV, utm_source: long, utm_medium: long, utm_campaign: long });
    expect(byteLen(calls[0].blobs[9])).toBeLessThanOrEqual(CAPS.UTM_BYTES);
    expect(byteLen(calls[0].blobs[10])).toBeLessThanOrEqual(CAPS.UTM_BYTES);
    expect(byteLen(calls[0].blobs[11])).toBeLessThanOrEqual(CAPS.UTM_BYTES);
  });

  it('caps social_post_id to 80 bytes', () => {
    const long = 'p'.repeat(200);
    const { ds, calls } = makeDataset();
    emitPageviewV1(ds, { ...baseKiiruPV, social_post_id: long });
    expect(byteLen(calls[0].blobs[8])).toBeLessThanOrEqual(CAPS.SOCIAL_POST_ID_BYTES);
  });

  it('writes event_count + viewport doubles', () => {
    const { ds, calls } = makeDataset();
    emitPageviewV1(ds, baseKiiruPV);
    expect(calls[0].doubles).toEqual([1, 1920, 1080]);
  });

  it('returns false (and does not throw) on writeDataPoint failure', () => {
    const ds: AnalyticsEngineDataset = {
      writeDataPoint: vi.fn(() => { throw new Error('AE failure'); }),
    };
    expect(emitPageviewV1(ds, baseKiiruPV)).toBe(false);
  });
});

describe('emitEngagementV1', () => {
  const eng = {
    site_id: 'kiiru.fi',
    canonical_url_hash: 'abc123def456',
    path: '/a/foo',
    engagement_type: 'scroll_depth',
    visitor_hash: '0123456789abcdef',
    country: 'FI',
    scroll_depth: 75,
    engaged_seconds: 0,
  };

  it('writes eng.v1.0 schema', () => {
    const { ds, calls } = makeDataset();
    emitEngagementV1(ds, eng);
    expect(calls[0].blobs[0]).toBe(ENG_SCHEMA);
  });

  it('caps engagement_type to 16 bytes', () => {
    const { ds, calls } = makeDataset();
    emitEngagementV1(ds, { ...eng, engagement_type: 'x'.repeat(200) });
    expect(byteLen(calls[0].blobs[4])).toBeLessThanOrEqual(CAPS.ENGAGEMENT_TYPE_BYTES);
  });

  it('writes scroll_depth and engaged_seconds in doubles', () => {
    const { ds, calls } = makeDataset();
    emitEngagementV1(ds, { ...eng, scroll_depth: 50, engaged_seconds: 42 });
    expect(calls[0].doubles).toEqual([1, 50, 42]);
  });
});

describe('emitShareV1', () => {
  const sh = {
    site_id: 'kiiru.fi',
    canonical_url_hash: 'abc123def456',
    share_target_platform: 'bluesky',
    share_target_url_hash: '111222333444',
    share_target_post_id: '',
    share_id: '550e8400-e29b-41d4-a716-446655440000',
    visitor_hash: '0123456789abcdef',
    country: 'FI',
    device_type: 'desktop',
    browser: 'Chrome',
  };

  it('writes share.v1.0 schema', () => {
    const { ds, calls } = makeDataset();
    emitShareV1(ds, sh);
    expect(calls[0].blobs[0]).toBe(SHARE_SCHEMA);
  });

  it('caps share_target_platform to 16 bytes', () => {
    const { ds, calls } = makeDataset();
    emitShareV1(ds, { ...sh, share_target_platform: 'x'.repeat(200) });
    expect(byteLen(calls[0].blobs[3])).toBeLessThanOrEqual(CAPS.SHARE_PLATFORM_BYTES);
  });

  it('caps share_id to 36 bytes', () => {
    const { ds, calls } = makeDataset();
    emitShareV1(ds, { ...sh, share_id: 'x'.repeat(200) });
    expect(byteLen(calls[0].blobs[6])).toBeLessThanOrEqual(CAPS.SHARE_ID_BYTES);
  });
});

describe('emitBotV1', () => {
  const bot = {
    site_id: 'kiiru.fi',
    path: '/a/foo',
    bot_class: 'ai-crawler',
    ai_actor: 'chatgpt',
    user_agent: 'ChatGPT-User/1.0',
    country: 'US',
    referrer_domain: 'direct',
  };

  it('writes bot.v1.0 schema', () => {
    const { ds, calls } = makeDataset();
    emitBotV1(ds, bot);
    expect(calls[0].blobs[0]).toBe(BOT_SCHEMA);
  });

  it('caps user_agent to 80 bytes', () => {
    const ua = 'Mozilla/5.0 ' + 'x'.repeat(500);
    const { ds, calls } = makeDataset();
    emitBotV1(ds, { ...bot, user_agent: ua });
    expect(byteLen(calls[0].blobs[5])).toBeLessThanOrEqual(CAPS.USER_AGENT_BYTES);
  });

  it('caps bot_class and ai_actor', () => {
    const { ds, calls } = makeDataset();
    emitBotV1(ds, { ...bot, bot_class: 'x'.repeat(50), ai_actor: 'y'.repeat(100) });
    expect(byteLen(calls[0].blobs[3])).toBeLessThanOrEqual(CAPS.BOT_CLASS_BYTES);
    expect(byteLen(calls[0].blobs[4])).toBeLessThanOrEqual(CAPS.AI_ACTOR_BYTES);
  });
});

describe('emitCustomV1', () => {
  const cus = {
    site_id: 'kiiru.fi',
    canonical_url_hash: 'abc123def456',
    path: '/a/foo',
    event_name: 'newsletter_signup',
    event_props_json: '{"plan":"pro"}',
    visitor_hash: '0123456789abcdef',
    country: 'FI',
  };

  it('writes cust.v1.0 schema', () => {
    const { ds, calls } = makeDataset();
    emitCustomV1(ds, cus);
    expect(calls[0].blobs[0]).toBe(CUSTOM_SCHEMA);
  });

  it('caps event_name to 100 bytes and event_props_json to 1024', () => {
    const { ds, calls } = makeDataset();
    emitCustomV1(ds, {
      ...cus,
      event_name: 'x'.repeat(500),
      event_props_json: JSON.stringify({ k: 'y'.repeat(5000) }),
    });
    expect(byteLen(calls[0].blobs[4])).toBeLessThanOrEqual(CAPS.EVENT_NAME_BYTES);
    expect(byteLen(calls[0].blobs[5])).toBeLessThanOrEqual(CAPS.EVENT_PROPS_JSON_BYTES);
  });
});
