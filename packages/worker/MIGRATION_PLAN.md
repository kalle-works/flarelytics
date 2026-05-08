# Flarelytics A+ Migration Plan: v0 → v1 schema

Status: DRAFT — to be defended in `/plan-eng-review` before any A+ implementation begins
Target architecture: see `~/.gstack/projects/kalle-works-flarelytics/kalle-main-design-20260508-094109.md`
Author: Kalle
Last updated: 2026-05-08

This document is the load-bearing decision for A+. It describes how the existing 12-blob Analytics Engine events coexist with the new versioned per-family event schemas for 90 days, exactly which queries change, and what rollback looks like. **No A+ code is written until this plan is reviewed and locked.**

---

## 1. Why this is the first thing

Every other A+ deliverable (D1 dimensions, content graph, Distribution Loop view, semantic Query Builder, Distribution Quality Score) reads from Analytics Engine. The data model is upstream of all of them. If migration is wrong, every downstream feature is built on sand. If migration is right, A+ falls into place.

Cloudflare Analytics Engine constraints that drive the plan:
- A single AE dataset has a fixed implicit schema — if you change blob meanings mid-stream, historical queries break silently.
- AE rows are immutable. No `UPDATE`. No re-statement.
- Standard retention is bounded (typically 90 days). After cutover, legacy data ages out naturally.
- AE does not support cross-dataset joins efficiently. Queries must hit one dataset at a time.

These constraints mean the migration is **dataset-level**, not column-level. New event families get new datasets. Legacy stays on the old dataset until it ages out.

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
| blob9 | visitor hash (daily-rotating SHA-256) |
| blob10 | site hostname (REQUIRED in every WHERE) |
| blob11 | device type (`mobile`/`tablet`/`desktop`) |
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
| blob5 | UA truncated to 200 chars |
| blob6–9 | "" |
| blob10 | site hostname |
| blob11–12 | "" |
| double1 | 1 |
| double2 | 0 |

### v0 query surface
37 named queries in `QUERY_TEMPLATES` (`packages/worker/src/index.ts`). All assume the v0 schema. All must include `AND blob10 = '${site}'`.

### v0 limits forcing migration
- **All 12 blobs are spoken for.** No room for `social_post_id`, `content_id`, `ai_actor`, `share_id`, etc.
- **`blob5` is freeform pipe-separated.** Not parseable in SQL without fragile string ops.
- **No content stability across URL changes or translations.** `blob1` (path) is the de facto content key. Factyou fi/en versions of the same article are two different rows. Kiiru URL renames break all historical aggregations for that article.
- **Mixed event shapes in one dataset.** `bot_hit` reuses slots with different meanings — every query must filter by `blob4` first to avoid garbage.
- **Distribution Loop, Content graph, and Distribution Quality Score are unbuildable on v0.**

---

## 3. v1 target schema (per-family datasets)

Five new AE datasets, one per event family. Each has a fixed, documented schema. `schema_version` is `blob1` in every family so future v1.x changes are detectable in-stream.

`schema_version` format: `<family>.v<major>.<minor>`. Example: `pv.v1.0`. Major bumps require a new dataset. Minor bumps are backwards-compatible additions to existing-but-unused slots.

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
```

### `flarelytics_pageview_v1`
| Slot | Field | Notes |
|---|---|---|
| blob1 | schema_version | `pv.v1.0` |
| blob2 | site_id | KV-backed identifier (`kiiru.fi`) |
| blob3 | content_id | D1-managed stable id; falls back to `canonical_url_hash` if D1 lookup misses |
| blob4 | canonical_url_hash | SHA-256 of canonical URL (16 hex chars) |
| blob5 | path | for human-readable queries |
| blob6 | referrer_domain | `bsky.app`, `m.facebook.com`, `direct` |
| blob7 | referrer_url_hash | SHA-256 of full referrer URL (16 hex) |
| blob8 | social_platform | `bluesky`, `facebook`, `hn`, `reddit`, `linkedin`, `mastodon`, `null` |
| blob9 | social_post_id | extracted at ingestion (e.g. `did:plc:xxx/post/yyy`); empty if no platform match |
| blob10 | visitor_hash | daily-rotating SHA-256 (unchanged from v0) |
| blob11 | country | from CF |
| blob12 | device_type | `mobile`/`tablet`/`desktop` |
| blob13 | browser | unchanged |
| blob14 | bot_class | `human`/`search-bot`/`ai-crawler`/`unknown-bot` |
| blob15 | ai_actor | `chatgpt`/`claude-web`/`perplexity`/`gemini`/`bingai`/`unknown-ai`/`null` |
| blob16 | locale | `fi`/`en`/etc. |
| blob17 | content_type | `article`/`page`/`landing`/etc. |
| blob18 | source_medium | `utm_source/utm_medium` joined; empty if no UTM |
| double1 | event_count | always 1 |
| double2 | viewport_width | px |
| double3 | viewport_height | px |
| index | site_id | required-in-every-WHERE remains |

### `flarelytics_engagement_v1`
Captures scroll-depth and timing as engagement-grade events. `blob1`–`blob10` mirror pageview (schema_version, site_id, content_id, canonical_url_hash, path, referrer_domain, referrer_url_hash, social_platform, social_post_id, visitor_hash). Then:
| Slot | Field |
|---|---|
| blob11 | engagement_type | `scroll_depth`/`timing`/`read_complete` |
| double1 | event_count |
| double2 | scroll_depth | 0–100 |
| double3 | engaged_seconds | seconds visible/active |

### `flarelytics_share_v1`
Outbound clicks tagged as shares (and any explicit share-button events).
| Slot | Field |
|---|---|
| blob1 | schema_version (`share.v1.0`) |
| blob2 | site_id |
| blob3 | content_id (the source article being shared) |
| blob4 | canonical_url_hash |
| blob5 | share_target_platform | `bluesky`/`facebook`/`x`/`linkedin`/`email`/`copy_link`/`other` |
| blob6 | share_target_url | full destination URL |
| blob7 | share_target_post_id | if known after enrichment (rarely available outbound; usually filled later via inbound match) |
| blob8 | share_id | UUID generated at click time |
| blob9 | visitor_hash |
| blob10 | country |
| blob11 | device_type |
| blob12 | browser |
| double1 | event_count |

### `flarelytics_bot_v1`
| Slot | Field |
|---|---|
| blob1 | schema_version (`bot.v1.0`) |
| blob2 | site_id |
| blob3 | path |
| blob4 | bot_class |
| blob5 | ai_actor |
| blob6 | user_agent (200 chars) |
| blob7 | country |
| blob8 | referrer_domain |
| double1 | event_count |

### `flarelytics_performance_v1`
| Slot | Field |
|---|---|
| blob1 | schema_version (`perf.v1.0`) |
| blob2 | site_id |
| blob3 | content_id |
| blob4 | canonical_url_hash |
| blob5 | path |
| blob6 | device_type |
| blob7 | browser |
| blob8 | country |
| double1 | event_count |
| double2 | page_load_ms |
| double3 | ttfb_ms |
| double4 | dom_interactive_ms |

---

## 4. The 90-day dual-schema period

### Phase 0 (Day 0) — Setup, no traffic change
- Provision the 5 new AE datasets in Cloudflare dashboard.
- Add the 5 new bindings in `wrangler.toml`.
- Add D1 binding `DIMENSIONS` with empty schema; `content`, `content_aliases`, `content_translations`, `social_posts`, `referrer_mappings` tables created but unused.
- Deploy. v0 keeps writing to `flarelytics`. Nothing else changes. No tracker change.
- **Risk gate**: deploy must not change `/track`, `/query`, or `/public-stats` behavior. Smoke tests pass identically.

### Phase 1 (Day 0 — Day 14) — Worker dual-emit
- Worker accepts the same `/track` payload as today.
- For every event, the worker writes to **both** the legacy `flarelytics` dataset (unchanged blob layout) **and** the appropriate new v1 dataset.
- D1 dimensions are populated lazily on first contact: a new content_id is minted when an unseen `canonical_url` arrives; subsequent events reuse it.
- The tracker does not need to change yet. v1 fields the tracker doesn't emit are derived server-side (`bot_class`, `ai_actor` from headers; `content_id` from URL via D1 lookup; `social_platform`/`social_post_id` from referrer parser; `locale` and `content_type` from D1 dimension default if not provided).
- **Risk gate**: dual-write must not increase `/track` p99 latency by more than 30%. If it does, move the v1 write into a `ctx.waitUntil()` (fire-and-forget), trading immediate-consistency for latency.

### Phase 2 (Day 14 — Day 45) — Read shadow + Loop view build
- Build the Distribution Loop view, Content Performance view, Social Referrers view **only against v1 datasets**. They cannot exist on v0.
- For every existing v0 query in `QUERY_TEMPLATES`, write a parallel v1 query and add a `?shadow=true` switch on `/query` that runs both and returns a diff in the response body.
- The dashboard does not yet read v1 for the existing 37 queries — only the new views (Loop, Content Performance, Social Referrers, Article Scorecard) read v1.
- Daily cron job samples 100 random query/site/period combinations and logs `(v0_result, v1_result, abs_diff_pct)` to R2 for analysis.
- **Risk gate**: at end of Phase 2, abs_diff_pct < 1% for ≥ 95% of sampled query combos for 7 consecutive days. If not, freeze and investigate before Phase 3.

### Phase 3 (Day 45 — Day 75) — Read swap on existing 37 queries
- Update `QUERY_TEMPLATES` to point at v1 datasets. Each of the 37 queries gets a v1 rewrite — see § 5 for the full mapping.
- v0 dataset is still being written to (compat for old self-hosted trackers + safety margin), but no longer read by the dashboard.
- The `?shadow=true` flag is reversed: `?legacy=true` now triggers a v0 read for debugging.
- Add `?schema=v0|v1` advanced parameter for self-hosters who pin to v0 for any reason.
- **Risk gate**: full v1 read for 7 consecutive days with no error rate spike (p99 latency, 5xx rate) and no user-visible drift in dashboard numbers.

### Phase 4 (Day 75 — Day 90) — Tracker compat-deprecate
- New `flarelytics` tracker bundle still emits the same `/track` payload (no breaking change client-side).
- Worker stops dual-writing to v0 (only writes to v1 now).
- Old self-hosted trackers continue to work — the worker translates their payload to v1 transparently.
- Self-hosters running `npx create-flarelytics migrate` get an updated `wrangler.toml` and a deploy that turns off v0 writes for their installation.
- **Risk gate**: no new writes to v0 dataset for 14 consecutive days. v0 dataset enters read-only mode (no binding write path).

### Phase 5 (Day 90+) — v0 retired
- Legacy `flarelytics` dataset retained for historical queries via `?legacy=true` until natural retention ages out (≤ 90 more days from last write).
- After total retention expiry, the binding can be removed from `wrangler.toml`. Document the date.

### Total elapsed
Day 0 → Day 90 active migration. Day 90 → Day 180 legacy data ages out naturally. **No v0 reads from the dashboard after Day 75.**

---

## 5. Query mapping (v0 → v1)

All 37 queries are migrated. Most map cleanly because v1 is a superset of v0 dimensions. A few queries get richer in v1 (e.g. `referrers` can now expose `social_post_id`).

### Trivial 1:1 maps (use `flarelytics_pageview_v1`)
`top-pages`, `daily-views`, `daily-unique-visitors`, `referrers`, `countries`, `devices`, `browsers`, `top-pages-visitors`, `top-pages-stories`, `page-views-over-time`, `countries-by-page`, `referrers-by-page`, `utm-campaigns`, `utm-campaign-trend`, `utm-by-page`, `total-sessions`, `live-visitors`, `live-pages`, `live-referrers`, `hourly-today`, `new-vs-returning`.

Field renames in WHERE/SELECT: `blob1 → blob5` (path), `blob2 → blob6` (referrer_domain), `blob3 → blob11` (country), `blob10 → blob2` (site_id is now blob2), `blob9 → blob10` (visitor_hash slot moved). The site filter stays `WHERE blob2 = '${site}'`.

### Engagement family (use `flarelytics_engagement_v1`)
`page-timing`, `timing-by-page`, `bounce-rate-by-page`, `scroll-depth`, `scroll-depth-by-page`, `scroll-depth-for-page`. These move out of pageview because they were always engagement signals — not page loads.

### Custom + outbound (use `flarelytics_pageview_v1` for custom; `flarelytics_share_v1` for outbound classified as shares)
`custom-events` stays on pageview dataset (custom events are a different `event_type` row in v1 pageview — TBD: confirm during /plan-eng-review whether custom events deserve their own dataset). `outbound-links` migrates to share_v1.

### Funnel + page performance
`conversion-funnel`, `funnel-by-event`, `page-performance` remap to combinations of pageview + engagement + share datasets. AE doesn't join cross-dataset, so funnel queries become two queries combined application-side. The `/query` endpoint composes them.

### Bot family (use `flarelytics_bot_v1`)
`bot-hits`, `bot-hits-total`, `bot-pages`, `bot-daily`, `bot-countries`. Schema is cleaner — no more shared dataset with pageviews.

### New v1-only queries (not in v0)
`distribution-loop`, `social-post-traffic`, `content-graph-aggregated`, `distribution-quality-score`, `ai-actor-breakdown`. These have no v0 equivalent and are net-new.

A full table mapping every QUERY_TEMPLATES entry to its v1 SQL goes in `packages/worker/src/queries/v1/README.md` during implementation.

---

## 6. Cutover criteria (gate every phase)

Before advancing from Phase N to Phase N+1, **all** of these must be true for ≥ 7 consecutive days:

| Criterion | Phase 1→2 | Phase 2→3 | Phase 3→4 | Phase 4→5 |
|---|---|---|---|---|
| Dual-write success rate ≥ 99.9% | ✓ | ✓ | ✓ | n/a |
| `/track` p99 latency within 30% of baseline | ✓ | ✓ | ✓ | ✓ |
| `/track` 5xx rate ≤ baseline + 0.1% | ✓ | ✓ | ✓ | ✓ |
| Shadow query abs_diff_pct < 1% on ≥ 95% sampled combos | | ✓ | | |
| Distribution Loop view returns expected results for known-good test articles | | ✓ | ✓ | ✓ |
| Dashboard p99 query latency within 50% of baseline (v1 may be slower in cross-dataset funnels — accepted up to limit) | | | ✓ | ✓ |
| No new writes to v0 dataset | | | | ✓ |
| Self-hoster migration command (`npx create-flarelytics migrate`) tested on at least 2 external installations | | | | ✓ |

Any criterion failing for 3 consecutive days triggers an automatic phase freeze: dual-emit continues, but no further migration moves until the issue is investigated and either resolved or explicitly accepted (with sign-off in this document).

---

## 7. Rollback

The migration is designed so any phase can be rolled back without data loss.

### Rollback levers
1. **Dual-write disable (Phase 1+):** flip env var `WRITE_V1=false`. Worker resumes writing only to v0. New v1 dataset stops growing. Dashboard switches off v1 reads via `?schema=v0` until v1 is re-enabled.
2. **Read swap revert (Phase 3+):** flip `READ_SCHEMA=v0`. Dashboard reads return to v0. v1 datasets continue to be written if dual-emit is on.
3. **Tracker payload incompatibility:** v1 tracker payload is a strict superset of v0. A v1 tracker reporting to a v0 worker is rejected gracefully (worker ignores unknown fields). A v0 tracker reporting to a v1 worker is fully supported (server-side enrichment fills the gaps). No tracker version is "stranded."
4. **D1 dimension corruption:** D1 is recoverable from the daily R2 dump. If `content` table corrupts, restore from previous day; pageview events that referenced now-orphaned `content_id`s will gracefully degrade to `canonical_url_hash` (which is always written alongside).
5. **AE dataset issue:** if a v1 dataset becomes unwriteable, dual-emit means v0 is still receiving every event. Read swap can be reverted to v0 in seconds. The lost v1 dataset can be recreated and back-filled from R2 archives if desired (acceptable to not back-fill — v0 has the data for ≤ 90 days regardless).

### Hard rollback (full revert)
If a fundamental design flaw surfaces during migration:
1. Set `WRITE_V1=false`, `READ_SCHEMA=v0`. Dashboard returns to v0 in one deploy.
2. Drop unused v1 datasets (or leave them; they age out).
3. Retain the MIGRATION_PLAN.md, document what failed, propose a v2.

**Hard rollback is reversible up to Phase 4.** After Phase 5 (v0 retention expires), v0 data is gone and rollback is no longer possible. Treat the Phase 4 → 5 boundary as the point of no return.

---

## 8. What this plan deliberately does NOT cover

To stay focused on schema migration, the following A+ work items are explicitly out of scope here and will be planned separately:

- **Distribution Quality Score weights and calibration.** The v1 schema captures the inputs (engaged seconds, scroll depth, share counts, decay-relevant timestamps). The score itself is a downstream feature with its own design.
- **Semantic Query Builder LLM prompt + template library.** v1 fixed-dimension model is the prerequisite. The query builder builds on top.
- **Dashboard UI for new views.** Loop, Content Performance, Social Referrers, Article Scorecard need their own design (`/plan-design-review`).
- **AI-actor classifier table maintenance** beyond the initial seed. The data layer (`ai_actor` blob slot) is in scope; the upkeep workflow is not.
- **Cost projections** for D1, R2, Queues at portfolio scale. To be done before locking the plan, with a budget appendix added below.

---

## 9. Cost / risk appendix (to fill before /plan-eng-review)

Numbers to validate before approving this plan:
- **AE dataset count**: confirm Cloudflare account allows 5+ datasets on the current plan.
- **D1 row growth rate**: estimate (sites × contents × locales × known social posts) and project 12 months of growth. Confirm under D1 free or paid limits.
- **Queues throughput**: peak `/track` rate × 5 enrichment jobs per event. Confirm under Queues quota.
- **R2 storage**: daily archive size × retention. Confirm under expected budget.
- **Migration engineering effort**: 4–6 weeks solo for Phases 0–3 by best estimate. Document during /plan-eng-review.

---

## 10. Open questions for /plan-eng-review

1. Should custom events live in `flarelytics_pageview_v1` (current proposal) or get their own `flarelytics_custom_v1` dataset? Argument for separate: cleaner queries. Argument against: custom event volume is low and pageview dataset is the central one.
2. Is the dual-write latency budget (30% over baseline) acceptable, or should v1 writes always be `ctx.waitUntil()` async?
3. Backfill: do we leave v0 history URL-keyed in perpetuity, or run a one-time content_id backfill job during Phase 2? Backfill is expensive but means historical Loop views become possible.
4. Should `referrer_url_hash` (full URL hash, not just domain) actually be stored, given it's not joined against anything? Drop if no consumer emerges by Phase 2.
5. Tracker contract: do we require host pages to emit `content_id` explicitly (cleanest), or always derive it from `canonical_url` server-side via D1? Currently planned: prefer host-emitted, fall back to derivation.
6. Self-host migration UX: is `npx create-flarelytics migrate` enough, or do we need a hosted migration assistant?

These are the questions to resolve before the plan is locked. Each gets an explicit answer (with reasoning) appended to this document during /plan-eng-review.
