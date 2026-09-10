CREATE TABLE IF NOT EXISTS title_optimization_proposals (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, action_id TEXT NOT NULL, article_id TEXT NOT NULL, article_version_id TEXT NOT NULL,
 old_seo_title TEXT NOT NULL DEFAULT '', old_meta_description TEXT NOT NULL DEFAULT '', proposed_seo_title TEXT NOT NULL, proposed_meta_description TEXT NOT NULL,
 target_queries_json TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL DEFAULT '', evidence_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, risk TEXT NOT NULL,
 safety_status TEXT NOT NULL, prompt_version TEXT NOT NULL, before_metrics_json TEXT NOT NULL DEFAULT '{}', execution_status TEXT NOT NULL DEFAULT 'PROPOSED', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_title_proposal_action ON title_optimization_proposals(client_id,action_id);
CREATE TABLE IF NOT EXISTS title_optimization_history_v2 (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, action_id TEXT NOT NULL, article_id TEXT NOT NULL, article_version_id TEXT NOT NULL,
 old_seo_title TEXT NOT NULL DEFAULT '', new_seo_title TEXT NOT NULL, old_meta_description TEXT NOT NULL DEFAULT '', new_meta_description TEXT NOT NULL,
 target_queries_json TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL DEFAULT '', evidence_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, risk TEXT NOT NULL,
 prompt_version TEXT NOT NULL, execution_status TEXT NOT NULL, executed_by TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_title_history_idempotency ON title_optimization_history_v2(client_id,idempotency_key);
