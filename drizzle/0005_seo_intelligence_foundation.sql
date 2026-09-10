-- Phase 1: add history-oriented SEO intelligence without changing existing
-- clients, jobs, snapshots, sources, or connection records.
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, parent_topic_id TEXT,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
  coverage_score REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_client_name ON topics(client_id, name);
CREATE INDEX IF NOT EXISTS idx_topics_client_parent ON topics(client_id, parent_topic_id);

CREATE TABLE IF NOT EXISTS keyword_clusters (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, topic_id TEXT, parent_cluster_id TEXT,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
  coverage_score REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_clusters_client_name ON keyword_clusters(client_id, name);
CREATE INDEX IF NOT EXISTS idx_keyword_clusters_topic ON keyword_clusters(client_id, topic_id);

CREATE TABLE IF NOT EXISTS seo_keywords (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, topic_id TEXT, cluster_id TEXT,
  keyword TEXT NOT NULL, normalized_keyword TEXT NOT NULL, primary_or_secondary TEXT NOT NULL DEFAULT 'primary',
  search_intent TEXT NOT NULL DEFAULT 'unknown', search_volume REAL, keyword_difficulty REAL, cpc REAL,
  current_position REAL, impressions REAL, clicks REAL, ctr REAL,
  business_relevance REAL, conversion_potential REAL, topical_relevance REAL,
  ranking_opportunity REAL, priority_score REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'candidate', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seo_keywords_client_normalized ON seo_keywords(client_id, normalized_keyword);
CREATE INDEX IF NOT EXISTS idx_seo_keywords_client_priority ON seo_keywords(client_id, priority_score DESC);

CREATE TABLE IF NOT EXISTS keyword_article_relations (
  id TEXT PRIMARY KEY, keyword_id TEXT NOT NULL, article_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'primary', confidence REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_article_relation_unique ON keyword_article_relations(keyword_id, article_id, relation_type);
CREATE INDEX IF NOT EXISTS idx_keyword_article_relations_article ON keyword_article_relations(article_id);

CREATE TABLE IF NOT EXISTS content_briefs (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, keyword_id TEXT, search_intent TEXT NOT NULL DEFAULT 'unknown',
  target_user TEXT NOT NULL DEFAULT '', explicit_need TEXT NOT NULL DEFAULT '', latent_need TEXT NOT NULL DEFAULT '',
  anxiety TEXT NOT NULL DEFAULT '', comparison_axes TEXT NOT NULL DEFAULT '[]', desired_outcome TEXT NOT NULL DEFAULT '',
  funnel_stage TEXT NOT NULL DEFAULT '', serp_consensus TEXT NOT NULL DEFAULT '[]', required_topics TEXT NOT NULL DEFAULT '[]',
  content_gap TEXT NOT NULL DEFAULT '', differentiation TEXT NOT NULL DEFAULT '', primary_sources TEXT NOT NULL DEFAULT '[]',
  internal_link_candidates TEXT NOT NULL DEFAULT '[]', cta TEXT NOT NULL DEFAULT '', ymyl_risk TEXT NOT NULL DEFAULT 'low',
  eeat_requirements TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_briefs_client_keyword ON content_briefs(client_id, keyword_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS gsc_search_performance (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, date TEXT NOT NULL, query TEXT NOT NULL, page TEXT NOT NULL,
  clicks REAL NOT NULL DEFAULT 0, impressions REAL NOT NULL DEFAULT 0, ctr REAL NOT NULL DEFAULT 0, position REAL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gsc_performance_unique ON gsc_search_performance(client_id, date, query, page);
CREATE INDEX IF NOT EXISTS idx_gsc_performance_client_date ON gsc_search_performance(client_id, date DESC);

CREATE TABLE IF NOT EXISTS ga4_page_performance (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, date TEXT NOT NULL, landing_page TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '(not set)', medium TEXT NOT NULL DEFAULT '(not set)', sessions REAL NOT NULL DEFAULT 0,
  organic_sessions REAL NOT NULL DEFAULT 0, engaged_sessions REAL NOT NULL DEFAULT 0, engagement_rate REAL,
  conversions REAL NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ga4_performance_unique ON ga4_page_performance(client_id, date, landing_page, source, medium);
CREATE INDEX IF NOT EXISTS idx_ga4_performance_client_date ON ga4_page_performance(client_id, date DESC);

CREATE TABLE IF NOT EXISTS seo_actions (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, article_id TEXT, keyword_id TEXT, action_type TEXT NOT NULL,
  hypothesis TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', source_data TEXT NOT NULL DEFAULT '{}',
  action_taken TEXT NOT NULL DEFAULT '', target_kpi TEXT NOT NULL DEFAULT '', before_value TEXT NOT NULL DEFAULT '{}',
  after_value TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'planned', executed_at TEXT, measured_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seo_actions_client_created ON seo_actions(client_id, created_at DESC);
