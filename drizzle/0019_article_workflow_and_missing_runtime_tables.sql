-- Brings existing deployments created before the article-workflow release up
-- to the schema expected by the current dashboard and Queue worker.  Every
-- statement is additive so client data already stored in D1 is preserved.

CREATE TABLE IF NOT EXISTS article_creation_inputs (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, creation_method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT', seo_enabled INTEGER NOT NULL DEFAULT 1,
  topic TEXT NOT NULL DEFAULT '', user_notes TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '{}', selected_primary_source_ids TEXT NOT NULL DEFAULT '[]',
  primary_keyword_id TEXT, primary_keyword_text TEXT NOT NULL DEFAULT '', search_intent TEXT NOT NULL DEFAULT 'unknown',
  content_brief_id TEXT, originality_plan_id TEXT, article_id TEXT, analysis_job_id TEXT, article_job_id TEXT, article_version_id TEXT,
  idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_article_creation_input_idempotency ON article_creation_inputs(client_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_article_creation_inputs_client ON article_creation_inputs(client_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS reference_sources (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, creation_input_id TEXT NOT NULL, source_type TEXT NOT NULL,
  original_url TEXT NOT NULL DEFAULT '', raw_text TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', extracted_text TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', published_at TEXT, fetched_at TEXT,
  fetch_status TEXT NOT NULL DEFAULT 'PENDING', error_code TEXT, content_hash TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  youtube_video_id TEXT NOT NULL DEFAULT '', transcript_source TEXT NOT NULL DEFAULT '', raw_transcript TEXT NOT NULL DEFAULT '',
  normalized_transcript TEXT NOT NULL DEFAULT '', transcript_chunk_count INTEGER NOT NULL DEFAULT 0, transcript_prompt_version TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reference_source_content ON reference_sources(client_id, creation_input_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_reference_sources_input ON reference_sources(client_id, creation_input_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reference_sources_youtube_transcript ON reference_sources(client_id, source_type, transcript_source, updated_at DESC);

CREATE TABLE IF NOT EXISTS reference_analyses (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, creation_input_id TEXT NOT NULL, reference_source_id TEXT,
  analysis_key TEXT NOT NULL, analysis_type TEXT NOT NULL, prompt_version TEXT NOT NULL, analysis_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reference_analysis_once ON reference_analyses(client_id, creation_input_id, analysis_key);
CREATE INDEX IF NOT EXISTS idx_reference_analyses_input ON reference_analyses(client_id, creation_input_id, created_at);

CREATE TABLE IF NOT EXISTS originality_plans (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, creation_input_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'DRAFT',
  plan_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_originality_plan_once ON originality_plans(client_id, creation_input_id);

CREATE TABLE IF NOT EXISTS article_series (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, creation_input_id TEXT NOT NULL,
  requested_article_count INTEGER NOT NULL DEFAULT 1 CHECK (requested_article_count BETWEEN 1 AND 4),
  recommended_article_count INTEGER NOT NULL DEFAULT 1 CHECK (recommended_article_count BETWEEN 1 AND 4),
  accepted_article_count INTEGER, selected_item_ids_json TEXT NOT NULL DEFAULT '[]', force_requested_count INTEGER NOT NULL DEFAULT 0,
  series_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'PLANNING', prompt_version TEXT NOT NULL DEFAULT 'ARTICLE_SERIES_PLANNER_V1',
  plan_json TEXT NOT NULL DEFAULT '{}', planning_job_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_article_series_input_once ON article_series(client_id, creation_input_id);
CREATE INDEX IF NOT EXISTS idx_article_series_client_status ON article_series(client_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS article_series_items (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, series_id TEXT NOT NULL, creation_input_id TEXT NOT NULL,
  article_number INTEGER NOT NULL CHECK (article_number BETWEEN 1 AND 4), is_recommended INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'PLANNED', topic_id TEXT, cluster_id TEXT, primary_keyword_id TEXT, primary_keyword_text TEXT NOT NULL DEFAULT '',
  search_intent TEXT NOT NULL DEFAULT 'unknown', content_brief_id TEXT, article_id TEXT, article_job_id TEXT, article_version_id TEXT,
  quality_score REAL, fact_check_status TEXT NOT NULL DEFAULT 'NOT_STARTED', ymyl_risk TEXT NOT NULL DEFAULT 'UNKNOWN',
  cannibalization_risk TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', cannibalization_reason TEXT NOT NULL DEFAULT '',
  internal_link_plan_json TEXT NOT NULL DEFAULT '[]', plan_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_article_series_item_once ON article_series_items(series_id, article_number);
CREATE INDEX IF NOT EXISTS idx_article_series_items_client_status ON article_series_items(client_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_article_series_items_version ON article_series_items(client_id, article_version_id);

CREATE TABLE IF NOT EXISTS article_schedules (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, series_id TEXT NOT NULL, series_item_id TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'DRAFT_ONLY', scheduled_at TEXT, timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo', execution_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT_ONLY', blocked_reason TEXT NOT NULL DEFAULT '', executed_at TEXT, published_at TEXT,
  wordpress_post_id TEXT, job_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_article_schedule_execution_once ON article_schedules(client_id, execution_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_article_schedule_item_once ON article_schedules(client_id, series_item_id);
CREATE INDEX IF NOT EXISTS idx_article_schedules_due ON article_schedules(client_id, status, scheduled_at);

CREATE TABLE IF NOT EXISTS article_schedule_history (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, schedule_id TEXT NOT NULL, series_id TEXT NOT NULL, series_item_id TEXT NOT NULL,
  execution_key TEXT NOT NULL, event_type TEXT NOT NULL, scheduled_at TEXT, executed_at TEXT, published_at TEXT,
  result_json TEXT NOT NULL DEFAULT '{}', blocked_reason TEXT NOT NULL DEFAULT '', wordpress_post_id TEXT, job_id TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_article_schedule_history_once ON article_schedule_history(schedule_id, execution_key, event_type);
CREATE INDEX IF NOT EXISTS idx_article_schedule_history_client ON article_schedule_history(client_id, created_at DESC);

CREATE TABLE IF NOT EXISTS client_article_defaults (client_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS article_generation_settings (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, creation_input_id TEXT, series_id TEXT, series_item_id TEXT,
  scope TEXT NOT NULL, settings_json TEXT NOT NULL DEFAULT '{}', conflicts_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_article_generation_settings_scope ON article_generation_settings(client_id, scope, COALESCE(creation_input_id,''), COALESCE(series_id,''), COALESCE(series_item_id,''));
CREATE INDEX IF NOT EXISTS idx_article_generation_settings_client ON article_generation_settings(client_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_article_generation_settings_lookup ON article_generation_settings(client_id, creation_input_id, series_id, series_item_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS generation_settings_snapshots (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, creation_input_id TEXT, series_id TEXT, series_item_id TEXT,
  article_id TEXT, article_version_id TEXT, settings_json TEXT NOT NULL, prompt_version TEXT NOT NULL DEFAULT 'article-generation-settings-v1', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_settings_snapshot_once ON generation_settings_snapshots(client_id, article_id, COALESCE(article_version_id,''));
CREATE INDEX IF NOT EXISTS idx_generation_settings_snapshot_input ON generation_settings_snapshots(client_id, creation_input_id, series_id, series_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_settings_snapshots_version ON generation_settings_snapshots(client_id, article_version_id, created_at DESC);

CREATE TABLE IF NOT EXISTS article_revision_instructions (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, article_id TEXT NOT NULL, from_article_version_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL, instruction_json TEXT NOT NULL, prompt_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'QUEUED', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_revision_instruction_once ON article_revision_instructions(client_id, from_article_version_id);
CREATE INDEX IF NOT EXISTS idx_revision_article ON article_revision_instructions(client_id, article_id, revision_no);

CREATE TABLE IF NOT EXISTS monthly_content_plans (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, plan_month TEXT NOT NULL, articles_per_week INTEGER NOT NULL,
  auto_publish_enabled INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'DRAFT', final_confirmed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_monthly_content_plan_once ON monthly_content_plans(client_id, plan_month);
CREATE TABLE IF NOT EXISTS monthly_content_plan_items (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, client_id TEXT NOT NULL, sequence_no INTEGER NOT NULL, week_no INTEGER NOT NULL, target_date TEXT NOT NULL,
  keyword_id TEXT, keyword TEXT NOT NULL, planned_title TEXT NOT NULL DEFAULT '', rationale TEXT NOT NULL DEFAULT '', data_basis TEXT NOT NULL DEFAULT '',
  category_id INTEGER, category_name TEXT NOT NULL DEFAULT '', article_id TEXT NOT NULL, article_job_id TEXT, article_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'PLANNED', final_confirmed INTEGER NOT NULL DEFAULT 0, image_plan_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_monthly_content_plan_item_once ON monthly_content_plan_items(plan_id, sequence_no);
CREATE INDEX IF NOT EXISTS idx_monthly_content_plan_items_client ON monthly_content_plan_items(client_id, target_date);

CREATE TABLE IF NOT EXISTS competitor_page_analysis (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, serp_result_id TEXT NOT NULL, fetch_status TEXT NOT NULL DEFAULT 'unavailable',
  page_type TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', search_intent TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', h1 TEXT NOT NULL DEFAULT '', headings_json TEXT NOT NULL DEFAULT '[]',
  covered_topics_json TEXT NOT NULL DEFAULT '[]', unique_topics_json TEXT NOT NULL DEFAULT '[]', questions_json TEXT NOT NULL DEFAULT '[]',
  tables_detected INTEGER, comparison_detected INTEGER, examples_detected INTEGER, original_data_detected INTEGER,
  source_quality TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', author_info TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', freshness_info TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE',
  cta_type TEXT NOT NULL DEFAULT 'DATA_NOT_AVAILABLE', analysis_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_competitor_analysis_result ON competitor_page_analysis(serp_result_id);
CREATE TABLE IF NOT EXISTS keyword_serp_insights (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, keyword_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, search_intent TEXT NOT NULL,
  explicit_need TEXT NOT NULL DEFAULT '', latent_need TEXT NOT NULL DEFAULT '', anxiety TEXT NOT NULL DEFAULT '', comparison_axes TEXT NOT NULL DEFAULT '[]',
  desired_outcome TEXT NOT NULL DEFAULT '', likely_funnel_stage TEXT NOT NULL DEFAULT '', serp_consensus TEXT NOT NULL DEFAULT '{}',
  missing_topics TEXT NOT NULL DEFAULT '[]', weak_competitor_topics TEXT NOT NULL DEFAULT '[]', differentiation_opportunities TEXT NOT NULL DEFAULT '[]',
  recommended_content_type TEXT NOT NULL DEFAULT '', recommended_depth TEXT NOT NULL DEFAULT '', analyzed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_serp_insight_snapshot ON keyword_serp_insights(client_id, keyword_id, snapshot_id);
CREATE TABLE IF NOT EXISTS cannibalization_assessments (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, keyword_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, risk TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0, reason TEXT NOT NULL DEFAULT '', signals_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cannibal_snapshot ON cannibalization_assessments(client_id, keyword_id, snapshot_id);
CREATE TABLE IF NOT EXISTS content_decisions (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, keyword_id TEXT NOT NULL, snapshot_id TEXT NOT NULL, action TEXT NOT NULL,
  target_article_id TEXT, reason TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_decision_snapshot ON content_decisions(client_id, keyword_id, snapshot_id);

CREATE TABLE IF NOT EXISTS title_optimization_proposals (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, action_id TEXT NOT NULL, article_id TEXT NOT NULL, article_version_id TEXT NOT NULL,
  old_seo_title TEXT NOT NULL DEFAULT '', old_meta_description TEXT NOT NULL DEFAULT '', proposed_seo_title TEXT NOT NULL, proposed_meta_description TEXT NOT NULL,
  target_queries_json TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL DEFAULT '', evidence_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, risk TEXT NOT NULL,
  safety_status TEXT NOT NULL, prompt_version TEXT NOT NULL, before_metrics_json TEXT NOT NULL DEFAULT '{}', execution_status TEXT NOT NULL DEFAULT 'PROPOSED', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_title_proposal_action ON title_optimization_proposals(client_id, action_id);
CREATE TABLE IF NOT EXISTS title_optimization_history_v2 (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, action_id TEXT NOT NULL, article_id TEXT NOT NULL, article_version_id TEXT NOT NULL,
  old_seo_title TEXT NOT NULL DEFAULT '', new_seo_title TEXT NOT NULL, old_meta_description TEXT NOT NULL DEFAULT '', new_meta_description TEXT NOT NULL,
  target_queries_json TEXT NOT NULL DEFAULT '[]', reason TEXT NOT NULL DEFAULT '', evidence_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, risk TEXT NOT NULL,
  prompt_version TEXT NOT NULL, execution_status TEXT NOT NULL, executed_by TEXT NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL,
  native_seo_status TEXT NOT NULL DEFAULT 'SUCCESS', detected_plugin TEXT NOT NULL DEFAULT 'UNKNOWN', plugin_sync_status TEXT NOT NULL DEFAULT 'SEO_PLUGIN_SYNC_NOT_AVAILABLE', plugin_sync_error_code TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_title_history_idempotency ON title_optimization_history_v2(client_id, idempotency_key);

CREATE TABLE IF NOT EXISTS internal_link_execution_history (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, action_id TEXT NOT NULL, source_article_id TEXT NOT NULL, source_article_version_id TEXT NOT NULL,
  target_article_id TEXT NOT NULL, source_wp_post_id TEXT NOT NULL, target_url TEXT NOT NULL, anchor_text TEXT NOT NULL DEFAULT '',
  placement_type TEXT NOT NULL DEFAULT '', placement_reference TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', confidence TEXT NOT NULL DEFAULT '',
  safety_status TEXT NOT NULL, snapshot_id TEXT, execution_status TEXT NOT NULL, prompt_version TEXT NOT NULL DEFAULT '', executed_by TEXT NOT NULL DEFAULT 'system',
  reject_reason TEXT NOT NULL DEFAULT '', idempotency_key TEXT NOT NULL, result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_link_execution_action ON internal_link_execution_history(client_id, action_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_link_execution_idempotency ON internal_link_execution_history(client_id, idempotency_key);
