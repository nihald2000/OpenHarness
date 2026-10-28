# Scaling architecture and migration status

OpenHarness is currently a single-process, single-workspace service. This document tracks the migration toward separately scaled API and worker processes while keeping local development as the default.

## Current behavior

- The Bun server owns run execution, cancellation, permission waiters, and event fan-out in one process.
- Session, message, permission, grant, and event records are persisted as one JSON document under `OPENHARNESS_DATA_DIR` (default `.openharness`). The current implementation does not use SQLite.
- SSE event IDs are monotonically increasing sequence numbers from that local store. Reconnect replay and the existing `ready`/`ping` behavior remain part of the API contract.
- Tools execute on the API host, except the opt-in Modal Python sandbox.
- The server still uses local session/job state and executes runs in-process. Postgres/Redis adapters and migrations exist, OIDC bearer verification and session ownership checks can be enabled with issuer configuration, and optional Redis rate/quota leases are wired. The complete distributed API/worker topology is not enabled yet.

## Adapter migration

The shared contracts start in `packages/core/src/infra`. The API now uses the local `InProcessEventBus` for live SSE fan-out, `JsonDocumentStore` for loading and atomically saving the legacy state document, `InProcessCancelBus` for active-run cancellation, and `InProcessLockService` to serialize local config, secret, plugin, and MCP read-modify-write operations. Prompt acceptance also goes through `InProcessJobQueue`, which claims, heartbeats, checkpoints run start, and finalizes each local run. Local token-bucket, run-quota, and tenant-scoped JSON `StateStore` adapters are implemented. The Postgres adapter set now includes tenant-scoped state/message/part storage, transactional per-session sequence allocation and outbox insertion, durable job enqueue/claim/heartbeat/fenced transitions, tenant pause controls, fair per-tenant claim ordering, numbered migrations, and an `oh migrate` CLI command. Redis adapters provide cross-process event fan-out and cancellation; a leader-elected pump relays committed outbox envelopes at least once. A session replay gateway subscribes before replay, deduplicates by sequence, and polls the durable head to recover missed Redis publishes. A reusable worker lifecycle engine handles claims, batched heartbeats, cancellation, draining, and fenced requeue. Postgres advisory-lock leadership and a durable job reaper recover expired leases and wake due retry/quota waits. These distributed components are not yet wired into the server/API runtime, and the concrete session run handler, per-step run checkpoints, and durable approvals remain outstanding. The local event replay still uses the legacy global sequence so current SSE IDs remain unchanged. Server and core adapter bundles build. Docker is unavailable here, so no live service integration was run.

Since that initial adapter slice, the server also gained optional OIDC JWT verification and tenant-scoped session/stream/permission checks, Redis-backed API/prompt/admin/provider token buckets and run-slot leases (with local equivalents), prompt and queue admission limits, bounded SSE queues/connection counts, and optional Postgres monthly tenant budget enforcement. The Postgres permission store remains an adapter; API approval handling still uses the local runner path. Server/core builds and typecheck pass; the server/SDK suite has 35 passing tests after one transient Windows rename failure passed on retry. No live Postgres/Redis multi-node integration has run.

## Intended distributed topology

The target deployment separates stateless API pods from worker pods. Postgres will be the durable source of truth for tenant-scoped state, events, jobs, approvals, and configuration versions. Redis will carry best-effort event fan-out, cancellation signals, and rate-limit state. Workers will claim leased jobs, checkpoint progress with fencing, and use remote per-session sandboxes. Redis loss must not lose durable events or jobs.

## Delivery phases

1. Introduce adapters and preserve local behavior. Current progress: shared contracts and local adapters are present; the API uses selected local adapters and preserves the existing JSON/SSE behavior.
2. Add Postgres state, transactional event sequencing/outbox, Redis fan-out, and cross-node SSE gap recovery. Current progress: migrations, core state/job adapters, Redis buses, a leader-elected outbox pump, and a session replay gateway are implemented; server/API wiring remains.
3. Add durable jobs, worker processes, leases, checkpoints, fencing, cancellation, and resumable runs. Current progress: durable job lifecycle adapter, reusable worker engine, and leader-elected lease reaper are implemented; the server still runs jobs in-process and does not persist a resumable per-step checkpoint.
4. Make approvals and provider retries durable waiting jobs. Current progress: Postgres permission storage now supports atomic decisions, reject cascades, saved rules, outbox events, expiration, and approval-job resume; the current in-process runner still uses its local waiter and does not free a worker slot.
5. Add OIDC identity and enforce tenant/user authorization on every route and stream. Current progress: JWT verification, JWKS discovery, tenant/user provisioning, session ownership checks, permission scoping, global-stream filtering, and break-glass audit logging are implemented; web-proxy identity forwarding and authorization for tenant config overlays remain.
6. Add distributed rate limits, quotas, and admission control. Current progress: Redis token buckets and expiring quota leases are implemented; API/prompt/admin/provider limits, run-slot leases, request size, local queue admission, bounded SSE buffering, and optional Postgres monthly tenant budgets are wired. TPM admission uses estimated prompt tokens plus the output-token maximum. Durable queue admission, plan-specific budgets, and live Redis contract verification remain.
7. Move file/process tools to isolated workspace runtimes.
8. Add versioned configuration, secret vault, and tenant content repositories.
9. Add metrics, traces, dashboards, alerts, Kubernetes deployment, and runbooks.
10. Run integration, chaos, and load certification against the target SLOs.

## Configuration status

OIDC JWT verification is enabled when `OIDC_ISSUER` and `OIDC_AUDIENCE` are set and requires `DATABASE_URL` (or `OPENHARNESS_DATABASE_URL`) for tenant/user provisioning. Redis rate-limit and quota leases are used when `REDIS_URL` is set; without it, the server uses process-local adapters. The server's session/job state and run execution still use the local implementation, so setting database or Redis variables does not enable a distributed API/worker topology. `oh migrate` applies the Postgres schema. `OPENHARNESS_MODE` and `OPENHARNESS_ROLE` are not implemented.

The supplied scaling prompt defines the detailed capacity targets, adapter behavior, security requirements, and acceptance criteria for this migration.
