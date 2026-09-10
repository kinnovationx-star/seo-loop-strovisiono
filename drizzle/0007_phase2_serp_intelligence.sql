-- Phase 2 history tables. No existing Phase 1 record is modified.
CREATE TABLE IF NOT EXISTS serp_snapshots (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, keyword_id TEXT NOT NULL, job_id TEXT NOT NULL, provider TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '', device TEXT NOT NULL DEFAULT 'desktop',
 checked_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'QUEUED', raw_data TEXT NOT NULL DEFAULT '{}', error TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_serp_snapshots_client_keyword ON serp_snapshots(client_id,keyword_id,checked_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_serp_snapshot_job ON serp_snapshots(job_id);
CREATE TABLE IF NOT EXISTS serp_results (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, rank INTEGER NOT NULL, result_type TEXT NOT NULL DEFAULT 'organic',
 url TEXT NOT NULL, domain TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_serp_result_snapshot_rank_url ON serp_results(snapshot_id,rank,url);
CREATE TABLE IF NOT EXISTS serp_usage_events (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,provider TEXT NOT NULL,keyword_id TEXT NOT NULL,request_count INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_serp_usage_client ON serp_usage_events(client_id,created_at DESC);

CREATE TABLE IF NOT EXISTS competitor_page_analysis (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, serp_result_id TEXT NOT NULL, fetch_status TEXT NOT NULL DEFAULT 'unavailable',
 page_type TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', search_intent TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', h1 TEXT NOT NULL DEFAULT '', headings_json TEXT NOT NULL DEFAULT '[]',
 covered_topics_json TEXT NOT NULL DEFAULT '[]', unique_topics_json TEXT NOT NULL DEFAULT '[]', questions_json TEXT NOT NULL DEFAULT '[]', tables_detected INTEGER, comparison_detected INTEGER, examples_detected INTEGER,
 original_data_detected INTEGER, source_quality TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', author_info TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', freshness_info TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', cta_type TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', analysis_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_competitor_analysis_result ON competitor_page_analysis(serp_result_id);
CREATE TABLE IF NOT EXISTS keyword_serp_insights (
 id TEXT PRIMARY KEY, client_id TEXT NOT NULL, keyword_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
 search_intent TEXT NOT NULL, explicit_need TEXT NOT NULL DEFAULT '', latent_need TEXT NOT NULL DEFAULT '', anxiety TEXT NOT NULL DEFAULT '', comparison_axes TEXT NOT NULL DEFAULT '[]', desired_outcome TEXT NOT NULL DEFAULT '', likely_funnel_stage TEXT NOT NULL DEFAULT '', serp_consensus TEXT NOT NULL DEFAULT '{}', missing_topics TEXT NOT NULL DEFAULT '[]', weak_competitor_topics TEXT NOT NULL DEFAULT '[]', differentiation_opportunities TEXT NOT NULL DEFAULT '[]', recommended_content_type TEXT NOT NULL DEFAULT '', recommended_depth TEXT NOT NULL DEFAULT '', analyzed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_serp_insight_snapshot ON keyword_serp_insights(client_id,keyword_id,snapshot_id);
CREATE TABLE IF NOT EXISTS cannibalization_assessments (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,keyword_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,risk TEXT NOT NULL,score REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '',signals_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cannibal_snapshot ON cannibalization_assessments(client_id,keyword_id,snapshot_id);
CREATE TABLE IF NOT EXISTS content_decisions (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,keyword_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,action TEXT NOT NULL,target_article_id TEXT,reason TEXT NOT NULL,confidence REAL NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_decision_snapshot ON content_decisions(client_id,keyword_id,snapshot_id);
