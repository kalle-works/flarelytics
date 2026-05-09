# AE Limits Verification Test Worker

One-off verification harness for MIGRATION_PLAN.md §9 Task A.

This is **not production code** and is not deployed alongside the main `flarelytics`
worker. It exists so the AE blob/row byte limits used by the v1 schema can be
re-verified empirically against the live Cloudflare Analytics Engine — both at
plan-locking time and any time the schema changes.

## What it does

Emits probe rows to a dedicated AE dataset (`flarelytics_ae_limits_test_v1`),
each tagged with a unique `canonical_url_hash` so it can be retrieved later.
Three probe shapes:

| Probe | Total blob bytes | What it proves |
|-------|------------------|----------------|
| `max-realistic` | ~1.3 KB | Typical production-like upper-bound row passes through AE intact |
| `schema-cap` | ~3 KB | A row at the declared truncation policy (path 500, UTM 200×3, etc.) fits |
| `stress` | ~15 KB | Push toward the documented 16 KB total-blob ceiling and observe AE behavior |

A `/verify` endpoint reads the rows back via the Analytics Engine SQL API and
returns the byte length AE preserved per blob, so silent truncation can be
detected.

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/emit?probe=<max-realistic\|schema-cap\|stress>` | Emit one probe row, return tag |
| GET | `/verify?tag=<canonical_url_hash>` | SQL-query AE for that tag, compare bytes sent vs stored |
| GET | `/budget` | Return the analytic byte budget table as JSON |
| GET | `/health` | Health check |

## Usage

```bash
# Deploy (separate worker from production)
cd packages/worker/test-ae-limits
npx wrangler deploy

# Set secrets (required for /verify to call SQL API)
npx wrangler secret put CF_API_TOKEN     # Analytics Engine read access
npx wrangler secret put CF_ACCOUNT_ID

# Emit probes
curl -X POST "https://flarelytics-ae-limits-test.<subdomain>.workers.dev/emit?probe=max-realistic"
curl -X POST "https://flarelytics-ae-limits-test.<subdomain>.workers.dev/emit?probe=schema-cap"
curl -X POST "https://flarelytics-ae-limits-test.<subdomain>.workers.dev/emit?probe=stress"

# Wait 10–15 min for AE indexing, then verify each tag returned by /emit
curl "https://flarelytics-ae-limits-test.<subdomain>.workers.dev/verify?tag=<tag>"

# Tear down when done
npx wrangler delete
```

## Cleanup

When verification is complete and results have been recorded in
`MIGRATION_PLAN.md §3 + §9`, delete the deployed worker and (after AE
retention naturally expires) the test dataset binding.

The source is kept in the repo so re-runs are cheap when the v1 schema
evolves.
