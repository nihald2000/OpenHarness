# OpenHarness

OpenHarness is a model-agnostic, long-horizon AI agent harness and developer workspace (`packages/{core,server,sdk,sandboxd,cli}` + Vite React SPA in `src/`). Configured models (OpenAI, Anthropic, Meta Llama API, Together, Groq, Fireworks, Ollama, vLLM, LiteLLM, or the offline `mock/*` provider) run through a durable state machine (**plan → build → test → fix → review → checkpoint**) with real HTTP/SSE model transport, realpath-enforced workspace containment, and isolated sandboxes (`srt-local`, `docker`, `modal`).

## Architecture & Key Capabilities

- **Durable Resumable Agent Engine (`packages/core/src/agent`, `packages/core/src/infra`)**:
  - State machine (`planning | building | testing | fixing | reviewing | awaiting_permission | paused | completed | failed | cancelled | stuck`) executed by `DurableWorker` over `InProcessJobQueue` or SQL-backed `PostgresJobQueue`.
  - Local persistence (`LocalStateStore`) appends events to `events.jsonl` and writes snapshots via `atomicWriteFileSync` (with Windows `EPERM`/`EBUSY` retry). PostgreSQL persistence (`PostgresStateStore`, `PostgresJobQueue`) executes real parameterized SQL and fails closed unless `OPENHARNESS_POSTGRES=1` is enabled.
  - Both state-store adapters expose tenant-scoped schedule-record operations; PostgreSQL creates the `schedules` table through migration `003_schedules.sql`. `/v1/schedules` is still backed by the in-process `ScheduleManager` pending persistence wiring.
- **Model-Agnostic Provider Layer (`packages/core/src/provider`)**:
  - Real `fetch` + `eventsource-parser` streaming SSE transport (`createHttpTransport`) for OpenAI-compatible `/chat/completions` and Anthropic `/messages` (`tool_use` content blocks), honoring `AbortSignal` cancellation and `Retry-After` headers.
  - Built-in capability profiles (`ModelProfile`), missing tool-call ID synthesis, malformed JSON argument repair, pythonic/XML text tool-call fallback parsing, and JSON schema validation.
- **Workspace Runtimes & `oh-sandboxd` (`packages/core/src/sandbox`, `packages/sandboxd`)**:
  - `local`: Runs the in-process `oh-sandboxd` against the bound workspace with path checks for file tools and open network access. Without SRT, shell commands run as the server process user and can access paths outside the workspace; this runtime has no OS-level isolation. Use an OS-enforced runtime for untrusted work. `task` and `long_task` no longer require `allowUnsandboxedAutonomy` on `local`.
  - `srt-local` & `docker`: Use the managed daemon and retain filesystem policy, approvals, timeouts, and cancellation. Host binary preflight is disabled in the server; if OS enforcement is unavailable the workspace tools still run in process and `/v1/runtimes` reports `osEnforced: false`. Non-Modal runs default to open network access; Modal keeps its domain allowlist because the Modal adapter rejects open egress.
  - `modal`: Cloud microVM provider (`ModalSandboxProvider`) with two-phase `setup` → `agent` image caching, Modal `cidr_allowlist` / `block_network` egress enforcement, short-lived `connectToken` HTTPS transport (`HttpDaemonTransport`) with `x-oh-request-id` idempotency, AES-256-GCM encrypted session keys in `SandboxRecordStore`, `snapshotFilesystem` pause/resume preserving `handleId`, 23-hour rollover, and orphan reaping.
- **HTTP Server, Auth & Real Web Client (`packages/server`, `src/lib`)**:
  - HTTP server entry point (`packages/server/src/main.ts`) with fail-closed non-loopback auth guards (`loadServerConfig`), OIDC JWT verification, signed HTTP-only guest cookies for hosted public chat (separate tenant per browser), administrator-only settings and `/v1/admin/**` routes, server bearer tokens, and `PATCH /v1/sessions/:id` field allowlisting.
  - Web client (`src/lib/http-client.ts`) communicates with `/v1/*` and replays `/v1/events` SSE streams using `after` sequence cursors. The UI requires a configured provider and shows setup guidance instead of scripted sample prompts when no model is available. Offline mock transport remains for local development and evaluation.
  - Ask mode is the default in the hosted web app and calls the configured model without provisioning a sandbox. Code mode still requires an explicitly selected, active sandbox runtime.
  - Chat attachments: use the composer `+` menu to select files or a folder, or drop files onto the composer. Uploads preserve folder paths, appear in the transcript, and are stored under tenant/session-scoped `dataDir/attachments`; each prompt accepts up to 100 files and 20 MB total, each file is limited to 20 MB, and each session stores up to 100 MB. Text and common images are passed as untrusted model context, PDFs are sent to Anthropic Messages models, and Code mode copies attached file bytes into the sandbox under `attachments/<group>/` for the agent to inspect. Protected credential paths such as `.env`, `.git`, and `.ssh` are rejected. Upload records are removed when the session is deleted.

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
