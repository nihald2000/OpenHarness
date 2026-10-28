CREATE TABLE IF NOT EXISTS tenant_paused (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  paused_at bigint NOT NULL,
  reason text
);
