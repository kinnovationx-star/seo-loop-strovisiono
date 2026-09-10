-- Final audit remediation: immutable revision and narrow autopilot change histories.
ALTER TABLE client_autopilot_settings ADD COLUMN max_auto_revisions INTEGER NOT NULL DEFAULT 2;
CREATE TABLE IF NOT EXISTS article_revision_instructions (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, article_id TEXT NOT NULL, from_article_version_id TEXT NOT NULL,
 revision_no INTEGER NOT NULL, instruction_json TEXT NOT NULL, prompt_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'QUEUED', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_revision_instruction_once ON article_revision_instructions(client_id,from_article_version_id);
CREATE INDEX IF NOT EXISTS idx_revision_article ON article_revision_instructions(client_id,article_id,revision_no);
CREATE TABLE IF NOT EXISTS title_optimization_history (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, article_id TEXT NOT NULL, article_version_id TEXT NOT NULL, action_id TEXT NOT NULL,
 old_title TEXT NOT NULL DEFAULT '', new_title TEXT NOT NULL DEFAULT '', old_meta TEXT NOT NULL DEFAULT '', new_meta TEXT NOT NULL DEFAULT '',
 reason TEXT NOT NULL DEFAULT '', result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_title_action_once ON title_optimization_history(client_id,action_id);
CREATE TABLE IF NOT EXISTS internal_link_change_history (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, source_article_id TEXT NOT NULL, target_article_id TEXT NOT NULL, article_version_id TEXT NOT NULL,
 action_id TEXT NOT NULL, target_url TEXT NOT NULL, anchor_text TEXT NOT NULL, placement TEXT NOT NULL, before_snapshot_id TEXT, result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_link_action_once ON internal_link_change_history(client_id,action_id);
