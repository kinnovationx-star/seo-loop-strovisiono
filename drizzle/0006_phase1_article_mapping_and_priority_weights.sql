-- Phase 1 completion: human-approved WordPress article mapping and client-scoped scoring weights.
CREATE TABLE IF NOT EXISTS article_mapping_candidates (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  article_title TEXT NOT NULL DEFAULT '',
  article_url TEXT NOT NULL DEFAULT '',
  current_topic_id TEXT,
  current_cluster_id TEXT,
  current_keyword_id TEXT,
  suggested_topic_id TEXT,
  suggested_cluster_id TEXT,
  suggested_keyword_id TEXT,
  suggested_keyword_text TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0,
  reasoning TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mapping_candidate_client_article ON article_mapping_candidates(client_id, article_id);
CREATE INDEX IF NOT EXISTS idx_mapping_candidate_client_status ON article_mapping_candidates(client_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS client_priority_weights (
  client_id TEXT PRIMARY KEY,
  weights_json TEXT NOT NULL,
  high_confidence_threshold REAL NOT NULL DEFAULT 0.90,
  medium_confidence_threshold REAL NOT NULL DEFAULT 0.70,
  updated_at TEXT NOT NULL
);
