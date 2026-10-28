-- OpenHarness distributed runtime schema. All migrations are forward-only.
CREATE TABLE IF NOT EXISTS tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'free',
  created_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  email text,
  role text NOT NULL CHECK (role IN ('member', 'admin')),
  created_at bigint NOT NULL,
  UNIQUE (tenant_id, external_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id uuid,
  parent_id text,
  status text NOT NULL,
  data jsonb NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_owner_updated ON sessions (tenant_id, owner_id, updated_at DESC) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions (tenant_id, parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_active ON sessions (tenant_id, status) WHERE status IN ('running', 'awaiting_permission');

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session_id ON messages (tenant_id, session_id, id);
CREATE TABLE IF NOT EXISTS parts (
  id text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, message_id, id)
);
CREATE INDEX IF NOT EXISTS parts_session_id ON parts (tenant_id, session_id, id);

CREATE TABLE IF NOT EXISTS session_seq (
  session_id text PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  seq bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  at bigint NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (session_id, seq, at)
) PARTITION BY RANGE (at);
CREATE INDEX IF NOT EXISTS events_tenant_session_at ON events (tenant_id, session_id, at);

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  root_session_id text NOT NULL,
  parent_job_id text REFERENCES jobs(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('run', 'resume', 'compact', 'verify', 'subagent')),
  status text NOT NULL CHECK (status IN ('queued', 'leased', 'running', 'waiting', 'succeeded', 'failed', 'cancelled')),
  wait_reason text CHECK (wait_reason IN ('approval', 'child', 'retry', 'quota')),
  priority integer NOT NULL DEFAULT 100,
  attempt integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  lease_owner text,
  lease_until bigint,
  heartbeat_at bigint,
  not_before bigint NOT NULL,
  fence bigint NOT NULL DEFAULT 0,
  input jsonb NOT NULL,
  checkpoint jsonb,
  result jsonb,
  error text,
  cancel_requested_at bigint,
  idempotency_key text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active ON jobs (session_id) WHERE status IN ('queued', 'leased', 'running', 'waiting') AND kind <> 'subagent';
CREATE INDEX IF NOT EXISTS jobs_claim ON jobs (not_before, priority, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_lease ON jobs (lease_until) WHERE status IN ('leased', 'running');

CREATE TABLE IF NOT EXISTS permission_requests (
  id text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  call_id text NOT NULL,
  permission text NOT NULL,
  patterns jsonb NOT NULL,
  title text NOT NULL,
  metadata jsonb NOT NULL,
  rules jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'allowed', 'rejected', 'expired')),
  reply text,
  replied_by uuid,
  created_at bigint NOT NULL,
  replied_at bigint
);
CREATE INDEX IF NOT EXISTS permission_requests_pending ON permission_requests (tenant_id, session_id) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS permission_rules (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id text,
  permission text NOT NULL,
  pattern text NOT NULL,
  action text NOT NULL,
  created_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS tenant_usage (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period text NOT NULL,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_usd numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, period)
);
CREATE TABLE IF NOT EXISTS config_versions (
  id bigserial PRIMARY KEY,
  tenant_id uuid,
  version integer NOT NULL,
  config jsonb NOT NULL,
  author uuid,
  created_at bigint NOT NULL,
  UNIQUE (tenant_id, version)
);
CREATE TABLE IF NOT EXISTS secrets (
  tenant_id uuid,
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  wrapped_key bytea NOT NULL,
  key_id text NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (tenant_id, name)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid,
  actor uuid,
  action text NOT NULL,
  target text NOT NULL,
  detail jsonb NOT NULL,
  at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS event_outbox (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL,
  session_id text NOT NULL,
  seq bigint NOT NULL,
  at bigint NOT NULL,
  data jsonb NOT NULL,
  published_at bigint,
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS event_outbox_pending ON event_outbox (id) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at bigint NOT NULL
);
