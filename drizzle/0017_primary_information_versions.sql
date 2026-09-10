-- Preserve every approved or edited primary-information master revision.
-- The active sources row remains the current article input; this table makes
-- later fact corrections traceable without overwriting earlier information.
CREATE TABLE IF NOT EXISTS primary_info_versions (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  version_no INTEGER NOT NULL,
  article_ready_text TEXT NOT NULL,
  interview_json TEXT NOT NULL DEFAULT '[]',
  change_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_primary_info_version_once
ON primary_info_versions(source_id, version_no);
CREATE INDEX IF NOT EXISTS idx_primary_info_versions_client
ON primary_info_versions(client_id, created_at DESC);
