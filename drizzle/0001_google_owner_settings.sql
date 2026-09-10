CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  public_config TEXT NOT NULL DEFAULT '{}',
  secret_cipher TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_app_settings_owner_key ON app_settings(owner_id, setting_key);
