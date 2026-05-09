-- Phase 0 — initial D1 dimension schema for Flarelytics A+ migration.
-- See MIGRATION_PLAN.md §3 (D1 dimension schema). Tables created empty.
-- The queue-job consumer mints rows; /track does NOT touch D1 (§0 1A).

-- Stable identifier for a piece of content across translations, URL renames,
-- redirects, reposts. Mapped to canonical_url_hash via content_aliases.
CREATE TABLE IF NOT EXISTS content (
  content_id TEXT PRIMARY KEY,
  primary_canonical_url TEXT NOT NULL,
  content_type TEXT,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- canonical_url_hash → content_id mapping. One content can have many hashes
-- (fi + en versions of the same article share one content_id; URL renames
-- and redirects also create new aliases pointing at the same content).
CREATE TABLE IF NOT EXISTS content_aliases (
  canonical_url_hash TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content(content_id),
  canonical_url TEXT NOT NULL,
  locale TEXT,
  first_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_aliases_content_id ON content_aliases(content_id);

-- Sibling translations: explicit links between content_ids that are
-- translations of the same underlying article.
CREATE TABLE IF NOT EXISTS content_translations (
  content_id TEXT NOT NULL REFERENCES content(content_id),
  sibling_content_id TEXT NOT NULL REFERENCES content(content_id),
  PRIMARY KEY (content_id, sibling_content_id)
);

-- Known social posts the host's content has been shared on. Populated by
-- queue-job from /track-extracted (social_platform, social_post_id) tuples.
CREATE TABLE IF NOT EXISTS social_posts (
  social_platform TEXT NOT NULL,
  social_post_id TEXT NOT NULL,
  social_post_url TEXT,
  social_author TEXT,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (social_platform, social_post_id)
);

-- Out-going share clicks linked to enrichment results (resolved at most once,
-- never mutated — AE row immutability rules also apply to logical pairing).
CREATE TABLE IF NOT EXISTS share_enrichment (
  share_id TEXT PRIMARY KEY,
  share_target_platform TEXT,
  share_target_post_id TEXT,
  enriched_at INTEGER
);

-- referrer_domain → social_platform classifier table. Versioned so the
-- queue-job can detect parser drift and re-classify rows when needed.
CREATE TABLE IF NOT EXISTS referrer_mappings (
  referrer_domain TEXT PRIMARY KEY,
  social_platform TEXT NOT NULL,
  parser_version INTEGER NOT NULL
);

-- User-agent pattern → ai_actor classifier table. Same versioning approach
-- as referrer_mappings; queue-job updates classifications when patterns
-- evolve (e.g. ChatGPT-User UA changes).
CREATE TABLE IF NOT EXISTS ai_actor_signatures (
  user_agent_pattern TEXT PRIMARY KEY,
  ai_actor TEXT NOT NULL,
  classifier_version INTEGER NOT NULL
);
