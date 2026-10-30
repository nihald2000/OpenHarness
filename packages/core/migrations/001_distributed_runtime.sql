-- 001_distributed_runtime.sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'chat',
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'local',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  phase TEXT NOT NULL,
  mode TEXT NOT NULL,
  iteration INT NOT NULL DEFAULT 0,
  fence_token INT NOT NULL DEFAULT 1,
  lease_owner TEXT,
  lease_expires_at BIGINT,
  sandbox_handle_id TEXT,
  payload JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs (session_id);
CREATE INDEX IF NOT EXISTS idx_runs_lease ON runs (phase, lease_expires_at);

CREATE TABLE IF NOT EXISTS run_steps (
  run_id TEXT NOT NULL,
  step INT NOT NULL,
  phase TEXT NOT NULL,
  fence_token INT NOT NULL,
  sandbox_handle_id TEXT,
  state_json JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (run_id, step)
);

CREATE TABLE IF NOT EXISTS events (
  seq BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  session_id TEXT,
  run_id TEXT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tenant_seq ON events (tenant_id, seq);

CREATE TABLE IF NOT EXISTS sandboxes (
  handle_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL,
  modal_sandbox_id TEXT,
  image_id TEXT NOT NULL,
  last_snapshot_image_id TEXT,
  session_key_enc TEXT NOT NULL,
  cpu REAL NOT NULL,
  memory_mib INT NOT NULL,
  created_at BIGINT NOT NULL,
  timeout_ms BIGINT NOT NULL,
  billed_until BIGINT NOT NULL,
  ports JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sandboxes_modal_id ON sandboxes (modal_sandbox_id);

CREATE TABLE IF NOT EXISTS env_images (
  cache_key TEXT PRIMARY KEY,
  image_id TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
