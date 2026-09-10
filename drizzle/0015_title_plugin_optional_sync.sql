-- Optional WordPress SEO-plugin sync metadata. Native SEO in D1 remains authoritative.
ALTER TABLE title_optimization_history_v2 ADD COLUMN native_seo_status TEXT NOT NULL DEFAULT 'SUCCESS';
ALTER TABLE title_optimization_history_v2 ADD COLUMN detected_plugin TEXT NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE title_optimization_history_v2 ADD COLUMN plugin_sync_status TEXT NOT NULL DEFAULT 'SEO_PLUGIN_SYNC_NOT_AVAILABLE';
ALTER TABLE title_optimization_history_v2 ADD COLUMN plugin_sync_error_code TEXT;
