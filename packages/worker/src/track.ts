/**
 * POST /track ingestion: origin/API-key auth, bot filtering, payload
 * normalization, the legacy (v0) Analytics Engine write, and the Phase 0.5
 * v0→v1 dual-emit for the Kiiru pilot.
 */
import { parseReferrer } from './referrer/index';
import { classifyUserAgent } from './classifier/index';
import { normalizeCanonicalUrl, canonicalUrlHash, referrerUrlHash } from './v1/canonical';
import {
  emitPageviewV1,
  emitEngagementV1,
  emitShareV1,
  emitBotV1,
  emitCustomV1,
} from './v1/emit';
import type { Env } from './env';
import { deviceType, browserName, osName } from './ua';
import { fetchAllowedOrigins, corsHeaders } from './cors';
import { timingSafeEqual, hmacSha256 } from './auth/crypto';

// Phase 0.5 dual-emit allowlist. Hardcoded to Kiiru per MIGRATION_PLAN.md §4
// "Phase 0.5 (Day 0 — Day 21) — Pilot validation on Kiiru only (T2A)".
// Other sites continue writing only to v0. Phase 1 expands this to the KV
// allowlist (§4 Phase 1).
const V1_EMIT_SITES = new Set(['kiiru.fi']);

// Reject /track bodies larger than this before parsing — checked against
// Content-Length when present, and enforced on the actual byte stream either
// way so a client that omits/lies about Content-Length can't force the worker
// to buffer and parse an arbitrarily large payload.
const MAX_TRACK_BODY_BYTES = 8192;

export interface TrackPayload {
  /** Event name: 'pageview', 'outbound', or any custom event name */
  event: string;
  /** Page path (required) */
  path: string;
  /** Referrer hostname */
  referrer?: string;
  /** Event-specific properties (key-value pairs) */
  props?: Record<string, string>;
  /** UTM params */
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  /** Tracker-resolved canonical URL (Phase 0.5 opt-in via data-emit-canonical) */
  canonical_url?: string;
  /** Revenue / conversion value — stored in double3, used by revenue-by-event query */
  value?: number;
  /** Site hostname for server-side tracking (no Origin header) — required when X-API-Key is used */
  site?: string;
}

// Legacy short-form payload (backwards compatible with mailtoolfinder format)
export interface LegacyPayload {
  e: string;
  p: string;
  r?: string;
  t?: string;
  d?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}

// Delegates to the v1 classifier so there is a single bot pattern list
// (v0 previously carried its own drifting, naive substring-only copy — see
// classifier/index.ts for the token-boundary matching that avoids false
// positives like `gptbotmalicious` matching `gptbot`).
export function isBot(ua: string): boolean {
  if (!ua) return true;
  return classifyUserAgent(ua).bot_class !== 'human';
}

/**
 * Daily-rotating visitor hash. GDPR-friendly: no raw IP stored, and scoped
 * per-site so the same physical visitor doesn't hash to the same blob9 value
 * across two unrelated tenant sites — without the site component, anyone
 * reading the raw Analytics Engine dataset (e.g. via CF_API_TOKEN) could
 * correlate one visitor's traffic across tenants.
 *
 * HMAC-SHA256 keyed by the salt, truncated to 8 bytes (16 hex chars) so
 * blob9 keeps its historical shape.
 *
 * Salt defaults to QUERY_API_KEY when VISITOR_SALT is unset so existing
 * deployments keep working without provisioning a new secret. Rotating the
 * salt (or setting VISITOR_SALT for the first time) changes every hash going
 * forward — expected, since the hash already rotates daily; the day of the
 * change will double-count returning visitors as new for that one day.
 */
export async function visitorHash(env: Pick<Env, 'VISITOR_SALT' | 'QUERY_API_KEY'>, ip: string, ua: string, site: string): Promise<string> {
  const salt = env.VISITOR_SALT ?? env.QUERY_API_KEY ?? '';
  const date = new Date().toISOString().slice(0, 10);
  const mac = await hmacSha256(salt, `${ip}:${ua}:${site}:${date}`);
  return Array.from(mac.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Normalize payload: accept both new format and legacy short-form */
export function normalizePayload(raw: TrackPayload | LegacyPayload): TrackPayload {
  if ('event' in raw && 'path' in raw) {
    return raw as TrackPayload;
  }
  const legacy = raw as LegacyPayload;
  const EVENT_MAP: Record<string, string> = {
    pv: 'pageview', ac: 'affiliate_click', ns: 'newsletter_signup',
    qc: 'quiz_complete', bl: 'blog_engagement', ol: 'outbound',
  };
  return {
    event: EVENT_MAP[legacy.e] || legacy.e,
    path: legacy.p,
    referrer: legacy.r,
    props: {
      ...(legacy.t ? { tool: legacy.t } : {}),
      ...(legacy.d ? { data: legacy.d } : {}),
    },
    utm_source: legacy.utm_source,
    utm_medium: legacy.utm_medium,
    utm_campaign: legacy.utm_campaign,
  };
}

/**
 * Resolve the canonical URL hash and inferred-flag for a tracked event.
 *
 * - If the tracker sent a normalize-able canonical_url, hash that and flag = false.
 * - Otherwise reconstruct from Origin + path, hash that, flag = true. This gives
 *   a stable per-URL grouping key even before sites opt into emitCanonical.
 *
 * Returns the hash and the inferred flag. Hash is empty string if neither input
 * normalizes (e.g. unknown protocol) — caller should treat that as "skip v1".
 */
async function resolveCanonical(
  rawCanonical: string | undefined,
  origin: string | null,
  path: string,
): Promise<{ hash: string; inferred: boolean }> {
  if (typeof rawCanonical === 'string' && rawCanonical !== '') {
    const normalized = normalizeCanonicalUrl(rawCanonical);
    if (normalized) {
      return { hash: await canonicalUrlHash(normalized), inferred: false };
    }
  }
  if (origin) {
    const inferred = normalizeCanonicalUrl(`${origin}${path}`);
    if (inferred) {
      return { hash: await canonicalUrlHash(inferred), inferred: true };
    }
  }
  return { hash: '', inferred: true };
}

/**
 * Read the request body up to `maxBytes`, checking `Content-Length` first (a
 * cheap rejection before reading anything) and then the actual byte stream
 * (so a missing/understated Content-Length can't bypass the cap). Returns
 * `null` when the body exceeds the cap.
 */
async function readCappedBody(request: Request, maxBytes: number): Promise<string | null> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && Number(contentLength) > maxBytes) return null;

  if (!request.body) return request.text();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* already closing */ }
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export async function handleTrack(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const origin = request.headers.get('Origin');

  // Server-side tracking: no Origin header → require X-API-Key for auth.
  // This prevents unauthenticated server-to-server event injection.
  if (!origin) {
    const incomingKey = request.headers.get('X-API-Key');
    if (!incomingKey || !env.QUERY_API_KEY || !timingSafeEqual(incomingKey, env.QUERY_API_KEY)) {
      return Response.json(
        { error: 'Unauthorized', hint: 'Server-side tracking requires X-API-Key header with your QUERY_API_KEY. Include a "site" field in the payload to identify the site.' },
        { status: 401 },
      );
    }
  }

  const allowed = await fetchAllowedOrigins(env);
  const cors = corsHeaders(origin, allowed);

  if (origin && !allowed.includes(origin)) {
    return Response.json({ error: 'Forbidden', hint: 'Origin not in allowed list. Add it via POST /admin/sites or ALLOWED_ORIGINS in wrangler.toml.' }, { status: 403, headers: cors });
  }

  const bodyText = await readCappedBody(request, MAX_TRACK_BODY_BYTES);
  if (bodyText === null) {
    return Response.json(
      { error: 'Payload Too Large', hint: `Request body must not exceed ${MAX_TRACK_BODY_BYTES} bytes.` },
      { status: 413, headers: cors },
    );
  }

  const ua = request.headers.get('User-Agent') || '';
  if (isBot(ua)) {
    // Record bot hit for reporting, then drop
    const botOrigin = request.headers.get('Origin');
    const botSite = botOrigin ? (() => { try { return new URL(botOrigin).hostname.replace(/^www\./, ''); } catch { return botOrigin; } })() : '';
    let botPath = '/';
    let botReferrer = '';
    try {
      const botBody = JSON.parse(bodyText) as { path?: string; p?: string; referrer?: string; r?: string };
      botPath = (botBody.path || botBody.p || '/').replace(/\/+$/, '').slice(0, 500) || '/';
      botReferrer = (botBody.referrer || botBody.r || '').slice(0, 500);
    } catch { /* ignore parse errors */ }
    const country = (request.cf?.country as string) || 'XX';

    try {
      env.ANALYTICS.writeDataPoint({
        blobs: [
          botPath,           // blob1: path
          '',                // blob2: referrer (not relevant)
          country,           // blob3: country
          'bot_hit',         // blob4: event name
          ua.slice(0, 200),  // blob5: user-agent string as prop
          '', '', '', '',    // blob6-9: unused
          botSite,           // blob10: site hostname
          '', '',            // blob11-12: unused
        ],
        doubles: [1, 0],
        indexes: [botPath],
      });
    } catch (err) {
      console.log(`[track] legacy bot write failed: ${err}`);
    }

    if (V1_EMIT_SITES.has(botSite)) {
      // ctx.waitUntil keeps the worker alive for the v1 write after the 204
      // ships back. The classifier + emit are both sync-fast (regex + a single
      // writeDataPoint enqueue), so the wrapping promise resolves immediately;
      // we use waitUntil for symmetry with the pageview path's async emit.
      ctx.waitUntil((async () => {
        try {
          const cls = classifyUserAgent(ua);
          emitBotV1(env.BOT_EVENTS, {
            site_id: botSite,
            path: botPath,
            bot_class: cls.bot_class,
            ai_actor: cls.ai_actor,
            user_agent: ua,
            country,
            referrer_domain: botReferrer,
          });
        } catch (err) {
          console.log(`[track] v1 bot emit failed: ${err}`);
        }
      })());
    }

    return new Response(null, { status: 204, headers: cors });
  }

  let raw: TrackPayload | LegacyPayload;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return Response.json({ error: 'Bad Request', hint: 'POST body must be valid JSON with "event" and "path" fields.' }, { status: 400, headers: cors });
  }

  const body = normalizePayload(raw);

  if (!body.path || typeof body.path !== 'string') {
    return Response.json({ error: 'Bad Request', hint: 'Missing "path" field. Example: { "event": "pageview", "path": "/pricing" }' }, { status: 400, headers: cors });
  }
  if (!body.event || typeof body.event !== 'string') {
    return Response.json({ error: 'Bad Request', hint: 'Missing "event" field. Example: { "event": "pageview", "path": "/" }' }, { status: 400, headers: cors });
  }

  const path = body.path.replace(/\/+$/, '').slice(0, 500) || '/';
  const eventName = body.event.slice(0, 100);
  const country = (request.cf?.country as string) || 'XX';
  // v0's blob5 is a positional pipe-joined string (the dashboard parses it
  // by index, e.g. `share` events' url prop). A literal `|` inside a value
  // — legal in a URL query string or fragment — would otherwise desync that
  // positional parsing, so escape it before joining. `%7C` mirrors how a
  // URL-encoded pipe already looks, so an escaped value round-trips the same
  // way a real encoded pipe would if it appeared in, say, a URL prop.
  const propValue = body.props
    ? Object.values(body.props).map((v) => String(v).replace(/\|/g, '%7C')).join('|').slice(0, 200)
    : '';

  // Derive site early so we can preflight v1-only constraints.
  // For server-side requests (no Origin), use body.site with hostname validation.
  const site = origin
    ? (() => { try { return new URL(origin).hostname.replace(/^www\./, ''); } catch { return origin; } })()
    : (() => {
        const s = typeof body.site === 'string' ? body.site.trim().replace(/^www\./, '') : '';
        return /^[a-zA-Z0-9.\-]+$/.test(s) ? s : '';
      })();

  // Custom event preflight (§3 / §11 contract): for sites in V1_EMIT_SITES,
  // reject oversize event_props_json with 400 rather than silently truncating
  // mid-JSON (truncated JSON is unparsable at read time). Non-pilot sites keep
  // v0's silent-truncation behavior for backwards compatibility.
  const RESERVED_EVENTS = new Set(['pageview', 'timing', 'scroll_depth', 'outbound', 'bot_hit']);
  if (V1_EMIT_SITES.has(site) && !RESERVED_EVENTS.has(eventName) && body.props) {
    const propsJson = JSON.stringify(body.props);
    const propsBytes = new TextEncoder().encode(propsJson).length;
    if (propsBytes > 1024) {
      return Response.json(
        { error: 'event_props_json exceeds 1024 byte limit', hint: `Sent ${propsBytes} bytes; maximum is 1024. Trim or split the props object.` },
        { status: 400, headers: cors },
      );
    }
  }

  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const vid = await visitorHash(env, ip, ua, site);

  // If referrer hostname matches the site itself, treat as direct (internal navigation)
  const rawReferrer = (body.referrer || 'direct').slice(0, 500);
  const referrer = rawReferrer === site ? 'direct' : rawReferrer;

  // For timing events, extract seconds into double2 for AVG queries
  const timingSeconds = eventName === 'timing' ? (parseFloat(body.props?.seconds || '0') || 0) : 0;
  // Revenue value (double3) — only for custom events with a numeric value field
  const revenueValue = typeof body.value === 'number' && isFinite(body.value) && body.value >= 0 ? body.value : 0;
  const device = deviceType(ua);
  const browser = browserName(ua);
  const os = osName(ua);

  // Legacy v0 write — wrapped so a v0 failure does not block v1 dual-emit.
  try {
    env.ANALYTICS.writeDataPoint({
      blobs: [
        path,                                      // blob1: path
        referrer,                                  // blob2: referrer
        country,                                   // blob3: country
        eventName,                                 // blob4: event name
        propValue,                                 // blob5: event properties
        (body.utm_source || '').slice(0, 200),     // blob6: utm_source
        (body.utm_medium || '').slice(0, 200),     // blob7: utm_medium
        (body.utm_campaign || '').slice(0, 200),   // blob8: utm_campaign
        vid,                                       // blob9: visitor_id
        site,                                      // blob10: site hostname
        device,                                    // blob11: device type (mobile/tablet/desktop)
        browser,                                   // blob12: browser name
        os,                                        // blob13: operating system
      ],
      doubles: [1, timingSeconds, revenueValue],  // double1: count, double2: timing seconds, double3: revenue value
      indexes: [path],
    });
  } catch (err) {
    console.log(`[track] legacy write failed: ${err}`);
  }

  // Phase 0.5 dual-emit (Kiiru only). Per MIGRATION_PLAN §4 Phase 1 risk gate,
  // v1 emit runs in ctx.waitUntil so the response ships back before the
  // canonical hash + AE writes complete. Client p99 sees only the legacy-write
  // path, which preserves the §9 Task B baseline (~18 ms p99). The v1 emit
  // block stays best-effort and is wrapped in try/catch so any failure logs
  // and drops without surfacing — AE rows are always recoverable from the
  // legacy write during migration.
  if (V1_EMIT_SITES.has(site)) {
    const canonicalRaw = (raw as TrackPayload).canonical_url;
    ctx.waitUntil((async () => {
      try {
        const { hash: canonicalHash, inferred: canonicalInferred } = await resolveCanonical(
          canonicalRaw,
          origin,
          path,
        );
        const refUrlHash = referrer === 'direct' ? '' : await referrerUrlHash(referrer);
        // Build a synthetic absolute URL for parseReferrer (which expects http/https).
        // Tracker only sends referrer hostname, so parseReferrer's path-aware rules
        // (e.g. /profile/X/post/Y) will only match if a future tracker change emits
        // the full referrer URL. Today this resolves to empty platform for all
        // hostname-only referrers, which is correct.
        const refForParse = referrer === 'direct' ? '' : `https://${referrer}`;
        const social = parseReferrer(refForParse);
        const cls = classifyUserAgent(ua);

        switch (eventName) {
          case 'pageview':
            emitPageviewV1(env.PAGEVIEW_EVENTS, {
              site_id: site,
              canonical_url_hash: canonicalHash,
              canonical_inferred: canonicalInferred,
              path,
              referrer_domain: referrer,
              referrer_url_hash: refUrlHash,
              social_platform: social.social_platform,
              social_post_id: social.social_post_id,
              utm_source: body.utm_source || '',
              utm_medium: body.utm_medium || '',
              utm_campaign: body.utm_campaign || '',
              visitor_hash: vid,
              country,
              device_type: device,
              browser,
              bot_class: cls.bot_class,
              ai_actor: cls.ai_actor,
              locale: '',
              content_type_hint: '',
              viewport_width: 0,
              viewport_height: 0,
            });
            break;

          case 'timing':
            emitEngagementV1(env.ENGAGEMENT_EVENTS, {
              site_id: site,
              canonical_url_hash: canonicalHash,
              path,
              engagement_type: 'timing',
              visitor_hash: vid,
              country,
              scroll_depth: 0,
              engaged_seconds: timingSeconds,
            });
            break;

          case 'scroll_depth': {
            const depth = parseInt(body.props?.depth || '0', 10) || 0;
            emitEngagementV1(env.ENGAGEMENT_EVENTS, {
              site_id: site,
              canonical_url_hash: canonicalHash,
              path,
              engagement_type: 'scroll_depth',
              visitor_hash: vid,
              country,
              scroll_depth: depth,
              engaged_seconds: 0,
            });
            break;
          }

          case 'outbound': {
            const targetUrl = body.props?.url || '';
            const targetUrlHash = targetUrl ? await referrerUrlHash(targetUrl) : '';
            const targetParsed = targetUrl ? parseReferrer(`https://${targetUrl}`) : { social_platform: '', social_post_id: '' };
            emitShareV1(env.SHARE_EVENTS, {
              site_id: site,
              canonical_url_hash: canonicalHash,
              share_target_platform: targetParsed.social_platform || 'other',
              share_target_url_hash: targetUrlHash,
              share_target_post_id: targetParsed.social_post_id,
              share_id: crypto.randomUUID(),
              visitor_hash: vid,
              country,
              device_type: device,
              browser,
            });
            break;
          }

          default:
            emitCustomV1(env.CUSTOM_EVENTS, {
              site_id: site,
              canonical_url_hash: canonicalHash,
              path,
              event_name: eventName,
              event_props_json: body.props ? JSON.stringify(body.props) : '',
              visitor_hash: vid,
              country,
            });
        }
      } catch (err) {
        console.log(`[track] v1 dual-emit failed: ${err}`);
      }
    })());
  }

  return new Response(null, { status: 204, headers: cors });
}
