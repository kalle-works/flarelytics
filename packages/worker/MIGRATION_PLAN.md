# Flarelytics A+ Migration Plan: v0 → v1 schema

Status: VERIFIED (§9 Tasks A–F all complete 2026-05-08) — schemas locked, baseline p99 captured, all infra projections within free-tier headroom; cleared for Phase 0 provisioning
Target architecture: see `~/.gstack/projects/kalle-works-flarelytics/kalle-main-design-20260508-094109.md`
Author: Kalle
Last updated: 2026-05-08 (post-§9 closures)

This document is the load-bearing decision for A+. It describes how the existing 12-blob Analytics Engine events coexist with the new versioned per-family event schemas, exactly which queries change, and what rollback looks like. **No A+ code is written until §9 verifications are complete and Phase 0.5 pilot is approved.**

The plan was reviewed in `/plan-eng-review` (Section 1: 7 issues, Section 2: 1 housekeeping, Section 3: testing gaps, Section 4: 2 perf issues) and challenged by Codex (20 findings, 2 cross-model tensions resolved). Decisions are listed in §0 below.

---

## 0. Locked decisions from plan-eng-review

| ID | Decision | Resolves |
|---|---|---|
| 1A | content_id minted async in queue-job. `/track` does not call D1. | D1 SPOF on /track |
| 2A | `t.co` → `social_platform='x'`, `social_post_id=''` (no HTTP follow) | Twitter shortener cost |
| 3A | Queues backpressure = best-effort + DLQ + depth metering | Queue ruuhkautuminen |
| 4A→4A' | All v1 queries `WHERE blob1 IN ('pv.v1.0','pv.v1.1',...)` (exact list, not LIKE — revised after Codex #11) | Schema-version drift |
| 5A | Custom events get OWN dataset `flarelytics_custom_v1`. Total: **6 datasets** | High-cardinality custom contamination |
| 6A | `canonical_url_hash` = SHA-256(canonical_url)[0:12], deterministic, written by /track. **NOT a content_id** (see T1A) | Determinism, /track latency |
| 7A | AE blob/row limits verified before Phase 1 (see §9 task) | Schema feasibility |
| T1 | Add §11 Testing requirements per phase | Test coverage gaps |
| P1A | Phase 0 baseline p99 measurement before Phase 1 | Dual-emit perf risk |
| P2A | Dashboard does bulk D1 lookup `WHERE content_id IN (...)` | N+1 in Loop view |
| **T1A** | **AE carries `canonical_url_hash` (URL identity). D1 maps many hashes → one `content_id` (content identity). Read-time JOIN.** | content_id semantics (Codex #3, #4, #5) |
| **T2A** | **Phase 0.5 pilot: Kiiru-only validation BEFORE rolling Phase 1 to full portfolio** | Strategic risk (Codex #13, #20) |

---

## 1. Why this is the first thing

Every other A+ deliverable (D1 dimensions, content graph, Distribution Loop view, semantic Query Builder, Distribution Quality Score) reads from Analytics Engine. The data model is upstream of all of them. If migration is wrong, every downstream feature is built on sand.

Cloudflare Analytics Engine constraints that drive the plan:
- A single AE dataset has a fixed implicit schema. Changing blob meanings mid-stream silently breaks historical queries.
- AE rows are immutable. No `UPDATE`. No re-statement. Any "fill in later" enrichment must live in D1 or R2, never AE.
- Standard retention is bounded (~90 days). After cutover, legacy data ages out naturally.
- AE does not support cross-dataset joins. Queries hit one dataset at a time. Cross-family analytics (e.g. funnels) compose application-side and accept independent sampling/latency windows.
- Per-data-point limits (AE doc, https://developers.cloudflare.com/analytics/analytics-engine/limits/, plus empirical verification — see §9 Task A results): up to 20 blobs, 20 doubles, 1 index, 16 KB total blob bytes, 250 data points per Worker invocation, **96 bytes per index value (empirical, undocumented in CF docs)**.

These constraints mean the migration is **dataset-level**, not column-level. New event families get new datasets. Legacy stays on the old dataset until it ages out. Schema evolution within a family is bounded by the 20-blob ceiling.

---

## 2. Current v0 schema (frozen for reference)

Single AE dataset: `flarelytics` (binding `ANALYTICS`). Two implicit row shapes share the dataset, distinguished by `blob4`:

### v0 — pageview/timing/scroll/outbound/custom (the dominant shape)
| Slot | Field |
|---|---|
| blob1 | path |
| blob2 | referrer hostname (`direct` if none) |
| blob3 | country code |
| blob4 | event name (`pageview`, `timing`, `scroll_depth`, `outbound`, custom) |
| blob5 | event properties (pipe-separated, freeform) |
| blob6 | utm_source |
| blob7 | utm_medium |
| blob8 | utm_campaign |
| blob9 | visitor hash (daily-rotating SHA-256, **first 8 bytes → 16 hex chars** per `packages/worker/src/index.ts:116`. The first draft of this plan said "64 hex"; it never was — v0 has always truncated to 16 hex. v1 keeps the same.) |
| blob10 | site hostname (REQUIRED in every WHERE) |
| blob11 | device type |
| blob12 | browser |
| double1 | event count (always 1) |
| double2 | timing seconds (only on `timing` events; 0 elsewhere) |

### v0 — bot_hit (different blob layout in same dataset)
| Slot | Field |
|---|---|
| blob1 | path |
| blob2 | "" |
| blob3 | country |
| blob4 | `bot_hit` |
| blob5 | UA truncated to 200 chars (likely exceeds AE per-blob limit — see §9) |
| blob6–9 | "" |
| blob10 | site hostname |
| blob11–12 | "" |
| double1 | 1 |
| double2 | 0 |

### v0 query surface
37 named queries in `QUERY_TEMPLATES` (`packages/worker/src/index.ts:249-612`). All assume the v0 schema. All must include `AND blob10 = '${site}'`.

### v0 limits forcing migration
- All 12 blobs spoken for. No room for `social_post_id`, `canonical_url_hash`, `ai_actor`, `share_id`.
- `blob5` is freeform pipe-separated; not parseable in SQL.
- No content stability across URL changes or translations — `blob1` (path) is the de facto content key.
- Mixed event shapes in one dataset; every query must filter by `blob4` first.
- Distribution Loop, Content graph, Distribution Quality Score unbuildable on v0.

---

## 3. v1 target schema (per-family datasets)

**Six new AE datasets**, one per event family. Each has a fixed, documented schema. `schema_version` is `blob1` in every family so changes are detectable in-stream.

`schema_version` format: `<family>.v<major>.<minor>`. Example: `pv.v1.0`. Major bumps require a new dataset. Minor bumps are backwards-compatible additions to existing-but-unused slots, capped by the 20-blob AE limit.

### Identity model (T1A) — read this before reading the schemas below

**AE rows carry `canonical_url_hash`, NOT `content_id`.**

- `canonical_url_hash` = `SHA-256(canonical_url)[0:12]` (12 hex chars). Deterministic. Computed by `/track` from the tracker payload's `canonical_url` field. No D1 lookup, no queue dependency.
- `content_id` = stable identifier for a *piece of content* across translations, URL renames, redirects, reposts. Lives in D1 only. One content can have many canonical_url_hashes (e.g. fi + en versions of an article share one content_id). Mapped via `content_aliases (canonical_url_hash → content_id)`.
- Dashboard queries that need content-level aggregation (Distribution Loop, Content Performance) JOIN at read time: `pageview_v1` rows by canonical_url_hash → D1 `content_aliases` → content_id.

This separates URL identity (cheap, deterministic, written by /track) from content identity (D1-managed, mutable, queue-job-populated). It correctly handles translations and URL renames at read time without rewriting AE history.

### Tracker contract

The tracker payload (sent by browser to `/track`) MUST include:
- `canonical_url` — value of `<link rel="canonical">` if present, else `location.href` with normalization (lowercase host, strip default port, strip fragment, optional trailing slash policy).

If the payload lacks `canonical_url`, the worker derives it from `request.url` and sets `canonical_inferred=true` in a flag blob. Inferred-canonical rows are flagged in the dashboard so users know their precision is limited.

### Dataset bindings (wrangler.toml)
```toml
[[analytics_engine_datasets]]
binding = "ANALYTICS"            # legacy v0 — still bound, dual-emitted to during migration
dataset = "flarelytics"

[[analytics_engine_datasets]]
binding = "PAGEVIEW_EVENTS"
dataset = "flarelytics_pageview_v1"

[[analytics_engine_datasets]]
binding = "ENGAGEMENT_EVENTS"
dataset = "flarelytics_engagement_v1"

[[analytics_engine_datasets]]
binding = "SHARE_EVENTS"
dataset = "flarelytics_share_v1"

[[analytics_engine_datasets]]
binding = "BOT_EVENTS"
dataset = "flarelytics_bot_v1"

[[analytics_engine_datasets]]
binding = "PERFORMANCE_EVENTS"
dataset = "flarelytics_performance_v1"

[[analytics_engine_datasets]]
binding = "CUSTOM_EVENTS"
dataset = "flarelytics_custom_v1"

[[d1_databases]]
binding = "DIMENSIONS"
database_name = "flarelytics-dimensions"
database_id = "..."

[[queues.producers]]
binding = "ENRICH_QUEUE"
queue = "flarelytics-enrich"

[[queues.consumers]]
queue = "flarelytics-enrich"
max_batch_size = 100
max_retries = 3
dead_letter_queue = "flarelytics-enrich-dlq"

[[r2_buckets]]
binding = "ARCHIVE"
bucket_name = "flarelytics-archive"
```

### `flarelytics_pageview_v1` (target: ≤ 20 blobs, ≤ 16 KB total — verified §9 Task A)

Truncation policy column locked from §9 Task A measurements. Worst-case row at all caps = **1545 bytes**, leaving **14,839 bytes (10.6×) headroom** below the AE 16 KB total ceiling. Index value (`site_id` truncated to ≤ 64 bytes) sits below the empirically-discovered 96-byte index ceiling.

| Slot | Field | Cap (bytes) | Notes |
|---|---|---|---|
| blob1 | schema_version | 16 | `pv.v1.0` etc; never user-controlled |
| blob2 | site_id | 64 | KV-backed identifier; multi-tenant headroom |
| blob3 | canonical_url_hash | 12 | SHA-256(canonical_url)[0:12], deterministic |
| blob4 | canonical_inferred | 1 | `'1'` if worker had to infer canonical from request URL, else `''` |
| blob5 | path | 500 | matches existing v0 truncation; covers Kiiru story slugs comfortably |
| blob6 | referrer_domain | 80 | `bsky.app`, `m.facebook.com`, `direct`; below RFC 253 max but bigger than any seen-in-wild value |
| blob7 | referrer_url_hash | 12 | SHA-256(referrer_url)[0:12]; drop in Phase 2 if no consumer view emerges |
| blob8 | social_platform | 16 | enum: `bluesky`/`facebook`/`hn`/`reddit`/`linkedin`/`mastodon`/`x`/empty |
| blob9 | social_post_id | 80 | Bsky DID + post path (~70 typical); FB story_fbid (~40); reddit permalink id (~10). Empty for x (2A). |
| blob10 | utm_source | 200 | preserved from v0 (Codex #9 fix) |
| blob11 | utm_medium | 200 | preserved from v0 |
| blob12 | utm_campaign | 200 | preserved from v0 (Codex #9 fix — was collapsed into source_medium, now restored) |
| blob13 | visitor_hash | 16 | SHA-256 first 8 bytes → 16 hex chars (matches v0 — 64 bits = collision-safe at daily-rotating uniqueness on ≤ 100M events/day) |
| blob14 | country | 4 | ISO 3166-1 alpha-2 + `XX` fallback |
| blob15 | device_type | 16 | enum: `mobile`/`tablet`/`desktop` |
| blob16 | browser | 32 | enum-ish: Chrome/Firefox/Safari/Edge/Opera/DuckDuckGo/Safari Mobile/Other |
| blob17 | bot_class | 16 | enum: `human`/`search-bot`/`ai-crawler`/`unknown-bot` |
| blob18 | ai_actor | 32 | enum: `chatgpt`/`claude-web`/`perplexity`/`gemini`/`bingai`/`unknown-ai`/empty |
| blob19 | locale | 16 | BCP-47 short tag (fi, en, en-US, zh-Hans-CN at outer limit). D1-derived in queue-job; empty at /track time, populated post-enrichment. |
| blob20 | content_type_hint | 32 | host-emitted hint (`article`/`page`/`landing`/empty); content_type proper is in D1 |
| double1 | event_count | — | always 1 |
| double2 | viewport_width | — | px |
| double3 | viewport_height | — | px |
| index | site_id (sliced to 64 bytes) | 64 | required-in-every-WHERE remains; truncated in worker before write to stay under empirical 96-byte index ceiling |

**No `event_type` slot** (Codex #8 fix): pageview_v1 is pageview-only. Custom events have their own dataset (5A). `locale` and `content_type_hint` may be empty at /track time and filled later application-side via D1 join — they are NOT mutated in AE.

### `flarelytics_engagement_v1`

Caps follow pageview_v1 conventions. Total worst-case row ~620 bytes.

| Slot | Field | Cap (bytes) | Notes |
|---|---|---|---|
| blob1 | schema_version | 16 | `eng.v1.0` |
| blob2 | site_id | 64 | |
| blob3 | canonical_url_hash | 12 | |
| blob4 | path | 500 | |
| blob5 | engagement_type | 16 | enum: `scroll_depth`/`timing`/`read_complete` |
| blob6 | visitor_hash | 16 | |
| blob7 | country | 4 | |
| double1 | event_count | — | always 1 |
| double2 | scroll_depth | — | 0–100 |
| double3 | engaged_seconds | — | |
| index | site_id (sliced ≤ 64) | 64 | scope filter |

### `flarelytics_share_v1`

Outbound clicks tagged as shares. `share_target_url` is **hashed**, not stored plaintext (Codex #7 fix — privacy-first). Caps follow pageview_v1 conventions. Total worst-case row ~340 bytes.

| Slot | Field | Cap (bytes) | Notes |
|---|---|---|---|
| blob1 | schema_version | 16 | `share.v1.0` |
| blob2 | site_id | 64 | |
| blob3 | canonical_url_hash | 12 | source content URL hash |
| blob4 | share_target_platform | 16 | enum: `bluesky`/`facebook`/`x`/`linkedin`/`email`/`copy_link`/`other` |
| blob5 | share_target_url_hash | 12 | SHA-256(share_target_url)[0:12] — full URL is NOT stored; hash + platform is enough for aggregation |
| blob6 | share_target_post_id | 80 | parsed at click time only if the user clicked from a known social-platform target URL; otherwise empty. **Never filled later** (Codex #6 — AE immutability) |
| blob7 | share_id | 36 | UUID v4 (with dashes), links to enrichment record in D1 |
| blob8 | visitor_hash | 16 | |
| blob9 | country | 4 | |
| blob10 | device_type | 16 | |
| blob11 | browser | 32 | |
| double1 | event_count | — | always 1 |
| index | site_id (sliced ≤ 64) | 64 | scope filter |

### `flarelytics_bot_v1`

User-agent cap locked at 80 bytes after §9 Task A measurements (down from v0's 200). Total worst-case row ~285 bytes, well below AE limits.

| Slot | Field | Cap (bytes) | Notes |
|---|---|---|---|
| blob1 | schema_version | 16 | `bot.v1.0` |
| blob2 | site_id | 64 | matches pageview_v1 |
| blob3 | path | 500 | matches pageview_v1 |
| blob4 | bot_class | 16 | enum |
| blob5 | ai_actor | 32 | enum |
| blob6 | user_agent | 80 | locked from §9 Task A. v0 stored 200 chars; the additional 120 chars never carried distinguishing info because UA strings are dominated by their first ~60 chars (engine + version) |
| blob7 | country | 4 | |
| blob8 | referrer_domain | 80 | matches pageview_v1 |
| double1 | event_count | — | always 1 |
| index | site_id (sliced ≤ 64) | 64 | scope filter |

### `flarelytics_performance_v1`

Caps follow pageview_v1 conventions. Total worst-case row ~660 bytes.

| Slot | Field | Cap (bytes) | Notes |
|---|---|---|---|
| blob1 | schema_version | 16 | `perf.v1.0` |
| blob2 | site_id | 64 | |
| blob3 | canonical_url_hash | 12 | |
| blob4 | path | 500 | |
| blob5 | device_type | 16 | |
| blob6 | browser | 32 | |
| blob7 | country | 4 | |
| double1 | event_count | — | always 1 |
| double2 | page_load_ms | — | |
| double3 | ttfb_ms | — | |
| double4 | dom_interactive_ms | — | |
| index | site_id (sliced ≤ 64) | 64 | scope filter |

### `flarelytics_custom_v1` (5A — was missing in original draft)

`event_props_json` cap locked at 1024 bytes (1 KB) after §9 Task A measurements. Total worst-case row ~1.7 KB, well below AE limits.

| Slot | Field | Cap (bytes) | Notes |
|---|---|---|---|
| blob1 | schema_version | 16 | `cust.v1.0` |
| blob2 | site_id | 64 | matches pageview_v1 |
| blob3 | canonical_url_hash | 12 | |
| blob4 | path | 500 | |
| blob5 | event_name | 100 | `flarelytics.track('event', ...)` first arg; matches v0's eventName cap |
| blob6 | event_props_json | 1024 | second arg, JSON-stringified. 1 KB is enough for ~25 reasonable key/value pairs. Worker rejects oversize props with 400 rather than truncating mid-JSON (truncated JSON is unparsable). |
| blob7 | visitor_hash | 16 | |
| blob8 | country | 4 | |
| double1 | event_count | — | always 1 |
| index | site_id (sliced ≤ 64) | 64 | scope filter |

### D1 dimension schema (sketched — full DDL produced during implementation)

```sql
CREATE TABLE content (
  content_id TEXT PRIMARY KEY,            -- short hash (12 hex), assigned by queue-job
  primary_canonical_url TEXT NOT NULL,
  content_type TEXT,
  published_at INTEGER,                   -- unix ms
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE content_aliases (
  canonical_url_hash TEXT PRIMARY KEY,    -- 12 hex chars from /track
  content_id TEXT NOT NULL REFERENCES content(content_id),
  canonical_url TEXT NOT NULL,
  locale TEXT,                            -- fi/en/etc
  first_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_content_aliases_content_id ON content_aliases(content_id);

CREATE TABLE content_translations (
  content_id TEXT NOT NULL REFERENCES content(content_id),
  sibling_content_id TEXT NOT NULL REFERENCES content(content_id),
  PRIMARY KEY (content_id, sibling_content_id)
);

CREATE TABLE social_posts (
  social_platform TEXT NOT NULL,
  social_post_id TEXT NOT NULL,
  social_post_url TEXT,
  social_author TEXT,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (social_platform, social_post_id)
);

CREATE TABLE share_enrichment (
  share_id TEXT PRIMARY KEY,
  share_target_platform TEXT,
  share_target_post_id TEXT,
  enriched_at INTEGER
);

CREATE TABLE referrer_mappings (
  referrer_domain TEXT PRIMARY KEY,
  social_platform TEXT NOT NULL,
  parser_version INTEGER NOT NULL
);

CREATE TABLE ai_actor_signatures (
  user_agent_pattern TEXT PRIMARY KEY,    -- LIKE-style pattern
  ai_actor TEXT NOT NULL,
  classifier_version INTEGER NOT NULL
);
```

### Queue-job pipeline (3A — best-effort with backpressure)

```
[/track receives event]
        |
        | (compute canonical_url_hash, classify bot/ai_actor from headers,
        |  parse social_platform/social_post_id from referrer URL)
        |
        v
[Worker writes to AE: pageview_v1, engagement_v1, ...]
        |
        | (also writes legacy `flarelytics` dataset during dual-emit phase)
        |
        v
[Worker pushes enrichment job to ENRICH_QUEUE]
        |
        | (best-effort: if queue.send() throws, log and continue —
        |  /track does NOT fail. Drop is acceptable; AE row is canonical.)
        |
        v
[ENRICH_QUEUE consumer (max_batch_size=100, max_retries=3)]
   - Lookup canonical_url_hash in D1.content_aliases
   - If miss: mint content_id, INSERT into D1.content + content_aliases
   - If queue depth > 5000: skip non-critical enrichment (post-ID resolution, AI classifier table refresh) — keep only content_id minting
   - On retry exhaustion: send to flarelytics-enrich-dlq
        |
        v
[Cron job (daily): retry DLQ once, log orphan rate]
```

**Orphan rate is dashboard-visible.** If queue loss creates AE rows whose canonical_url_hash never gets a content_id minted, those rows still answer URL-level queries (since canonical_url_hash is the AE key). They become invisible to *content-level* queries until reconciliation. The cron job logs the miss count to R2 for alerting.

### Read interface

Two layers:
1. **Predefined queries** (current 37, refactored to per-event-family schemas — see §5).
2. **Semantic Query Builder** (deferred to a separate plan): LLM compiles natural language → safe SQL templates over a fixed dimension list. No free-form SQL escape hatch from the dashboard.

### Dashboard form

- **Portfolio Overview** — all sites, human vs AI/bot traffic, top content, distribution lift, returning anonymous readers.
- **Content Performance** — per content_id (D1 join). First-24h lift, social return rate, share-clicks out, referrers back, read depth, engaged time, decay curve, Distribution Quality Score.
- **Distribution Loop** *(killer view)* — article → outbound share → social post → returning visits → engaged reads → secondary shares.
- **Social Referrers** — platform, post/thread, source URL, landing article, traffic quality.
- **AI & Crawlers** *(sidebar)* — human vs known crawler vs likely AI vs unknown bot. Promoted to pillar only when AI traffic changes editorial decisions.
- **Query Builder** — predefined + semantic.

---

## 4. Migration phases

### Phase 0 (Day 0) — Setup, no traffic change
- Provision 6 new AE datasets, D1 database (with empty schema), Queues, R2 bucket.
- Add bindings to `wrangler.toml`.
- **Run AE limits verification task (§9 task A).** Output goes into this document before Phase 0.5 starts.
- **Run baseline /track p99 measurement (§9 task B).** Output stored as a target line.
- Deploy. v0 keeps writing to `flarelytics`. Nothing else changes.
- Smoke tests: `/track`, `/query`, `/public-stats` behavior identical.

### Phase 0.5 (Day 0 — Day 21) — Pilot validation on Kiiru only (T2A)

**This phase is the strategic gate. If Distribution Quality Score and the Loop view do not change Kalle's editorial decisions on Kiiru in 14+ days of real use, the full Phase 1 rollout is paused for re-design.**

- Worker dual-writes v1 events for Kiiru only (filter by `request.headers.get('Origin')` host = `kiiru.fi`). Other sites continue writing only to v0.
- Implement v1 reads: pageview_v1, share_v1, engagement_v1.
- Build the Distribution Loop view targeting Kiiru only.
- Build a minimal Distribution Quality Score (v0.1 — no calibration yet, just exposed inputs).
- Tracker emits `canonical_url` for Kiiru only.
- Daily cron: shadow query comparison for Kiiru only (sample 30 random query/period combos; per-query tolerance band — not global 1%).
- **Gate to Phase 1**: Kalle uses the Loop view for ≥ 14 days. Documents at least 3 editorial decisions changed by it (which Bsky-post drove the spike, which article got the unexpected return, which content type underperforms relative to share-out volume). If gate fails, return to /office-hours.

### Phase 1 (Day 21 — Day 35) — Full portfolio dual-emit
- Extend dual-emit to all sites in the KV allowlist.
- Tracker payload contract enforced for all sites (canonical_url required; fallback to inferred-canonical with flag).
- All v1 reads at the dashboard now serve all sites.
- **Risk gate**: dual-write must not increase `/track` p99 latency by more than 30% over Phase 0 baseline. If it does, move v1 writes into `ctx.waitUntil()` (fire-and-forget, /track returns to client immediately, AE write happens after). Trade immediate-consistency for latency.
- Queue depth alarm if backlog > 5000 messages.

### Phase 2 (Day 35 — Day 65) — Read shadow + Loop view full rollout
- Build remaining new views: Content Performance, Social Referrers, Article Scorecard, AI & Crawlers (sidebar).
- For every existing v0 query in `QUERY_TEMPLATES`, write a parallel v1 query and add a `?shadow=true` switch on `/query` that runs both and returns a diff.
- Daily cron job samples query/site/period combinations and logs `(v0_result, v1_result, abs_diff_pct)` to R2.
- **Risk gate**: per-query tolerance bands for shadow drift (Codex #10 fix):
  - Aggregate counters (pageviews, visitors, sessions): < 2% drift on 95% of samples, 7 consecutive days.
  - Time-windowed live queries (live-visitors, hourly-today): < 5% drift acceptable (timing differences expected).
  - Bounce rate, funnel queries: < 5% drift acceptable (different event-classification boundaries).
  - Bot queries: drift expected because v1 has richer ai_actor classification. Document new-class membership rather than gating on parity.
  - **No global tolerance.** Each of the 37 queries gets a documented expected-drift band before Phase 3 read-swap.

### Phase 3 (Day 65 — Day 95) — Read swap on existing 37 queries
- Update `QUERY_TEMPLATES` to point at v1 datasets.
- v0 dataset still being written (compat for old self-hosted trackers + safety margin).
- `?shadow=true` reversed: `?legacy=true` triggers v0 read for debugging.
- `?schema=v0|v1` advanced parameter for self-hosters who pin to v0.
- **Risk gate**: 7 consecutive days no error rate spike, no user-visible drift in dashboard numbers.

### Phase 4 (Day 95 — Day 110) — Tracker compat-deprecate
- Worker stops dual-writing to v0 (only writes v1).
- Old self-hosted trackers continue working — worker translates legacy payloads to v1 server-side (canonical inferred from request URL).
- Self-host migration: `npx create-flarelytics migrate --to v1` updates wrangler.toml + redeploys.
- **Risk gate**: 14 consecutive days no new writes to v0; v0 enters read-only mode.

### Phase 5 (Day 110+) — v0 retired
- Legacy `flarelytics` dataset retained for historical queries via `?legacy=true` until natural retention expires.
- After retention expiry (≤ 90 days from last write), remove binding from `wrangler.toml`.

### Total elapsed
Day 0 → Day 110 active migration. Phase 0.5 adds 21 days of pilot validation but reduces risk of full-portfolio rollback.

---

## 5. Query mapping (v0 → v1)

All 37 queries are migrated. Most map cleanly because v1 carries a superset of v0 dimensions. A few queries get richer in v1.

Field renames in WHERE/SELECT (most queries): `blob1 → blob5` (path), `blob2 → blob6` (referrer_domain), `blob3 → blob14` (country), `blob9 → blob13` (visitor_hash), `blob10 → blob2` (site_id), `blob11 → blob15` (device), `blob12 → blob16` (browser). UTM kept as blob10/11/12 explicitly (Codex #9 fix). Site filter stays `WHERE blob2 = '${site}'`.

### Trivial 1:1 maps (use `flarelytics_pageview_v1`)
`top-pages`, `daily-views`, `daily-unique-visitors`, `referrers`, `countries`, `devices`, `browsers`, `top-pages-visitors`, `top-pages-stories`, `page-views-over-time`, `countries-by-page`, `referrers-by-page`, `utm-campaigns`, `utm-campaign-trend`, `utm-by-page`, `total-sessions`, `live-visitors`, `live-pages`, `live-referrers`, `hourly-today`, `new-vs-returning`.

### Engagement family (use `flarelytics_engagement_v1`)
`page-timing`, `timing-by-page`, `bounce-rate-by-page`, `scroll-depth`, `scroll-depth-by-page`, `scroll-depth-for-page`. These move out of pageview because they were always engagement signals.

### Custom events (use `flarelytics_custom_v1`)
`custom-events` migrates to flarelytics_custom_v1. No more `blob4 != 'pageview' AND blob4 != 'outbound'` cleanup hacks.

### Outbound + funnel
`outbound-links` migrates to share_v1. `conversion-funnel`, `funnel-by-event`, `page-performance` become application-side composed (multiple AE queries combined in `/query`). Each composed query documents which datasets it reads and the timing skew accepted between them (Codex #12).

### Bot family (use `flarelytics_bot_v1`)
`bot-hits`, `bot-hits-total`, `bot-pages`, `bot-daily`, `bot-countries`. Schema cleaner — no shared dataset with pageviews.

### New v1-only queries (no v0 equivalent)
`distribution-loop`, `social-post-traffic`, `content-graph-aggregated`, `distribution-quality-score`, `ai-actor-breakdown`.

### Schema-version filter (4A')

Every v1 query includes:
```sql
WHERE blob1 IN ('pv.v1.0')  -- exact list, append known versions on minor bumps
```
NOT `LIKE 'pv.v1.%'`. Exact matching forces conscious update on minor bumps and prevents silent aggregation across schema changes (Codex #11 fix).

A full table mapping every QUERY_TEMPLATES entry to its v1 SQL goes in `packages/worker/src/queries/v1/README.md` during implementation. **This is a Phase 1 deliverable, not deferred.**

---

## 6. Cutover criteria (gate every phase)

Before advancing from Phase N to Phase N+1, **all** of these must be true for ≥ 7 consecutive days (unless noted):

| Criterion | Phase 0.5→1 | Phase 1→2 | Phase 2→3 | Phase 3→4 | Phase 4→5 |
|---|---|---|---|---|---|
| Dual-write success rate ≥ 99.9% | (Kiiru) | ✓ | ✓ | ✓ | n/a |
| `/track` p99 ≤ Phase 0 baseline + 30% | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/track` 5xx rate ≤ Phase 0 baseline + 0.1% | ✓ | ✓ | ✓ | ✓ | ✓ |
| Per-query shadow drift within tolerance band | (30 samples Kiiru) | | ✓ | | |
| Distribution Loop view useful: ≥ 3 editorial decisions changed (14-day window) | ✓ | | | | |
| Dashboard p99 query latency ≤ Phase 0 baseline × 1.5 | | | ✓ | ✓ | ✓ |
| Queue depth p99 < 5000 | | ✓ | ✓ | ✓ | n/a |
| DLQ orphan rate < 0.1% of pageviews | | ✓ | ✓ | ✓ | n/a |
| No new writes to v0 dataset | | | | | ✓ |
| Self-host migration tested on ≥ 2 external installs | | | | | ✓ |

Any criterion failing for 3 consecutive days triggers automatic phase freeze: dual-emit continues, no further moves until investigated and resolved (or accepted with sign-off in this document).

**Phase 0.5 is special**: the "useful" criterion is qualitative — Kalle documents the 3 editorial decisions in this file before advancing. If Phase 0.5 fails the usefulness gate, return to /office-hours; do not roll out Phase 1.

---

## 7. Rollback

The migration is designed so any phase can be rolled back without data loss.

### Rollback levers
1. **Dual-write disable (Phase 1+):** flip env var `WRITE_V1=false`. Worker writes only to v0. Dashboard switches to `?schema=v0` until v1 re-enabled.
2. **Read swap revert (Phase 3+):** flip `READ_SCHEMA=v0`. Dashboard returns to v0.
3. **Tracker payload incompatibility:** v1 tracker payload is strict superset of v0. v1 → v0 worker rejected gracefully (worker ignores unknown fields). v0 → v1 worker fully supported (server-side enrichment fills gaps; canonical inferred from request URL).
4. **D1 dimension corruption:** D1 recoverable from daily R2 dump. Pageview events that referenced now-orphaned content_ids gracefully degrade to canonical_url_hash queries (always present).
5. **AE dataset issue:** dual-emit means v0 still receives every event. Read swap can be reverted in seconds. Lost v1 dataset can be reconstructed from R2 archives (see §8 — backfill is in scope only after Phase 0.5 validates the architecture).

### Hard rollback (full revert)
1. Set `WRITE_V1=false`, `READ_SCHEMA=v0`. Dashboard returns to v0 in one deploy.
2. Drop unused v1 datasets (or leave; they age out).
3. Retain MIGRATION_PLAN.md, document what failed, propose v2.

**Hard rollback is reversible up to Phase 4.** After Phase 5 (v0 retention expires), v0 data is gone. Treat the Phase 4 → 5 boundary as the point of no return.

---

## 8. NOT in scope for this plan

To stay focused on schema migration:
- **Distribution Quality Score weights and calibration.** Phase 0.5 ships a v0.1 score using guess weights. Calibration plan is separate.
- **Semantic Query Builder LLM prompt + template library.** v1 fixed-dimension model is the prerequisite. Builder is a separate design.
- **Dashboard UI design for new views.** Loop, Content Performance, Social Referrers, Article Scorecard need their own design (`/plan-design-review`).
- **AI-actor classifier table maintenance** beyond initial seed. Data-layer slot (`ai_actor`) is in scope; upkeep workflow is not.
- **R2 backfill of v0 history into v1 schemas.** AE rows are immutable. Backfill is possible only if v0 data is exported to R2 in raw form first. This is **deliberately deferred**: Phase 0.5 validates whether content_id-level history matters enough to invest in backfill.
- **Bot Management paid features.** v1 captures Cloudflare's free Bot Management headers. Paid Bot Management is a separate decision.
- **Distribution archives in R2 beyond DLQ + daily query-comparison logs.** Long-term raw event archive in R2 is **deferred** until retention pressure shows up.

---

## 9. Verifications & cost/risk appendix (run before Phase 1)

### Task A — AE limits verification (per Codex #16, #17) — **COMPLETE 2026-05-08**

Cloudflare AE limits (2026-04-23 docs + empirical):
- ≤ 20 blobs per data point ✓ verified
- ≤ 20 doubles per data point
- 1 index per data point ✓ verified
- 16 KB total blob bytes per data point ✓ verified — accepted 15,548 bytes intact
- 250 data points per Worker invocation
- **96 bytes per index value (NEW empirical finding — undocumented in CF docs)** — `writeDataPoint` throws `TypeError: writeDataPoint(): Size of indexes[0] exceeds 96 bytes` synchronously when exceeded.

**Verification harness**: `packages/worker/test-ae-limits/` — separate Workers service writing to a separate dataset (`flarelytics_ae_limits_test_v1`). Source kept in repo so re-runs are cheap when v1 schemas evolve. Three probe shapes (`max-realistic`, `schema-cap`, `stress`) emitted, then read back via SQL API to compare bytes-sent vs bytes-stored.

**Subtask A1** ✓ — Three probe rows emitted and round-tripped through AE intact:

| Probe | Total blob bytes | All 20 blobs preserved? | Notes |
|---|---|---|---|
| max-realistic | 1314 | ✓ pixel-perfect | typical heaviest production-shape row (Kiiru/Factyou pattern) |
| schema-cap | 1434 | ✓ pixel-perfect | every cap declared in §3 hit simultaneously |
| stress | 15548 | ✓ pixel-perfect | pushed near 16 KB ceiling; AE preserved every byte |

AE does not silently truncate below the documented 16 KB ceiling. Below that ceiling, blob bytes survive end-to-end without modification.

**Subtask A2** ✓ — Truncation policy locked. Per-blob caps live in §3 alongside each schema. Worst-case rows:

| Dataset | Worst-case row | Headroom vs 16 KB |
|---|---|---|
| pageview_v1 | 1545 B | 10.6× |
| engagement_v1 | 620 B | 26× |
| share_v1 | 340 B | 48× |
| bot_v1 | 285 B | 57× |
| performance_v1 | 660 B | 25× |
| custom_v1 | 1736 B | 9.4× |

`visitor_hash` clarification: v0 has always stored 16 hex chars (8 bytes), not the 64 hex chars the first draft of this plan asserted. v1 keeps 16 hex.

`user_agent` for `bot_v1` locked at **80 bytes** (down from v0's 200) — the additional 120 bytes never carried distinguishing info because UA strings are dominated by their first ~60 chars (engine + version).

`event_props_json` for `custom_v1` locked at **1024 bytes**. Worker rejects oversize props with HTTP 400 rather than truncating mid-JSON (truncated JSON is unparsable downstream).

**Subtask A3** ✓ — `/track` writes **2 data points per invocation** during dual-emit (1 legacy + 1 v1; the original "1 + N (typically 2)" claim was wrong — a single tracker event maps to a single v1 family). 125× headroom under the 250-per-invocation limit. Future tracker batching mode is still out of scope.

**Subtask A4 (added during verification)** ✓ — All v1 datasets must use `site_id sliced to 64 bytes` as the AE index value. The site_id blob can be the full hostname (≤ 64 bytes), but the index argument to `writeDataPoint({indexes: [...]})` must additionally be sliced to stay below the empirical 96-byte ceiling. The shared 64-byte index makes site_id-scoped queries identical across datasets.

**Cleanup**: test worker (`flarelytics-ae-limits-test`) and test dataset (`flarelytics_ae_limits_test_v1`) deleted after verification. Source retained in `packages/worker/test-ae-limits/`.

### Task B — `/track` p99 baseline measurement (P1A) — **COMPLETE 2026-05-08**

Captured p99 latency of the current (v0-only) `/track` endpoint under realistic load:

- Tooling: `k6` v1.0+ with `constant-arrival-rate` executor from Helsinki (non-CF region).
- Load: 100 RPS sustained for 5 minutes against `flarelytics-staging` (separate AE dataset `flarelytics_staging`, identical worker code as production).
- Total: 30,001 successful POST `/track` requests, 0 failures.
- Script: `packages/worker/perf/baseline-track.js` — kept in repo so re-runs are cheap.

**Baseline (locked):**

| Percentile | Latency |
|---|---|
| min | 6.17 ms |
| p50 (median) | 11.31 ms |
| avg | 11.54 ms |
| p75 | 12.40 ms |
| p90 | 13.53 ms |
| p95 | 14.44 ms |
| **p99** | **18.18 ms** |
| p99.9 | 53.66 ms |
| max | 101.16 ms |

**Derived risk gates:**

- **Phase 1 dual-emit p99 ceiling: ≤ 23.63 ms** (baseline × 1.30, per §6 cutover criterion). If exceeded, fall back to `ctx.waitUntil()` for v1 writes per §4 Phase 1 risk gate.
- p99 budget remaining for v1 emit code: **5.45 ms** (23.63 − 18.18). Comfortable for one extra `writeDataPoint` call (synchronous in JS but fire-and-forget at the network layer; observed cost in v0 today is sub-ms because writeDataPoint just enqueues to AE), but no slack for added I/O (D1 reads, queue.send retries on the hot path). This is why §0 1A locks `/track` to NOT call D1 — content_id minting is moved to the queue consumer.

Re-run after Phase 1 deploy with the same script and target the new dual-emit worker; document the dual-emit p99 alongside this baseline before promoting to Phase 2.

### Task C — Cloudflare Queues throughput sanity check (Codex #18) — **COMPLETE 2026-05-08**

Cloudflare Queues limits (2026-04-21 docs): 5,000 messages/sec per queue. `/track` peak load × 1 enrichment job per event must stay below this, or `queue.send()` will throw.

Current peak across portfolio: ~50 RPS aggregate (pre-A+ migration). Headroom: **100×**. Failure mode locked: if `queue.send()` throws, worker logs and continues (3A — best-effort); DLQ catches retries; drop is acceptable because the AE row is canonical (queue is enrichment-only, not source-of-truth).

### Task D — D1 row growth projection — **COMPLETE 2026-05-08**

Estimate (sites × contents × locales × known social posts) over 12 months:

- Sites: ~5 today → ~10 in 12 months
- Contents per site: ~500 today (Kiiru, Factyou) → ~2000 in 12 months
- Total content rows: ~20,000
- Translations doubling (fi/en for Factyou): + ~5,000
- Aliases (URL renames, redirects): ~30,000
- Social posts (one row per known Bsky/FB/HN/Reddit post the site has been shared on): ~10,000
- Share enrichment records: ~50,000
- **Total D1 row estimate: ~120,000 in 12 months**

D1 free tier: 5 million rows storage. **Headroom: 40×.** No paid plan needed for the 12-month horizon. Re-evaluate if portfolio grows past 20 sites or any single site exceeds ~5000 contents.

### Task E — R2 storage projection — **COMPLETE 2026-05-08**

DLQ daily logs + query-comparison samples: ~100 MB/month estimate. R2 free: 10 GB. **Headroom: 100×.** Re-evaluate when long-term raw event archive becomes in-scope (currently §8 deferred until retention pressure shows up).

### Task F — Self-host migration product surface — **COMPLETE 2026-05-08**

Codex #19: 6 AE datasets + D1 + Queues + R2 + migration is a substantial setup for `npx create-flarelytics migrate`. Rather than hide this complexity, the migration command:
- Generates the new wrangler.toml.
- Tells the user exactly which CF dashboard steps to take (D1 create, Queues create, R2 bucket create) with copy-pasteable commands.
- Is honest about the new infrastructure surface.

This is a deliberate documentation choice, not a regression. Self-hosters who only want privacy-first analytics can keep `?schema=v0` indefinitely. The decision is locked; no measurement required.

---

## 10. Open questions resolved by /plan-eng-review

| # | Question | Resolution |
|---|---|---|
| 1 | Custom events: own dataset or pageview-shared? | **5A** — Own dataset `flarelytics_custom_v1`. Total 6 v1 datasets. |
| 2 | Dual-write latency budget acceptable, or use `ctx.waitUntil()`? | **P1A** — Measure baseline first; default to synchronous; fall back to `waitUntil` if Phase 1 risk gate trips. |
| 3 | Backfill v0 history? | **Deferred** (§8). Phase 0.5 validates whether content-level history matters enough to invest. |
| 4 | Drop `referrer_url_hash`? | **Keep through Phase 1**, drop in Phase 2 if no consumer view emerges. |
| 5 | Tracker contract: host emits content_id explicitly, or worker derives? | Tracker emits **canonical_url** (not content_id). content_id is D1-managed, never emitted by tracker. (T1A clarification.) |
| 6 | Self-host migration UX | **§9 task F** — honest documentation, no hiding complexity. |

---

## 11. Testing requirements per phase (T1A)

35 test items below. Each phase deploy is gated on these passing.

### Phase 0 (Setup)
- **(unit)** wrangler.toml binding declarations validate
- **(unit)** D1 schema migration scripts up/down clean
- **(infra)** Task A AE limits verification: max-row test passes; truncation lengths documented
- **(infra)** Task B baseline p99 captured

### Phase 0.5 (Kiiru pilot — 14-day validation)

**/track endpoint:**
- **(unit)** Kiiru events dual-write to legacy + v1 (6 datasets) successfully
- **(unit)** Non-Kiiru events write only to legacy (v1 skip)
- **(unit)** /track latency: Kiiru p99 within 30% of Phase 0 baseline
- **(unit)** v1 write fail → legacy still succeeds (failsafe)
- **(unit)** Legacy fail → v1 still succeeds (forward-compat)

**content identity:**
- **(unit)** SHA256(canonical_url)[0:12] same input → same hash (determinism)
- **(unit)** Different canonical → different hash
- **(unit)** Trailing slash normalization, case normalization, fragment stripping
- **(unit)** Tracker payload missing canonical_url → fallback to request URL with `canonical_inferred='1'`

**Referrer resolver per platform:**
- **(unit)** `bsky.app/profile/X/post/Y` → `social_platform='bluesky'`, `social_post_id='X/post/Y'`
- **(unit)** `l.facebook.com/?u=...` → `social_platform='facebook'`, post_id from `story_fbid`
- **(unit)** `news.ycombinator.com/item?id=X` → `social_platform='hn'`, `social_post_id='X'`
- **(unit)** `reddit.com/r/X/comments/Y/...` → `social_platform='reddit'`, post_id from permalink
- **(unit)** `t.co/...` → `social_platform='x'`, `social_post_id=''` (2A)
- **(unit)** Mastodon any-instance pattern → `social_platform='mastodon'`, instance+post-ID
- **(unit)** Unknown referrer → `social_platform=''`

**Bot/AI classifier:**
- **(unit)** Known AI UA (e.g. ChatGPT-User) → ai_actor='chatgpt'
- **(unit)** Search bot → bot_class='search-bot'
- **(unit)** Human → bot_class='human', ai_actor=''

**Queue enrichment (3A):**
- **(integration)** Queue depth < 5000 → full enrichment runs (content_id minted, post_id resolved)
- **(integration)** Queue depth > 5000 → degrade to content_id minting only
- **(integration)** Enrichment timeout 30s → message routed to DLQ
- **(integration)** Cron retry DLQ once daily; orphan rate logged to R2

**Distribution Loop (Kiiru only):**
- **(E2E)** Synthetic article → outbound share → return-pageview from social referrer → loop view renders the path
- **(E2E)** Loop view performance: p99 < 2s for 30-day window on Kiiru data

**Editorial usefulness gate:**
- **(qualitative)** Kalle documents ≥ 3 editorial decisions changed by the Loop view in 14 days. Documented inline in this file under § "Phase 0.5 outcomes" before Phase 1 advance.

### Phase 1 (Full portfolio)
- **(integration)** Dual-write extends to all KV-allowlisted sites
- **(integration)** Tracker contract: canonical_url required, fallback flag works
- **(perf)** /track p99 across all sites within 30% of Phase 0 baseline
- **(integration)** Queue depth alarm fires above 5000

### Phase 2 (Read shadow + Loop full rollout)
- **(integration)** Cron shadow query: 100 random combos, per-query tolerance band passes (4A')
- **(integration)** Drift logged to R2 in documented schema
- **(unit)** schema_version exact filter: v1.0 + future v1.1 do NOT silently aggregate

### Phase 3 (Read swap)
- **(integration)** Each of 37 v0 queries: v1 result within tolerance band of v0 (deterministic queries match exactly)
- **(integration)** ?legacy=true returns v0 results when set
- **(integration)** ?schema=v0|v1 advanced parameter respected

### Phase 4 (Tracker compat-deprecate)
- **(integration)** Legacy tracker payload (no canonical_url) → worker derives canonical_url server-side, sets canonical_inferred='1'
- **(E2E)** `npx create-flarelytics migrate --to v1` on 2 sample self-host installations

### Rollback levers (smoke-tested before Phase 1)
- **(integration)** WRITE_V1=false → only legacy writes
- **(integration)** READ_SCHEMA=v0 → dashboard returns v0
- **(integration)** ?schema=v0|v1 query param works

### Regressions (IRON RULE — required, not optional)
For each of the 37 v0 queries: a regression test that proves v0 behavior is preserved through Phase 3 read-swap. If v0 query result and v1 query result diverge beyond tolerance band, the test fails. **No exceptions; no deferrals.**

---

## 12. Failure modes (Required output from review)

For each new codepath, one realistic production failure scenario:

| Codepath | Failure | Test? | Error handling? | User-visible? |
|---|---|---|---|---|
| /track AE multi-write | One v1 dataset write fails | yes | yes (failsafe to legacy) | no (silent) |
| /track canonical hash | canonical_url empty → fallback inferred | yes | yes (flag set) | no |
| Referrer resolver | Bsky URL parse bug → null post_id | yes | yes (graceful empty) | no |
| Queue send | Queue at quota → send throws | yes | yes (log + continue, AE row canonical) | no |
| Queue consumer | content_id mint D1 INSERT collides | yes | yes (idempotent UPSERT) | no |
| DLQ retry | Permanent enrichment failure | yes | yes (orphan logged to R2) | dashboard shows orphan rate |
| Dashboard D1 bulk lookup | D1 timeout on IN-clause | NO yet | NO yet | **CRITICAL GAP** — would silently drop content metadata |
| Loop view 3-tier query | One AE dataset slow, others fast | yes (perf) | yes (timeout per dataset) | dashboard shows partial Loop with timing-skew warning |

**Critical gap flagged**: dashboard D1 bulk lookup needs explicit timeout handling and a fallback path (skip metadata enrichment, render Loop with canonical_url labels rather than content titles). Add to Phase 1 implementation.

---

## 13. Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| (a) AE limits verification | infrastructure (test worker) | — |
| (b) Baseline p99 | k6/wrk script + staging | — |
| (c) D1 schema + migrations | packages/worker/migrations/ | — |
| (d) Queue worker + DLQ | packages/worker/src/enrich/ | (c) |
| (e) /track dual-emit logic | packages/worker/src/index.ts | (c), (d) |
| (f) Referrer resolver | packages/worker/src/referrer/ | — |
| (g) Tracker canonical_url emit | packages/tracker/ | — |
| (h) v1 query rewrites | packages/worker/src/queries/v1/ | (e) |
| (i) Loop view (Kiiru) | packages/dashboard/src/ + queries | (e), (h) |
| (j) Migration command | packages/cli/ | (e), (h) |

**Parallel lanes:**
- Lane A (infra): (a) → (c) → (d). Sequential.
- Lane B (track path): (e) → (h). Sequential, depends on Lane A's (c).
- Lane C (independent): (b), (f), (g). All parallel.
- Lane D (dashboard): (i). Depends on Lane B.
- Lane E (CLI): (j). Depends on Lane B's (h).

**Execution**: Lanes A, C in parallel worktrees first. Lane B starts when A completes (c). Lane D and E start when B completes. Conflict flag: Lane B (e) and Lane C (f) both touch packages/worker/ — coordinate via referrer resolver being a dedicated module that index.ts imports.

---

## 14. Phase 0.5 outcomes (filled at gate)

To be completed by Kalle after 14 days of Kiiru pilot use.

**Editorial decision 1 changed by Loop view:** _______
**Editorial decision 2 changed by Loop view:** _______
**Editorial decision 3 changed by Loop view:** _______

**Verdict:** ☐ ADVANCE TO PHASE 1   ☐ RETURN TO /office-hours
**Reasoning:** _______

---

## 15. Approved Mockups

| Screen | Mockup Path | Direction | Notes |
|---|---|---|---|
| Distribution Loop | `~/.gstack/projects/kalle-works-flarelytics/designs/distribution-loop-20260508/variant-A.png` | Storytelling table — one row per article showing full loop (shares-out → inbound visits → engaged reads → secondary shares → quality score) | Variant A chosen because the "shows the full loop" tagline makes purpose unmistakable; scroll-depth bar in Engaged Reads column visualizes engagement; accent #dc6b14 only on numbers |
| Content Performance | `~/.gstack/projects/kalle-works-flarelytics/designs/content-performance-20260508/variant-A.png` | Database-style content table with content_id rollup, locale pills, decay sparkline, Quality Score accent column | Variant A chosen because locale pills (fi/en) make translations-handling visible at a glance; decay sparkline carries lift annotation; empty state present |
| Article Scorecard | `~/.gstack/projects/kalle-works-flarelytics/designs/article-scorecard-20260508/variant-C.png` | Single-page article deep-dive — header card with Quality Score, KPI strip, two-column grid (Distribution / Engagement) with bar chart, scroll funnel, sparkline | Variant C chosen because article title visible, Read Depth uses DESIGN.md horizontal funnel bars (not pyramid), Outbound Shares bar chart with accent fill, Inbound Social Referrers list, all required components present |

These are the visual references for implementation. Implementer reads them via the Read tool to know exactly what to build. Mockups persist across conversations and workspaces.

---

## 16. Dashboard design specifications

These specifications cover the three killer views (Distribution Loop, Content Performance, Article Scorecard) at full depth. Lighter-touch coverage for Portfolio Overview, Social Referrers, AI & Crawlers sidebar at the end. All decisions calibrated against `DESIGN.md` (Industrial/Developer-First, Light + Burnt Orange #dc6b14, mono UI labels, dark CTAs, compact density).

### 16.1 Distribution Loop view

**Information hierarchy (Pass 1):**
1. Filter row (site switcher + time range + platform) — orient the user
2. KPI strip — answers "is the loop working overall?"
3. Loop table — answers "which articles drive the loop?"
4. Recent Loops link — escape hatch into chronological feed

**Layout grid (desktop ~1200px max content width 880px from DESIGN.md):**
- KPI strip: 4 cards × ~190px wide × 88px tall, 16px gap
- Loop table: 100% width, one row per article (~60px tall each), 8 visible
- Mobile (< 768px): KPI strip stacks 2×2; Loop table collapses to vertical card-per-article with arrows replaced by labeled rows

**Interaction states:**
| State | Specification |
|---|---|
| **Loading** | KPI cards: skeleton blocks (label visible, value as gray bar 40% width). Loop rows: 3 skeleton rows. NO spinner. Skeleton shimmer animation 1200ms (within DESIGN.md motion guidelines) |
| **Empty (zero events in period)** | "No distribution loops yet for this period. As articles are shared and readers return, loops appear here." Centered, mono 14px muted, no illustration. Sub-link "Try expanding to 30 days →" in accent text #b45309 |
| **Empty (site has no events ever)** | "Tracker not detected on this site. Last 7 days: 0 events." Mono 14px muted + secondary link "Setup guide →" #b45309 |
| **Error (query failed)** | Inline banner above content area: 1px border-error #dc2626, 8px padding, 6px radius, white surface. Mono 12px: "Couldn't load Distribution Loop. The Cloudflare Analytics Engine SQL API timed out." Below: "Retry" small text-link #b45309. NO modal, NO toast |
| **Partial (some queries failed, others succeeded)** | KPI cards that succeeded show data; failed ones show "—" with small ⚠ tooltip "Couldn't load this metric." Loop table renders rows that succeeded |
| **Success** | Full data render. Hover row: bg #fafaf9, cursor pointer. Click: open Article Scorecard for that content_id |

**User journey emotional arc (Pass 3):**
- 0–5s (visceral): user sees "this dashboard knows what it's about" — KPI strip immediately answers "is the loop working?" with one number (Avg Distribution Quality Score)
- 5min (behavioral): user finds an article with high inbound visits but low secondary share rate → drills down → adjusts editorial direction
- 5y (reflective): user has built a habit of opening the Loop view weekly to validate distribution decisions

**AI slop avoidance (Pass 4) — applied:**
- ❌ No 3-column icon-in-circle feature grid (KPI strip uses 4-column data cards, no icons)
- ❌ No purple/violet (only burnt orange + greyscale)
- ❌ No centered everything (left-aligned section headers, table is left-aligned)
- ❌ No emoji
- ❌ No bubbly border-radius (6px cards, 4px inline)
- ❌ No orange CTAs (only "Recent Loops →" as small text-link in #b45309)
- ❌ No carousel
- ❌ No decorative blobs

**DESIGN.md alignment (Pass 5):**
- Typography: SF Mono / Fira Code for all UI labels and numbers; system UI for "Each row shows the full loop..." tagline
- KPI cards use existing pattern (mono uppercase 10px label, 28px mono value)
- Engaged Reads scroll-depth bar uses existing scroll-depth-funnel component (accent fill, stone-600 unfilled, 6px tall)
- Quality Score conditional color: accent #dc6b14 if ≥ 7, near-black #1c1917 if 5–6.9, muted #78716c if < 5

**Responsive (Pass 6):**
| Viewport | Behavior |
|---|---|
| Desktop (≥ 1024px) | Full table, 8 rows visible |
| Tablet (768–1023px) | KPI strip stays 4-wide; table compresses (Engaged Reads column drops scroll bar, shows % only) |
| Mobile (< 768px) | KPI strip → 2×2 grid; Loop table → vertical card-per-article, arrows become labeled vertical sections (`Shares Out / Inbound Visits / Engaged Reads / Secondary Shares / Score`) |

**Accessibility (Pass 6):**
- Keyboard: Tab cycles filter row → KPI cards (focusable for tooltips) → table rows. Enter on row opens scorecard. Esc closes scorecard.
- ARIA: filter row `role="region" aria-label="Filters"`. KPI cards `role="status"` so screen readers announce updates on time-range change. Table `role="table"` with proper `<th scope="col">` headers.
- Contrast: all text ≥ 4.5:1 (already verified in DESIGN.md). Quality Score color signals via background tag, NOT color alone (e.g., "≥7" tag).
- Touch targets: row tap area ≥ 44px tall (already 60px).
- Focus rings: 2px solid #dc6b14, 2px offset (NOT default browser blue).

### 16.2 Content Performance view

**Information hierarchy:**
1. Section header + tagline — what this view is
2. Content table — primary content
3. Empty state hooks at the bottom

**Layout grid:**
- Section header full-width, 24px below filter row
- Table 100% width, sortable columns, 6–8 visible rows + pagination
- Mobile: table → vertical cards, locale pills move under article title

**Interaction states:**
| State | Specification |
|---|---|
| **Loading** | 5 skeleton rows. Header columns visible. NO spinner |
| **Empty (no content tracked)** | "No content tracked yet. Articles appear here as soon as they receive traffic." Centered mono 14px muted. Below: "Connect a tracker →" #b45309 (matches mockup) |
| **Empty (filtered to zero results)** | "No content matches the current filter. Try a wider date range." Mono 13px muted |
| **Error** | Inline banner pattern (same as Loop view) |
| **Sortable column states** | Default sort by Views desc. Click column header: arrow indicator 8px mono. Hold shift: secondary sort. Sort state persists via URL param `?sort=quality_score:desc` |
| **Hover row** | bg #fafaf9, cursor pointer. Click: opens Article Scorecard |
| **Locale pill** | Inline next to title. Pill bg #fffbeb, text #92400e, 4px radius, 8px horizontal padding, 9px mono font, uppercase locale code |
| **Multi-URL count** | If `> 1` canonical_url maps to this content_id: small mono "3 URLs" label below title in #78716c. Hover → tooltip lists URLs |

**Decay sparkline spec:**
- 60px wide × 20px tall inline SVG
- Accent #dc6b14 stroke 1.5px, accent at 30% opacity area fill below
- No axis, no labels — pure visual cue
- Annotation below: `8.2x lift first-24h` in 11px mono muted

**Responsive:**
- Desktop: full table
- Tablet: drop "Decay 1d→7d" column; show only the lift annotation
- Mobile: table → vertical cards. Each card: title + locale pills, then KPI rows stacked (`Views | Visitors | Quality`)

**Accessibility:**
- Sortable headers: `aria-sort="ascending|descending|none"`
- Locale pills: `<abbr title="Finnish">fi</abbr>` for screen readers
- Sparkline: `role="img" aria-label="Visit decay: 8.2× lift in first 24 hours, declining over 7 days"`

### 16.3 Article Scorecard view

**Information hierarchy:**
1. Breadcrumb back to Content Performance
2. Article header card with Quality Score (centerpiece)
3. KPI strip
4. Two-column Distribution / Engagement grid

**Layout grid:**
- Breadcrumb 24px tall mono 11px
- Article header card: 88px tall, full width, Quality Score block 80×80px right-aligned
- KPI strip: 4–5 cards 20% width each
- Two-column grid: 50/50 split, 24px gutter
- Mobile: header card stacks (title above score), KPIs 2×2/2×3, two columns become single column

**Interaction states:**
| State | Specification |
|---|---|
| **Loading** | Quality Score skeleton block, KPI skeleton, charts as gray placeholder rectangles |
| **Empty (article exists but no events)** | "This article has no recorded views yet. Check the canonical URL matches the tracker payload." Centered card area; rest of layout (header, breadcrumb) renders normally |
| **Error** | Inline banner. Per-section error fallback: bar chart fails → "Couldn't load shares" placeholder; sparkline fails → "Couldn't load decay" placeholder |
| **Partial** | Render whatever loaded; show "—" or fallback on missing sections |
| **Success** | Full render. Read depth bars use existing scroll-depth-funnel component. Visit decay = sparkline. Inbound Social Referrers = list with platform glyph + post-id (truncated) + visit count + avg engaged time |

**Quality Score block:**
- 80×80px square, 6px radius, 1px border #e7e5e4, white surface
- Number: 36px mono near-black if 5–6.9, accent #dc6b14 if ≥ 7, muted #78716c if < 5 (matches mockup)
- Label below: "QUALITY SCORE" mono uppercase 9px muted

**Outbound Shares bar chart:**
- Horizontal bar per platform (Bluesky, Facebook, X, LinkedIn, etc.)
- Accent #dc6b14 fill
- Mono labels left ("Bluesky", "Facebook", ...), values right ("12", "8", ...)
- Bar height 14px, 4px gap between bars

**Read Depth scroll-funnel:**
- 4 horizontal bars at 25/50/75/100% milestones
- Existing scroll-depth-funnel component: 6px tall, accent fill on reached %, stone-600 unfilled
- Label left mono 11px ("25%", "50%", "75%", "100%"), value right ("87% reached", "64%", ...)

**Visit Decay sparkline:**
- 100% width × 60–80px tall SVG
- Accent stroke 1.5px, 30% opacity area fill
- X-axis labels: "Day 1", "Day 7", "Day 14" mono 9px muted
- No y-axis

**Engaged Seconds Distribution:**
- Compact histogram (10 bars × 12px wide, 60px tall total)
- Accent fill
- Mono summary text below: "Median: 1:42 · P95: 6:30"

**Inbound Social Referrers list:**
- Each row: platform glyph (8×8px monospace letter `B`/`F`/`X`/`L` in muted box), social_post_id (truncated `did:plc:...post/abc...` mono 11px), `78 visits` mono 11px, `avg 4:12 engaged` mono 11px muted
- 5 visible rows + "show all →" small text-link in #b45309

**Responsive:**
- Desktop: 50/50 two-column grid
- Tablet: keep two-column but compress charts
- Mobile: single column, score block moves below title (no longer right-aligned)

**Accessibility:**
- Quality Score block: `role="meter" aria-valuenow="84" aria-valuemin="0" aria-valuemax="100" aria-label="Distribution Quality Score"`
- Bar charts: `role="img" aria-label="Outbound shares by platform: Bluesky 12, Facebook 8, X 4, LinkedIn 1"`
- Read Depth funnel: list semantics with each milestone as `<li>`
- All interactive elements (View live article, Compare to average, Export) keyboard-reachable, focus rings 2px accent

### 16.4 Lighter-touch views (specs added but no mockups)

**Portfolio Overview** — extends current dashboard pattern. Adds:
- KPI: "Distribution Quality Score (avg across portfolio)" mono accent
- Stacked-card per site: site name, top 3 metrics, click → site-scoped dashboard
- Empty state: "No sites yet. Add your first site." link → site switcher add form

**Social Referrers** — adapts existing referrer-list pattern. Adds:
- Per-platform group header (Bluesky / Facebook / HN / Reddit / Mastodon / X / Other)
- Within each group: post-ID rows (mono truncated 11px), visit count, landing article (link)
- Sortable by visit count
- Empty: "No social referrers yet for this period."

**AI & Crawlers (sidebar)** — opt-in panel, NOT main nav. Toggle in dashboard settings. When active:
- Right sidebar 280px wide on desktop (collapses to bottom drawer on mobile)
- Sections: "Human vs Bot Traffic" (small bar chart, accent + stone-600), "Top AI Actors" (list of `chatgpt 234 / claude-web 87 / perplexity 23 / unknown-ai 41`), "Most-Crawled Content" (top 5 article list)
- This section is sidebar-only until promoted (Phase 0.5+ premium criterion: AI traffic changes ≥1 editorial decision per 14 days)

### 16.5 Cross-view design decisions

**Time-range picker (used in all views):**
- Mono pill row: "7d / 14d / 30d / 90d / All"
- Active pill: dark bg #1c1917, white text
- Inactive: white surface, 1px border #e7e5e4, mono #57534e
- Hover inactive: border #1c1917
- 30px height, 4px radius, 12px horizontal padding

**Drill-down navigation:**
- All Article Scorecard entry points (Loop row click, Content Performance row click) use the same modal-or-route pattern
- Phase 0.5 implementation: full route `/article/<content_id>` (deep-linkable, shareable). Modal overlay deferred to Phase 2 if needed.

**Empty states (universal pattern):**
- Centered text, mono 14px muted
- Optional sub-link in #b45309
- NO illustration, NO emoji, NO 3D blob, NO stock photo
- 64px vertical padding minimum

### 16.6 Unresolved design decisions (to be tracked)

| Decision | If deferred, what happens |
|---|---|
| Filter row exact composition for Loop view (date + platform sufficient, or also locale/content_type?) | Engineer ships date+platform only; future expansion easy |
| Article Scorecard: render as full route or modal? Plan defaults route — confirm before Phase 0.5 implementation | Defaults to route (deep-linkable). Modal pattern available later |
| Recent Loops link target — chronological feed or just expanded table? | Chronological feed by default. Table expansion is fallback if list view doesn't add value |
| Distribution Quality Score visualization in Loop table — number alone or also a small bar/dial? | Number alone (matches mockup). Reconsider if user testing shows poor scanability |
| AI & Crawlers sidebar promotion criterion — what specifically counts as "changes editorial decision"? | Kalle documents in §14 Phase 0.5 outcomes. If absent, sidebar stays sidebar indefinitely |

These are not blockers — defaults exist for each. Surface in `/design-review` after implementation if visual QA flags concerns.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | not run (diff-level) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 12 issues found, all resolved (7 architecture, 1 quality, 1 test, 2 perf, 2 cross-model tensions); 1 critical gap flagged (D1 bulk lookup timeout handling — Phase 1 implementation requirement) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (FULL) | initial 2/10 → final 9/10; 3 mockups generated and approved (Distribution Loop A, Content Performance A, Article Scorecard C); §15 + §16 added with hierarchy, state tables, mobile breakpoints, a11y per view; 5 unresolved decisions captured as defaults (§16.6) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | not run |
| Outside Voice | `/plan-eng-review --outside` | Independent plan challenge | 1 | CHALLENGED | Codex found 20 issues; 18 corrections applied to plan; 2 cross-model tensions resolved (T1A content_id semantics, T2A pilot-first sequencing) |

**CODEX:** 20 findings; 8 critical (5A consistency, 1A async contradiction, content_id semantics, canonical_url derivation, translations, share enrichment immutability, outbound URL privacy, AE byte/blob limits); 18 applied directly; 2 surfaced as user decisions (content_id semantics, pilot-first sequencing) — both accepted.

**CROSS-MODEL:** Claude review and Codex agreed on most decisions. Codex challenged premise #4 in /office-hours (AI-bot pillar) which the user accepted. Codex challenged content_id semantics in /plan-eng-review which the user resolved with T1A (canonical_url_hash in AE, content_id in D1). Codex challenged Phase 0 scope in /plan-eng-review which the user resolved with T2A (Phase 0.5 Kiiru pilot).

**UNRESOLVED:** 0

**VERDICT:** ENG CLEARED (PLAN) — design review recommended next for Loop view, Content Performance, and Article Scorecard before Phase 0.5 implementation begins.
