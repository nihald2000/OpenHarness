# Scaling architecture and migration status

OpenHarness is currently a single-process, single-workspace service. This document tracks the migration toward separately scaled API and worker processes while keeping local development as the default.

## Current behavior

- The Bun server owns run execution, cancellation, permission waiters, and event fan-out in one process.
- Session, message, permission, grant, and event records are persisted as one JSON document under `OPENHARNESS_DATA_DIR` (default `.openharness`). The current implementation does not use SQLite.
- SSE event IDs are monotonically increasing sequence numbers from that local store. Reconnect replay and the existing `ready`/`ping` behavior remain part of the API contract.
- Tools execute on the API host, except the opt-in Modal Python sandbox.
- The server still runs only the local implementation. Postgres state/job adapters, migrations, Redis event/cancel buses, and an outbox relay now exist in the core package, but they are not selected or wired into the API runtime yet. There is no distributed mode, worker process, OIDC API-token middleware, or production tenant authorization yet.

## Adapter migration

The shared contracts start in `packages/core/src/infra`. The API now uses the local `InProcessEventBus` for live SSE fan-out, `JsonDocumentStore` for loading and atomically saving the legacy state document, `InProcessCancelBus` for active-run cancellation, and `InProcessLockService` to serialize local config, secret, plugin, and MCP read-modify-write operations. Prompt acceptance also goes through `InProcessJobQueue`, which claims, heartbeats, checkpoints run start, and finalizes each local run. Local token-bucket, run-quota, and tenant-scoped JSON `StateStore` adapters are implemented. The Postgres adapter set now includes tenant-scoped state/message/part storage, transactional per-session sequence allocation and outbox insertion, durable job enqueue/claim/heartbeat/fenced transitions, numbered migrations, and an `oh migrate` CLI command. Redis adapters provide cross-process event fan-out and cancellation; the outbox relay publishes committed envelopes at least once. A session replay gateway subscribes before replay, deduplicates by sequence, and polls the durable head to recover missed Redis publishes. A reusable worker lifecycle engine handles claims, batched heartbeats, cancellation, draining, and fenced requeue. Postgres advisory-lock leadership and a durable job reaper recover expired leases and wake due retry/quota waits. These distributed components are not yet wired into the server/API runtime, and an outbox scheduler, the concrete session run handler, per-step run checkpoints, and durable approvals remain outstanding. The local event replay still uses the legacy global sequence so current SSE IDs remain unchanged. Server and core adapter bundles build. Docker is unavailable here, so no live service integration was run.

## Intended distributed topology

The target deployment separates stateless API pods from worker pods. Postgres will be the durable source of truth for tenant-scoped state, events, jobs, approvals, and configuration versions. Redis will carry best-effort event fan-out, cancellation signals, and rate-limit state. Workers will claim leased jobs, checkpoint progress with fencing, and use remote per-session sandboxes. Redis loss must not lose durable events or jobs.

## Delivery phases

1. Introduce adapters and preserve local behavior. Current progress: shared contracts and local adapters are present; the API uses selected local adapters and preserves the existing JSON/SSE behavior.
2. Add Postgres state, transactional event sequencing/outbox, Redis fan-out, and cross-node SSE gap recovery. Current progress: migrations, core state/job adapters, Redis buses, an outbox relay, and a session replay gateway are implemented; server/API wiring and an outbox scheduler remain.
3. Add durable jobs, worker processes, leases, checkpoints, fencing, cancellation, and resumable runs. Current progress: durable job lifecycle adapter, reusable worker engine, and leader-elected lease reaper are implemented; the server still runs jobs in-process and does not persist a resumable per-step checkpoint.
4. Make approvals and provider retries durable waiting jobs.
5. Add OIDC identity and enforce tenant/user authorization on every route and stream.
6. Add distributed rate limits, quotas, and admission control.
7. Move file/process tools to isolated workspace runtimes.
8. Add versioned configuration, secret vault, and tenant content repositories.
9. Add metrics, traces, dashboards, alerts, Kubernetes deployment, and runbooks.
10. Run integration, chaos, and load certification against the target SLOs.

## Configuration status

`OPENHARNESS_MODE`, worker, Redis, OIDC, KMS, and sandbox deployment variables are not implemented yet. `OPENHARNESS_DATABASE_URL` is used by `oh migrate`; setting it does not switch the server from local mode.

The supplied scaling prompt defines the detailed capacity targets, adapter behavior, security requirements, and acceptance criteria for this migration.
