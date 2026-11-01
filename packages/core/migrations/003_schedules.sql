CREATE TABLE IF NOT EXISTS schedules (
  schedule_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (tenant_id, schedule_id)
);

CREATE INDEX IF NOT EXISTS idx_schedules_tenant_updated
  ON schedules (tenant_id, updated_at DESC);
