# OpenHarness

OpenHarness is a model-agnostic, long-horizon AI agent harness and developer workspace (`packages/{core,server,sdk,sandboxd,cli}` + Vite React SPA in `src/`). Configured models (OpenAI, Anthropic, Meta Llama API, Together, Groq, Fireworks, Ollama, vLLM, LiteLLM, or the offline `mock/*` provider) run through a durable state machine (**plan → build → test → fix → review → checkpoint**) with real HTTP/SSE model transport, realpath-enforced workspace containment, and isolated sandboxes (`srt-local`, `docker`, `modal`).

## Architecture & Key Capabilities

- **Durable Resumable Agent Engine (`packages/core/src/agent`, `packages/core/src/infra`)**:
  - State machine (`planning | building | testing | fixing | reviewing | awaiting_permission | paused | completed | failed | cancelled | stuck`) executed by `DurableWorker` over `InProcessJobQueue` or SQL-backed `PostgresJobQueue`.
  - Local persistence (`LocalStateStore`) appends events to `events.jsonl` and writes snapshots via `atomicWriteFileSync` (with Windows `EPERM`/`EBUSY` retry). PostgreSQL persistence (`PostgresStateStore`, `PostgresJobQueue`) executes real parameterized SQL and fails closed unless `OPENHARNESS_POSTGRES=1` is enabled.
- **Model-Agnostic Provider Layer (`packages/core/src/provider`)**:
  - Real `fetch` + `eventsource-parser` streaming SSE transport (`createHttpTransport`) for OpenAI-compatible `/chat/completions` and Anthropic `/messages` (`tool_use` content blocks), honoring `AbortSignal` cancellation and `Retry-After` headers.
  - Built-in capability profiles (`ModelProfile`), missing tool-call ID synthesis, malformed JSON argument repair, pythonic/XML text tool-call fallback parsing, and JSON schema validation.
- **Fail-Closed Sandboxes & `oh-sandboxd` (`packages/core/src/sandbox`, `packages/sandboxd`)**:
  - `local`: Host workspace containment via `resolveInside` (`fs.realpathSync.native`). Refuses `task` and `long_task` modes unless `allowUnsandboxedAutonomy: true` is explicitly configured.
  - `srt-local` & `docker`: Confined via `oh-sandboxd` (`spawnConfined` with scrubbed `BASE_ENV`, process-group kill, and `@anthropic-ai/sandbox-runtime` `toSrtSettings` schema). `GET /v1/runtimes` reports honest host binary/daemon availability (`active: false` with `detail` when `srt` or `docker` is not installed).
  - `modal`: Cloud microVM provider (`ModalSandboxProvider`) with two-phase `setup` → `agent` image caching, Modal `cidr_allowlist` / `block_network` egress enforcement, short-lived `connectToken` HTTPS transport (`HttpDaemonTransport`) with `x-oh-request-id` idempotency, AES-256-GCM encrypted session keys in `SandboxRecordStore`, `snapshotFilesystem` pause/resume preserving `handleId`, 23-hour rollover, and orphan reaping.
- **HTTP Server, Auth & Real Web Client (`packages/server`, `src/lib`)**:
  - HTTP server entry point (`packages/server/src/main.ts`) with fail-closed non-loopback auth guards (`loadServerConfig`), OIDC JWT verification, `CookieSessionStore` (`HttpOnly; SameSite=Strict` cookies via `POST /v1/admin/session`), server bearer tokens, and `PATCH /v1/sessions/:id` field allowlisting.
  - Web client (`src/lib/http-client.ts`) communicates with `/v1/*` and replays `/v1/events` SSE streams using `after` sequence cursors. The offline simulator (`src/lib/demo-client.ts`) is only used when `VITE_OPENHARNESS_DEMO=1` is set and displays a visible `"Demo mode - no real agent"` banner.

## Development, Building & Testing

```bash
# Typecheck frontend and backend workspaces
npm run typecheck
npm run typecheck:server

# Run the full test suite (Steps 1-10 + Phases A-K)
npm test

# Build the production Vite frontend bundle
npm run build

# Start the HTTP server (writes generated admin token to .openharness/admin-token in loopback mode)
npm run server

# Build the Modal sandbox base image (requires Modal Python SDK + credentials)
npm run modal:image
```
