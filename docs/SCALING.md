# Scaling architecture and migration status

OpenHarness is currently a single-process, single-workspace service. This document tracks the migration toward separately scaled API and worker processes while keeping local development as the default.

## Current behavior

- The Bun server owns run execution, cancellation, permission waiters, and event fan-out in one process.
- Session, message, permission, grant, and event records are persisted as one JSON document under `OPENHARNESS_DATA_DIR` (default `.openharness`). The current implementation does not use SQLite.
- SSE event IDs are monotonically increasing sequence numbers from that local store. Reconnect replay and the existing `ready`/`ping` behavior remain part of the API contract.
- Tools execute on the API host, except the opt-in Modal Python sandbox.
- There is no distributed mode, Postgres/Redis adapter, durable job queue, OIDC API-token middleware, or tenant isolation yet.

## Adapter migration

The shared contracts start in `packages/core/src/infra`. The API now uses the local `InProcessEventBus` for live SSE fan-out, `JsonDocumentStore` for loading and atomically saving the legacy state document, `InProcessCancelBus` for active-run cancellation, and `InProcessLockService` to serialize local config, secret, plugin, and MCP read-modify-write operations. Prompt acceptance also goes through `InProcessJobQueue`, which claims, heartbeats, checkpoints run start, and finalizes each local run. Local token-bucket, run-quota, and tenant-scoped JSON `StateStore` adapters are implemented. The quota adapter and domain `StateStore` are not yet connected to API admission/state access; local event replay still uses the legacy global sequence so current SSE IDs remain unchanged. The queue and mutable session state are still in memory, and per-step checkpoint recovery is not implemented. Durable job recovery, API rate/quota enforcement, secret/config storage adapters, and workspace execution still need migration. The server bundle and all 32 current server/SDK tests pass for the adapter slice. The server typecheck script cannot find `tsc`; direct invocation is also blocked by missing Node/Bun type declarations and existing strict type errors. The eval suite was not run.

## Intended distributed topology

The target deployment separates stateless API pods from worker pods. Postgres will be the durable source of truth for tenant-scoped state, events, jobs, approvals, and configuration versions. Redis will carry best-effort event fan-out, cancellation signals, and rate-limit state. Workers will claim leased jobs, checkpoint progress with fencing, and use remote per-session sandboxes. Redis loss must not lose durable events or jobs.

## Delivery phases

1. Introduce adapters and preserve local behavior. Current progress: shared contracts exist and the API's live SSE fan-out uses the local `InProcessEventBus`; the JSON state store and run loop still need to move behind adapters.
2. Add Postgres state, transactional event sequencing/outbox, Redis fan-out, and cross-node SSE gap recovery.
3. Add durable jobs, worker processes, leases, checkpoints, fencing, cancellation, and resumable runs.
4. Make approvals and provider retries durable waiting jobs.
5. Add OIDC identity and enforce tenant/user authorization on every route and stream.
6. Add distributed rate limits, quotas, and admission control.
7. Move file/process tools to isolated workspace runtimes.
8. Add versioned configuration, secret vault, and tenant content repositories.
9. Add metrics, traces, dashboards, alerts, Kubernetes deployment, and runbooks.
10. Run integration, chaos, and load certification against the target SLOs.

## Configuration status

`OPENHARNESS_MODE`, worker, Postgres, Redis, OIDC, KMS, and sandbox deployment variables are not implemented yet. Do not set a distributed-mode environment value expecting distributed behavior; the server currently runs only the local implementation.

The supplied scaling prompt defines the detailed capacity targets, adapter behavior, security requirements, and acceptance criteria for this migration.
