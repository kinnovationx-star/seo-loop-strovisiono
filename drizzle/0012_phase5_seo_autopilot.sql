-- Phase 5: one evidence-backed primary action per client/week.
CREATE TABLE IF NOT EXISTS client_autopilot_settings (
 client_id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'OFF', new_article_priority_mode INTEGER NOT NULL DEFAULT 0,
 paused INTEGER NOT NULL DEFAULT 0, weekly_action_limit INTEGER NOT NULL DEFAULT 1, serp_refresh_limit INTEGER NOT NULL DEFAULT 4,
 article_generation_limit INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS global_autopilot_settings (
 id TEXT PRIMARY KEY, kill_switch_enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS autopilot_runs (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, week_key TEXT NOT NULL, run_key TEXT NOT NULL, trigger_type TEXT NOT NULL,
 freshness_json TEXT NOT NULL DEFAULT '{}', input_snapshot_json TEXT NOT NULL DEFAULT '{}', result_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'COMPLETED', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_run_once ON autopilot_runs(client_id,week_key,run_key);
CREATE INDEX IF NOT EXISTS idx_autopilot_runs_client ON autopilot_runs(client_id,created_at DESC);
CREATE TABLE IF NOT EXISTS autopilot_actions (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, run_id TEXT NOT NULL, week_key TEXT NOT NULL, action_type TEXT NOT NULL,
 target_keyword_id TEXT, target_article_id TEXT, target_topic_id TEXT, target_cluster_id TEXT, reason_json TEXT NOT NULL DEFAULT '{}', evidence_json TEXT NOT NULL DEFAULT '{}',
 expected_impact TEXT NOT NULL, confidence TEXT NOT NULL, risk TEXT NOT NULL, score REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'RECOMMENDED',
 before_metrics_json TEXT NOT NULL DEFAULT '{}', after_metrics_json TEXT NOT NULL DEFAULT '{}', execution_result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_primary_action ON autopilot_actions(client_id,week_key);
CREATE INDEX IF NOT EXISTS idx_autopilot_actions_client ON autopilot_actions(client_id,created_at DESC);
CREATE TABLE IF NOT EXISTS autopilot_measurements (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, action_id TEXT NOT NULL, window_days INTEGER NOT NULL, metrics_json TEXT NOT NULL DEFAULT '{}', result_status TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA', measured_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_measurement_window ON autopilot_measurements(action_id,window_days);
CREATE TABLE IF NOT EXISTS autopilot_audit_log (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, run_id TEXT, action_id TEXT, event_type TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_autopilot_audit_client ON autopilot_audit_log(client_id,created_at DESC);
