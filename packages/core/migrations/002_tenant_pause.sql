-- 002_tenant_pause.sql
ALTER TABLE runs ADD COLUMN IF NOT EXISTS paused_reason TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS snapshot_image_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sandboxes_tenant_status ON sandboxes (tenant_id, status);
