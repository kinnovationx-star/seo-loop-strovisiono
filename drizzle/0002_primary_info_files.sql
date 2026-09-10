CREATE TABLE IF NOT EXISTS source_files (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  rights_confirmed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploaded',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_files_client_created ON source_files(client_id, created_at);
