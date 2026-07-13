-- Countless initial schema. Applied via `wrangler d1 migrations apply countless`.
-- Full column set and indexes are finalized in T004; this is the canonical skeleton.

CREATE TABLE IF NOT EXISTS sites (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  domain      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  site_id       TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  path          TEXT NOT NULL,
  referrer      TEXT NOT NULL DEFAULT '',
  name          TEXT,
  props         TEXT,
  visitor_hash  TEXT NOT NULL,
  country       TEXT,
  device        TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_site_created_name
  ON events (site_id, created_at, name);

CREATE TABLE IF NOT EXISTS event_rollups (
  site_id       TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  bucket_start  INTEGER NOT NULL,
  interval      TEXT NOT NULL,
  pageviews     INTEGER NOT NULL DEFAULT 0,
  events        INTEGER NOT NULL DEFAULT 0,
  visitors      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, hostname, bucket_start, interval)
);

CREATE TABLE IF NOT EXISTS sessions (
  site_id       TEXT NOT NULL,
  visitor_hash  TEXT NOT NULL,
  day_key       TEXT NOT NULL,
  first_seen    INTEGER NOT NULL,
  PRIMARY KEY (site_id, visitor_hash, day_key)
);

CREATE TABLE IF NOT EXISTS salts (
  day_key     TEXT PRIMARY KEY,
  salt        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  site_id     TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  label       TEXT,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
