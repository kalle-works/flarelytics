/**
 * Worker environment bindings and secrets. Shared by every module that needs
 * `Env` (routing, /track, /admin/sites, /public-stats, v0 query templates) so
 * none of them has to import it back out of index.ts.
 */
export interface Env {
  // v0 (legacy)
  ANALYTICS: AnalyticsEngineDataset;
  SITE_CONFIG: KVNamespace;
  ALLOWED_ORIGINS: string;
  QUERY_API_KEY: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  DATASET_NAME: string;
  PUBLIC_STATS_SITES?: string;

  // v1 (Phase 0 — bindings declared, not used until Phase 0.5 dual-emit).
  // See MIGRATION_PLAN.md §3 for per-family schemas and §0 1A for why
  // /track must NOT call DIMENSIONS on the hot path.
  PAGEVIEW_EVENTS: AnalyticsEngineDataset;
  ENGAGEMENT_EVENTS: AnalyticsEngineDataset;
  SHARE_EVENTS: AnalyticsEngineDataset;
  BOT_EVENTS: AnalyticsEngineDataset;
  PERFORMANCE_EVENTS: AnalyticsEngineDataset;
  CUSTOM_EVENTS: AnalyticsEngineDataset;
  DIMENSIONS: D1Database;
  ENRICH_QUEUE: Queue;
  ARCHIVE: R2Bucket;

  // v1 query dataset names — interpolated into AE SQL FROM clauses by the
  // /query?v=1 path. Defaults match wrangler.toml.example bindings; override
  // here only if you renamed the underlying datasets.
  PV_DATASET?: string;
  ENG_DATASET?: string;
  SHARE_DATASET?: string;

  // Multi-organization SSO (palvelureppu OIDC). When unset, the auth endpoints
  // return 503 and the worker keeps working with the legacy X-API-Key only.
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URI?: string;
  SESSION_SECRET?: string;
  /** Dashboard base URL used for post-login redirects + credentialed CORS. */
  DASHBOARD_URL?: string;
  /** Registrable domain for the session cookie (e.g. flarelytics.dev). Empty → SameSite=None. */
  COOKIE_DOMAIN?: string;
  /** Comma-separated superadmin emails that may query any site regardless of org. */
  ADMIN_EMAILS?: string;
}
