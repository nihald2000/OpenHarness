CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, setting_key)
);

CREATE INDEX IF NOT EXISTS tenant_settings_updated_idx
  ON tenant_settings (tenant_id, updated_at DESC);
