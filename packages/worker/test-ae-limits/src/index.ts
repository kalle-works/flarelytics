/**
 * AE Limits Verification Test Worker
 *
 * Throwaway harness for MIGRATION_PLAN.md §9 Task A. Emits probe rows to a
 * dedicated Analytics Engine dataset and reads them back via SQL API to
 * verify Cloudflare's documented limits (20 blobs, 16 KB total blob bytes,
 * 250 data points per Worker invocation) hold for the v1 pageview schema.
 *
 * NOT production code. Lives in test-ae-limits/ so it is obvious-on-sight
 * that nothing here is wired into the live worker. Source kept in repo so
 * re-runs are cheap when the schema evolves.
 */

interface Env {
  AE_TEST: AnalyticsEngineDataset;
  CF_API_TOKEN: string;
  CF_ACCOUNT_ID: string;
}

const DATASET = 'flarelytics_ae_limits_test_v1';

const enc = new TextEncoder();
const byteLen = (s: string): number => enc.encode(s).length;

/** Build a string of `n` ASCII bytes from a repeating pattern. */
function fill(n: number, base = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
  const out: string[] = [];
  while (out.join('').length < n) out.push(base);
  return out.join('').slice(0, n);
}

/** Random 12-hex tag used as canonical_url_hash for round-trip lookup. */
function randomTag(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Random hex string (used for visitor_hash, referrer_url_hash). */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Pageview_v1 row layout — mirrors MIGRATION_PLAN.md §3 exactly. */
type PageviewV1Row = {
  schema_version: string;       // blob1
  site_id: string;              // blob2
  canonical_url_hash: string;   // blob3 — ALSO the probe tag
  canonical_inferred: string;   // blob4
  path: string;                 // blob5
  referrer_domain: string;      // blob6
  referrer_url_hash: string;    // blob7
  social_platform: string;      // blob8
  social_post_id: string;       // blob9
  utm_source: string;           // blob10
  utm_medium: string;           // blob11
  utm_campaign: string;         // blob12
  visitor_hash: string;         // blob13
  country: string;              // blob14
  device_type: string;          // blob15
  browser: string;              // blob16
  bot_class: string;            // blob17
  ai_actor: string;             // blob18
  locale: string;               // blob19
  content_type_hint: string;    // blob20
  viewport_width: number;       // double2
  viewport_height: number;      // double3
};

function rowToBlobs(r: PageviewV1Row): string[] {
  return [
    r.schema_version, r.site_id, r.canonical_url_hash, r.canonical_inferred,
    r.path, r.referrer_domain, r.referrer_url_hash, r.social_platform,
    r.social_post_id, r.utm_source, r.utm_medium, r.utm_campaign,
    r.visitor_hash, r.country, r.device_type, r.browser,
    r.bot_class, r.ai_actor, r.locale, r.content_type_hint,
  ];
}

/**
 * "max-realistic" — what a heaviest realistic Kiiru/Factyou pageview looks like.
 * Long staging hostname, 500-char story path with UTM params, Bsky post referral.
 * Expected total: ~1.3 KB across all blobs.
 */
function buildMaxRealistic(tag: string): PageviewV1Row {
  return {
    schema_version: 'pv.v1.0',
    site_id: 'factyou-staging.example.com',
    canonical_url_hash: tag,
    canonical_inferred: '1',
    path: '/a/' + fill(497, 'finland-municipal-budget-data-deep-dive-'),
    referrer_domain: 'subdomain.bsky.social',
    referrer_url_hash: randomHex(6),
    social_platform: 'linkedin',
    social_post_id: 'did:plc:vk5ujnk6mrbhwdbwrg5qlxhn/app.bsky.feed.post/3jzfcijpj2z2a-extended',
    utm_source: fill(200, 'newsletter-campaign-2026-week-19-'),
    utm_medium: fill(200, 'email-fundraising-drive-'),
    utm_campaign: fill(200, 'kuntavaalit-2025-asukastutkimus-'),
    visitor_hash: randomHex(8),
    country: 'FI',
    device_type: 'desktop',
    browser: 'Safari Mobile',
    bot_class: 'human',
    ai_actor: '',
    locale: 'fi',
    content_type_hint: 'article',
    viewport_width: 1920,
    viewport_height: 1080,
  };
}

/**
 * "schema-cap" — every truncatable field at the limit declared in §3.
 * Proves the declared truncation policy fits inside AE's 16 KB total.
 * Expected total: ~1.5 KB.
 */
function buildSchemaCap(tag: string): PageviewV1Row {
  return {
    schema_version: 'pv.v1.0',
    site_id: fill(64, 'a-very-long-site-id-'),    // 64 chars cap (worst-case multi-tenant)
    canonical_url_hash: tag,
    canonical_inferred: '1',
    path: fill(500, 'p'),                         // path cap
    referrer_domain: fill(80, 'r'),               // referrer_domain cap
    referrer_url_hash: randomHex(6),
    social_platform: 'mastodon',                  // longest current label (8)
    social_post_id: fill(80, 's'),                // social_post_id cap
    utm_source: fill(200, 'u'),                   // utm cap
    utm_medium: fill(200, 'm'),
    utm_campaign: fill(200, 'c'),
    visitor_hash: randomHex(8),                   // 16 hex (locked from v0)
    country: 'XX',
    device_type: 'desktop',
    browser: 'Safari Mobile',
    bot_class: 'ai-crawler',
    ai_actor: 'perplexity',
    locale: 'en-US',
    content_type_hint: 'article',
    viewport_width: 1920,
    viewport_height: 1080,
  };
}

/**
 * "stress" — push the row toward the documented 16 KB ceiling. If AE silently
 * truncates or drops the row, /verify will surface it.
 * Expected total: ~15 KB.
 */
function buildStress(tag: string): PageviewV1Row {
  return {
    schema_version: 'pv.v1.0',
    site_id: fill(800, 's'),
    canonical_url_hash: tag,
    canonical_inferred: '1',
    path: fill(4000, 'p'),
    referrer_domain: fill(800, 'r'),
    referrer_url_hash: randomHex(6),
    social_platform: fill(800, 'P'),
    social_post_id: fill(2000, 'i'),
    utm_source: fill(2000, 'u'),
    utm_medium: fill(2000, 'm'),
    utm_campaign: fill(2000, 'c'),
    visitor_hash: randomHex(8),
    country: fill(800, 'C'),
    device_type: fill(50, 'd'),
    browser: fill(50, 'b'),
    bot_class: fill(50, 'B'),
    ai_actor: fill(50, 'a'),
    locale: fill(50, 'l'),
    content_type_hint: fill(50, 'h'),
    viewport_width: 1920,
    viewport_height: 1080,
  };
}

type Probe = 'max-realistic' | 'schema-cap' | 'stress';

function buildProbe(probe: Probe, tag: string): PageviewV1Row {
  if (probe === 'max-realistic') return buildMaxRealistic(tag);
  if (probe === 'schema-cap') return buildSchemaCap(tag);
  return buildStress(tag);
}

/** Per-blob byte breakdown for response/logging. */
function blobBreakdown(row: PageviewV1Row): { per_blob: Array<{ slot: number; field: string; bytes: number; sample?: string }>; total_bytes: number } {
  const fields: Array<keyof PageviewV1Row> = [
    'schema_version', 'site_id', 'canonical_url_hash', 'canonical_inferred',
    'path', 'referrer_domain', 'referrer_url_hash', 'social_platform',
    'social_post_id', 'utm_source', 'utm_medium', 'utm_campaign',
    'visitor_hash', 'country', 'device_type', 'browser',
    'bot_class', 'ai_actor', 'locale', 'content_type_hint',
  ];
  const per_blob = fields.map((f, i) => {
    const v = String(row[f] ?? '');
    return {
      slot: i + 1,
      field: f,
      bytes: byteLen(v),
      sample: v.length > 32 ? v.slice(0, 24) + '…' + v.slice(-4) : v,
    };
  });
  const total_bytes = per_blob.reduce((s, b) => s + b.bytes, 0);
  return { per_blob, total_bytes };
}

async function handleEmit(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const probe = (url.searchParams.get('probe') || 'max-realistic') as Probe;
  if (!['max-realistic', 'schema-cap', 'stress'].includes(probe)) {
    return Response.json({ error: 'Invalid probe', allowed: ['max-realistic', 'schema-cap', 'stress'] }, { status: 400 });
  }

  const tag = randomTag();
  const row = buildProbe(probe, tag);
  const breakdown = blobBreakdown(row);

  // AE per-data-point limits (CF docs 2026-04-23 + empirical):
  //   20 blobs, 20 doubles, 1 index, 16 KB total blob bytes, ~96 bytes per index value.
  // The 96-byte index ceiling is enforced synchronously by writeDataPoint — it throws
  // if exceeded, observed during stress-probe emission. Truncate site_id to 64 bytes
  // for the index slot (still well under 96, leaves headroom for future schema use).
  env.AE_TEST.writeDataPoint({
    blobs: rowToBlobs(row),
    doubles: [1, row.viewport_width, row.viewport_height],
    indexes: [row.site_id.slice(0, 64)],
  });

  return Response.json({
    probe,
    tag,
    sent_at: new Date().toISOString(),
    total_blob_bytes: breakdown.total_bytes,
    documented_limit_bytes: 16384,
    headroom_bytes: 16384 - breakdown.total_bytes,
    per_blob: breakdown.per_blob,
    next: `Wait 5–15 min for AE indexing, then GET /verify?tag=${tag}`,
  }, { status: 202 });
}

async function runSql(env: Env, sql: string): Promise<{ ok: true; data: any } | { ok: false; status: number; body: string }> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      body: sql.trim(),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    return { ok: false, status: response.status, body: await response.text() };
  }
  return { ok: true, data: await response.json() };
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tag = url.searchParams.get('tag');
  if (!tag || !/^[0-9a-f]{12}$/.test(tag)) {
    return Response.json({ error: 'Invalid tag', hint: 'tag must be 12 hex chars (the canonical_url_hash returned by /emit)' }, { status: 400 });
  }

  // ClickHouse `length(...)` returns BYTE length for String. Per-blob byte
  // measurement is what we actually want — characters can lie if anything
  // multi-byte sneaks in via a future probe.
  const sql = `
    SELECT
      blob1 AS schema_version,
      blob2 AS site_id,
      blob3 AS canonical_url_hash,
      blob5 AS path_sample,
      length(blob1) AS b1_len,
      length(blob2) AS b2_len,
      length(blob3) AS b3_len,
      length(blob4) AS b4_len,
      length(blob5) AS b5_len,
      length(blob6) AS b6_len,
      length(blob7) AS b7_len,
      length(blob8) AS b8_len,
      length(blob9) AS b9_len,
      length(blob10) AS b10_len,
      length(blob11) AS b11_len,
      length(blob12) AS b12_len,
      length(blob13) AS b13_len,
      length(blob14) AS b14_len,
      length(blob15) AS b15_len,
      length(blob16) AS b16_len,
      length(blob17) AS b17_len,
      length(blob18) AS b18_len,
      length(blob19) AS b19_len,
      length(blob20) AS b20_len,
      double1 AS event_count,
      double2 AS viewport_width,
      double3 AS viewport_height,
      timestamp
    FROM ${DATASET}
    WHERE blob3 = '${tag}'
      AND timestamp > NOW() - INTERVAL '1' DAY
    LIMIT 5
  `;

  const result = await runSql(env, sql);
  if (!result.ok) {
    return Response.json({ error: 'SQL API error', status: result.status, body: result.body }, { status: 502 });
  }

  const data = result.data as { data?: Array<Record<string, any>> };
  const rows = data.data ?? [];

  if (rows.length === 0) {
    return Response.json({
      tag,
      found: false,
      hint: 'No row yet. AE indexing lag is typically 1–15 min. Retry, or check /emit was called with this tag.',
    });
  }

  const summary = rows.map((row) => {
    const lens: Record<string, number> = {};
    let total = 0;
    for (let i = 1; i <= 20; i++) {
      const k = `b${i}_len`;
      const v = Number(row[k] ?? 0);
      lens[`blob${i}`] = v;
      total += v;
    }
    return {
      schema_version: row.schema_version,
      site_id: row.site_id,
      canonical_url_hash: row.canonical_url_hash,
      timestamp: row.timestamp,
      total_blob_bytes_stored: total,
      stored_lengths: lens,
      doubles: { event_count: row.event_count, viewport_width: row.viewport_width, viewport_height: row.viewport_height },
    };
  });

  return Response.json({ tag, found: true, row_count: rows.length, rows: summary });
}

function handleBudget(): Response {
  // Analytic byte budget per blob — locked truncation policy for pageview_v1.
  // Numbers chosen to leave 10x headroom against the 16 KB AE total at "schema-cap".
  const budget = [
    { slot: 1, field: 'schema_version', cap: 16, rationale: 'fixed `pv.v1.0` etc; never user-controlled' },
    { slot: 2, field: 'site_id', cap: 64, rationale: 'KV-managed identifier; multi-tenant headroom' },
    { slot: 3, field: 'canonical_url_hash', cap: 12, rationale: 'SHA-256(canonical_url)[0:12] — 48 bits of address space' },
    { slot: 4, field: 'canonical_inferred', cap: 1, rationale: 'flag: `1` or empty' },
    { slot: 5, field: 'path', cap: 500, rationale: 'matches existing v0 truncation; covers Kiiru story slugs comfortably' },
    { slot: 6, field: 'referrer_domain', cap: 80, rationale: 'longest realistic hostname incl. subdomains; below RFC 253 max but bigger than any seen-in-wild value' },
    { slot: 7, field: 'referrer_url_hash', cap: 12, rationale: 'same as canonical_url_hash' },
    { slot: 8, field: 'social_platform', cap: 16, rationale: 'enum: bluesky/facebook/x/linkedin/mastodon/hn/reddit/empty' },
    { slot: 9, field: 'social_post_id', cap: 80, rationale: 'Bsky DID + post path (~70 typical); FB story_fbid (~40); reddit permalink id (~10)' },
    { slot: 10, field: 'utm_source', cap: 200, rationale: 'matches existing v0 cap' },
    { slot: 11, field: 'utm_medium', cap: 200, rationale: 'matches existing v0 cap' },
    { slot: 12, field: 'utm_campaign', cap: 200, rationale: 'matches existing v0 cap' },
    { slot: 13, field: 'visitor_hash', cap: 16, rationale: 'SHA-256 first 8 bytes → 16 hex (matches v0 — 64 bits = collision-safe at daily-rotating uniqueness)' },
    { slot: 14, field: 'country', cap: 4, rationale: 'ISO 3166-1 alpha-2 + `XX` fallback' },
    { slot: 15, field: 'device_type', cap: 16, rationale: 'enum: mobile/tablet/desktop' },
    { slot: 16, field: 'browser', cap: 32, rationale: 'enum-ish: Chrome/Firefox/Safari/Edge/Opera/DuckDuckGo/Safari Mobile/Other' },
    { slot: 17, field: 'bot_class', cap: 16, rationale: 'enum: human/search-bot/ai-crawler/unknown-bot' },
    { slot: 18, field: 'ai_actor', cap: 32, rationale: 'enum: chatgpt/claude-web/perplexity/gemini/bingai/unknown-ai/empty' },
    { slot: 19, field: 'locale', cap: 16, rationale: 'BCP-47 short tag (fi, en, en-US, zh-Hans-CN at outer limit)' },
    { slot: 20, field: 'content_type_hint', cap: 32, rationale: 'host-emitted hint; small enum' },
  ];
  const sum = budget.reduce((s, b) => s + b.cap, 0);
  return Response.json({
    schema: 'pageview_v1',
    documented_ae_total_blob_bytes_limit: 16384,
    schema_cap_total: sum,
    headroom_bytes: 16384 - sum,
    headroom_factor: (16384 / sum).toFixed(1) + 'x',
    per_blob: budget,
    note: '`schema_cap_total` is the worst-case row size when every truncatable field is at its cap. Real production rows average ~10–20% of this.',
  });
}

function handleHealth(env: Env): Response {
  // Length-only diagnostic so a misconfigured secret (empty string vs missing
  // vs valid) is distinguishable without ever logging the value itself.
  return Response.json({
    status: 'ok',
    bindings: {
      AE_TEST: !!env.AE_TEST,
      CF_API_TOKEN_present: typeof env.CF_API_TOKEN !== 'undefined',
      CF_API_TOKEN_len: typeof env.CF_API_TOKEN === 'string' ? env.CF_API_TOKEN.length : null,
      CF_ACCOUNT_ID: !!env.CF_ACCOUNT_ID,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/emit' && request.method === 'POST') return handleEmit(request, env);
    if (pathname === '/verify' && request.method === 'GET') return handleVerify(request, env);
    if (pathname === '/budget' && request.method === 'GET') return handleBudget();
    if (pathname === '/health' && request.method === 'GET') return handleHealth(env);

    return Response.json(
      { error: 'Not Found', available: ['POST /emit?probe=...', 'GET /verify?tag=...', 'GET /budget', 'GET /health'] },
      { status: 404 },
    );
  },
};
