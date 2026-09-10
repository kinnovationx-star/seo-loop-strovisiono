CREATE TABLE IF NOT EXISTS human_review_events (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_version_id TEXT NOT NULL,review_id TEXT NOT NULL,reviewed_by TEXT NOT NULL,review_status TEXT NOT NULL,review_note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_review_events_version ON human_review_events(client_id,article_version_id,created_at);
CREATE TABLE IF NOT EXISTS article_status_history (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_id TEXT NOT NULL,article_version_id TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',changed_by TEXT NOT NULL DEFAULT 'system',transition_event TEXT NOT NULL,changed_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS idx_article_status_transition_once ON article_status_history(article_version_id,from_status,to_status,transition_event);
CREATE INDEX IF NOT EXISTS idx_article_status_history_version ON article_status_history(client_id,article_version_id,changed_at);
