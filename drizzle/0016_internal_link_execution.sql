CREATE TABLE IF NOT EXISTS internal_link_execution_history (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, action_id TEXT NOT NULL, source_article_id TEXT NOT NULL,
 source_article_version_id TEXT NOT NULL, target_article_id TEXT NOT NULL, source_wp_post_id TEXT NOT NULL,
 target_url TEXT NOT NULL, anchor_text TEXT NOT NULL DEFAULT '', placement_type TEXT NOT NULL DEFAULT '',
 placement_reference TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', confidence TEXT NOT NULL DEFAULT '',
 safety_status TEXT NOT NULL, snapshot_id TEXT, execution_status TEXT NOT NULL, prompt_version TEXT NOT NULL DEFAULT '',
 executed_by TEXT NOT NULL DEFAULT 'system', reject_reason TEXT NOT NULL DEFAULT '', idempotency_key TEXT NOT NULL,
 result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_link_execution_action ON internal_link_execution_history(client_id,action_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_link_execution_idempotency ON internal_link_execution_history(client_id,idempotency_key);
