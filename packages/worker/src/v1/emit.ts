/**
 * v1 dataset emit helpers — one function per event family per MIGRATION_PLAN.md §3.
 *
 * Each helper:
 *   - Stamps schema_version in blob1 (exact match per §5 Codex #11 fix)
 *   - Caps every blob to its locked byte budget (§3 + §9 Task A)
 *   - Slices site_id to ≤ 64 bytes for the index slot (empirical 96B AE ceiling)
 *   - Wraps writeDataPoint in try/catch — caller decides what to log on failure
 *
 * Returns true on success, false on failure. Callers in /track use this to keep
 * legacy emission unaffected when v1 fails (see §11 failsafe test).
 */

import { truncateUtf8 } from '../referrer/index';

// Schema versions — bump in lockstep with the schema tables in §3.
export const PV_SCHEMA = 'pv.v1.0';
export const ENG_SCHEMA = 'eng.v1.0';
export const SHARE_SCHEMA = 'share.v1.0';
export const BOT_SCHEMA = 'bot.v1.0';
export const CUSTOM_SCHEMA = 'cust.v1.0';

// Per §3: site_id index ≤ 64 bytes (empirical 96B AE index ceiling, §9 Task A4).
const SITE_ID_BYTES = 64;
const PATH_BYTES = 500;
const REFERRER_DOMAIN_BYTES = 80;
const SOCIAL_PLATFORM_BYTES = 16;
const SOCIAL_POST_ID_BYTES = 80;
const UTM_BYTES = 200;
const COUNTRY_BYTES = 4;
const DEVICE_BYTES = 16;
const BROWSER_BYTES = 32;
const BOT_CLASS_BYTES = 16;
const AI_ACTOR_BYTES = 32;
const LOCALE_BYTES = 16;
const CONTENT_TYPE_HINT_BYTES = 32;
const ENGAGEMENT_TYPE_BYTES = 16;
const SHARE_PLATFORM_BYTES = 16;
const SHARE_ID_BYTES = 36;
const EVENT_NAME_BYTES = 100;
const EVENT_PROPS_JSON_BYTES = 1024;
const USER_AGENT_BYTES = 80;
// canonical_url_hash, referrer_url_hash, share_target_url_hash are always 12 hex
// chars (caller-controlled). schema_version is a constant ≤ 16 bytes. visitor_hash
// is always 16 hex chars from existing v0 visitorHash(). canonical_inferred is
// '1' or '' — both ≤ 1 byte. No truncation needed for those.

function trunc(value: string | undefined, maxBytes: number): string {
  if (!value) return '';
  return truncateUtf8(value, maxBytes);
}

function siteIndex(siteId: string): string {
  return trunc(siteId, SITE_ID_BYTES);
}

export interface PageviewV1Params {
  site_id: string;
  canonical_url_hash: string;
  canonical_inferred: boolean;
  path: string;
  referrer_domain: string;
  referrer_url_hash: string;
  social_platform: string;
  social_post_id: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  visitor_hash: string;
  country: string;
  device_type: string;
  browser: string;
  bot_class: string;
  ai_actor: string;
  locale: string;
  content_type_hint: string;
  viewport_width: number;
  viewport_height: number;
}

export function emitPageviewV1(ds: AnalyticsEngineDataset, p: PageviewV1Params): boolean {
  try {
    ds.writeDataPoint({
      blobs: [
        PV_SCHEMA,                                         // blob1
        trunc(p.site_id, SITE_ID_BYTES),                   // blob2
        p.canonical_url_hash,                              // blob3
        p.canonical_inferred ? '1' : '',                   // blob4
        trunc(p.path, PATH_BYTES),                         // blob5
        trunc(p.referrer_domain, REFERRER_DOMAIN_BYTES),   // blob6
        p.referrer_url_hash,                               // blob7
        trunc(p.social_platform, SOCIAL_PLATFORM_BYTES),   // blob8
        trunc(p.social_post_id, SOCIAL_POST_ID_BYTES),     // blob9
        trunc(p.utm_source, UTM_BYTES),                    // blob10
        trunc(p.utm_medium, UTM_BYTES),                    // blob11
        trunc(p.utm_campaign, UTM_BYTES),                  // blob12
        p.visitor_hash,                                    // blob13
        trunc(p.country, COUNTRY_BYTES),                   // blob14
        trunc(p.device_type, DEVICE_BYTES),                // blob15
        trunc(p.browser, BROWSER_BYTES),                   // blob16
        trunc(p.bot_class, BOT_CLASS_BYTES),               // blob17
        trunc(p.ai_actor, AI_ACTOR_BYTES),                 // blob18
        trunc(p.locale, LOCALE_BYTES),                     // blob19
        trunc(p.content_type_hint, CONTENT_TYPE_HINT_BYTES), // blob20
      ],
      doubles: [1, p.viewport_width || 0, p.viewport_height || 0],
      indexes: [siteIndex(p.site_id)],
    });
    return true;
  } catch {
    return false;
  }
}

export interface EngagementV1Params {
  site_id: string;
  canonical_url_hash: string;
  path: string;
  /** 'scroll_depth' | 'timing' | 'read_complete' */
  engagement_type: string;
  visitor_hash: string;
  country: string;
  /** 0–100 for scroll_depth, otherwise 0 */
  scroll_depth: number;
  /** seconds for timing, otherwise 0 */
  engaged_seconds: number;
}

export function emitEngagementV1(ds: AnalyticsEngineDataset, p: EngagementV1Params): boolean {
  try {
    ds.writeDataPoint({
      blobs: [
        ENG_SCHEMA,
        trunc(p.site_id, SITE_ID_BYTES),
        p.canonical_url_hash,
        trunc(p.path, PATH_BYTES),
        trunc(p.engagement_type, ENGAGEMENT_TYPE_BYTES),
        p.visitor_hash,
        trunc(p.country, COUNTRY_BYTES),
      ],
      doubles: [1, p.scroll_depth || 0, p.engaged_seconds || 0],
      indexes: [siteIndex(p.site_id)],
    });
    return true;
  } catch {
    return false;
  }
}

export interface ShareV1Params {
  site_id: string;
  canonical_url_hash: string;
  share_target_platform: string;
  share_target_url_hash: string;
  share_target_post_id: string;
  share_id: string;
  visitor_hash: string;
  country: string;
  device_type: string;
  browser: string;
}

export function emitShareV1(ds: AnalyticsEngineDataset, p: ShareV1Params): boolean {
  try {
    ds.writeDataPoint({
      blobs: [
        SHARE_SCHEMA,
        trunc(p.site_id, SITE_ID_BYTES),
        p.canonical_url_hash,
        trunc(p.share_target_platform, SHARE_PLATFORM_BYTES),
        p.share_target_url_hash,
        trunc(p.share_target_post_id, SOCIAL_POST_ID_BYTES),
        trunc(p.share_id, SHARE_ID_BYTES),
        p.visitor_hash,
        trunc(p.country, COUNTRY_BYTES),
        trunc(p.device_type, DEVICE_BYTES),
        trunc(p.browser, BROWSER_BYTES),
      ],
      doubles: [1],
      indexes: [siteIndex(p.site_id)],
    });
    return true;
  } catch {
    return false;
  }
}

export interface BotV1Params {
  site_id: string;
  path: string;
  bot_class: string;
  ai_actor: string;
  user_agent: string;
  country: string;
  referrer_domain: string;
}

export function emitBotV1(ds: AnalyticsEngineDataset, p: BotV1Params): boolean {
  try {
    ds.writeDataPoint({
      blobs: [
        BOT_SCHEMA,
        trunc(p.site_id, SITE_ID_BYTES),
        trunc(p.path, PATH_BYTES),
        trunc(p.bot_class, BOT_CLASS_BYTES),
        trunc(p.ai_actor, AI_ACTOR_BYTES),
        trunc(p.user_agent, USER_AGENT_BYTES),
        trunc(p.country, COUNTRY_BYTES),
        trunc(p.referrer_domain, REFERRER_DOMAIN_BYTES),
      ],
      doubles: [1],
      indexes: [siteIndex(p.site_id)],
    });
    return true;
  } catch {
    return false;
  }
}

export interface CustomV1Params {
  site_id: string;
  canonical_url_hash: string;
  path: string;
  event_name: string;
  event_props_json: string;
  visitor_hash: string;
  country: string;
}

/**
 * Custom event emit. Per §3, the worker rejects oversized event_props_json with
 * 400 rather than truncating mid-JSON (truncated JSON is unparsable). The size
 * check itself happens in the caller (handleTrack) before this function is
 * invoked; here we only enforce the byte cap as a safety net.
 */
export function emitCustomV1(ds: AnalyticsEngineDataset, p: CustomV1Params): boolean {
  try {
    ds.writeDataPoint({
      blobs: [
        CUSTOM_SCHEMA,
        trunc(p.site_id, SITE_ID_BYTES),
        p.canonical_url_hash,
        trunc(p.path, PATH_BYTES),
        trunc(p.event_name, EVENT_NAME_BYTES),
        trunc(p.event_props_json, EVENT_PROPS_JSON_BYTES),
        p.visitor_hash,
        trunc(p.country, COUNTRY_BYTES),
      ],
      doubles: [1],
      indexes: [siteIndex(p.site_id)],
    });
    return true;
  } catch {
    return false;
  }
}

// Byte-cap constants exported for use in tests and dual-emit-callers that need
// to validate input before passing it through.
export const CAPS = {
  SITE_ID_BYTES,
  PATH_BYTES,
  REFERRER_DOMAIN_BYTES,
  SOCIAL_PLATFORM_BYTES,
  SOCIAL_POST_ID_BYTES,
  UTM_BYTES,
  COUNTRY_BYTES,
  DEVICE_BYTES,
  BROWSER_BYTES,
  BOT_CLASS_BYTES,
  AI_ACTOR_BYTES,
  LOCALE_BYTES,
  CONTENT_TYPE_HINT_BYTES,
  ENGAGEMENT_TYPE_BYTES,
  SHARE_PLATFORM_BYTES,
  SHARE_ID_BYTES,
  EVENT_NAME_BYTES,
  EVENT_PROPS_JSON_BYTES,
  USER_AGENT_BYTES,
} as const;
