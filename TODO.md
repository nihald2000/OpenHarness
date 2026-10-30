# OpenHarness Remediation & Long-Horizon Harness Checklist

## Remediation & Modal Sandbox Integration (`fixprompt.md` Steps 1–10)

- [x] **Step 1 — Build, workspace, CI, restored files (R7, F1, F4, F7)**:
  - [x] Configure `package.json` workspaces, `package-lock.json`, `tsconfig.json`, `tsconfig.server.json`, and `vite.config.ts`.
  - [x] Move shared SDK types to `packages/sdk/src/types.ts` (`@openharness/sdk`).
  - [x] Restore Postgres migrations (`001_distributed_runtime.sql`, `002_tenant_pause.sql`), OIDC/OAuth/MCP server modules, `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `examples/demo.eval.jsonl`, `tests/helpers/env.ts`, and `.github/workflows/ci.yml`.
- [x] **Step 2 — Workspace containment (S1)**:
  - [x] Implement `resolveInside` and `PathEscapeError` (`packages/core/src/util/safe-path.ts`) using `fs.realpathSync.native`.
  - [x] Enforce `resolveInside` across all file tools in `packages/core/src/tools/catalog.ts` (`tests/safe-path.test.ts`).
- [x] **Step 3 — Real model transport (R1)**:
  - [x] Implement `createHttpTransport` and `ProviderHttpError` (`packages/core/src/provider/http-transport.ts`) for OpenAI streaming SSE and Anthropic `/messages` SSE with `AbortSignal` support (`tests/provider-http.test.ts`).
- [x] **Step 4 — HTTP server, auth, SSE, input validation (R2, S5, S6, S7)**:
  - [x] Implement `loadServerConfig` (`packages/server/src/config.ts`) and `createHttpServer` (`packages/server/src/main.ts`).
  - [x] Remove `x-tenant-id` header trust, enforce fail-closed `/v1/admin/*` (`403`), `PATCH /v1/sessions/:id` allowlist, and `/v1/events` SSE replay + deduplication (`tests/server-http.test.ts`).
- [x] **Step 5 — Persistence (R6, F5, F7)**:
  - [x] Implement `atomicWriteFileSync` (`packages/core/src/util/atomic-write.ts`) and append-only `events.jsonl` in `LocalStateStore`.
  - [x] Replace fake `PostgresStateStore` and `PostgresJobQueue` inheritance with real `pg.Pool` SQL implementations gated by `OPENHARNESS_POSTGRES=1` (`tests/state-store.test.ts`).
- [x] **Step 6 — Harden `oh-sandboxd` (S2, S3, S10)**:
  - [x] Implement `spawnConfined`, `BASE_ENV` secret scrubbing, `toSrtSettings` schema translation, fail-closed `503` when `requireSrt: true` and `srt` is absent, and `x-oh-request-id` deduplication (`tests/sandboxd-confine.test.ts`).
- [x] **Step 7 — Real Modal sandbox integration (R4, S9, F6)**:
  - [x] Implement `ModalSandboxProvider`, `HttpDaemonTransport`, `SandboxRecordStore` (`InMemorySandboxRecordStore`, `FileSandboxRecordStore`), `toModalNetwork`, `materializeWorkspace`, 23h `rollover`, and `reapOrphanModalSandboxes` (`tests/modal-provider.test.ts`, `tests/modal-live.test.ts`).
  - [x] Remove duplicate root Python files and archive legacy Python prototypes under `deploy/modal/legacy/`.
- [x] **Step 8 — Wire the engine to real sandboxes (R4, R5, S3, S4, S8)**:
  - [x] Implement `createRunHooks` (`packages/server/src/run-hooks.ts`), wire `ensureSandbox` into `AgentEngine.runStep`, report honest `/v1/runtimes` health and `osEnforced`, and enforce `404`/`409` validation in `rewindSession` (`tests/run-hooks.test.ts`).
- [x] **Step 9 — Real web client (R3)**:
  - [x] Implement `HttpOpenHarnessClient` (`src/lib/http-client.ts`) over `/v1/*` and `/v1/events` SSE, gate `src/lib/demo-client.ts` behind `VITE_OPENHARNESS_DEMO=1` with a banner, and authenticate admin sessions via `POST /v1/admin/session` HttpOnly cookies (`tests/web-client.test.ts`).
- [x] **Step 10 — Remove fabrications and update documentation (F1, F2, F3, F4, F6)**:
  - [x] Add `packages/sandboxd/browser-worker.mjs` and fail closed (`503`) on `/browser/*` when Playwright is required and unavailable (`tests/step-10-browser-compaction.test.ts`).
  - [x] Wire LLM `summarizer` into `LayeredContextManager` for non-`mock/*` models (`tests/step-10-browser-compaction.test.ts`).
  - [x] Expand `packages/core/src/*` domain modules and verify behavior in `tests/phase-k-config-cli-sdk-final.test.ts`.
  - [x] Delete `metadata.json` and update `README.md`, `TODO.md`, and `docs/*.md`.
