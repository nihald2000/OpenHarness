# Backend implementation plan

## Phase 1: Runnable server foundation — complete

- Bun server entrypoint, JSON-backed session persistence, SDK-compatible base APIs, server/admin auth, and replayable durable SSE event IDs.
- Offline mock and streaming OpenAI-compatible provider adapters.

## Phase 2: Agent execution and safety — in progress

- Built-in `word_count`, workspace-confined `read_file`, approval-gated `write_file`, once/always/reject policy, cancellation, and interrupted-run recovery.
- Compaction and context usage endpoints.
- Added OpenAI-compatible native function tool-call loops through the same permission policy as direct `/tool` calls.
- Added configured concurrency, run-duration, tool-output, and iteration limits; long-running built-in, MCP, and Modal tools now receive cancellation signals.
- Added bounded analysis-only subagent delegation; subagents cannot call tools or modify files, and `limits.maxSubagents` caps their use per run.
- Added an approval-gated verifier tool with fixed typecheck/build/diff checks; `verify.maxIterations` bounds verifier use, and verification start/completion events are observable.
- Added built-in agent/catalog discovery, simple slash command expansion, restrictive configured-agent tool policy, plan mode, bounded context handling, manual compaction summaries, and typed skill/verification parts.
- Repository `AGENTS.md` prompt inclusion is opt-in through `prompt.includeRepositoryInstructions`; it defaults to off.
- Added bounded `search` and approval-gated direct-process `shell` tools.
- Added streamed request-body limits, verification lifecycle events, and a restricted YAML eval format with exact tool and pending-approval assertions.
- Added passing Bun unit coverage for path containment, plan input validation, encrypted secret storage/masking, and verifier allowlisting.
- Added bounded configured skill roots and opt-in nested instruction discovery; wired actual streaming usage/cost reporting with configurable model pricing.
- Added per-run/per-session cost caps, provider `max_tokens`, automatic token-threshold compaction, and a unit check that preserves active tool messages and summarizes requirements/decisions.
- Added API and configuration references covering routes, authentication, environment variables, settings, and current sandbox limits.
- Switched `src/main.ts` and the compiled binary entry from the scripted UI demo to the durable `server.ts` API; retained the old demo as `demo-main.ts`.

## Phase 3: Extensibility and administration — substantially implemented

- Admin settings persistence, AES-GCM secret storage, plaintext-secret extraction from settings, and an allowlisted built-in plugin lifecycle.
- MCP configuration and clients for stdio, streamable HTTP, and SSE endpoint discovery; MCP tool schema checks, approval policy, output limits, manual reconnect, bounded exponential reconnect, and filesystem/browser presets.
- Added an opt-in Modal sandbox plugin with tool approval, bounded Python execution/output, isolated temporary sandboxes, and outbound networking blocked by default.
- Implemented Phase 1 Production Modal Sandbox Harness (`modal.Sandbox`) with Anthropic's "Code Execution with MCP" architecture:
  - Multi-compiler & runtime Ubuntu 24.04 VM image (`modal_image.py`) with Python 3.12, Node 22, Rust, Go, Clang, gcc/g++, Playwright chromium, Pandoc, LibreOffice, and Anthropic Sandbox Runtime (`srt`).
  - In-sandbox MCP Python bridge layout (`/mnt/mcp_servers/`) with stdio JSON-RPC client, Playwright automation, GitHub API, Filesystem access, and document/charting skills (`mcp_code_bridge.py`).
  - Host-side `ModalSandboxManager` (`sandbox_manager.py`) with VM sandboxes, dynamic network modes (`connected`, `github_only`, `airgapped`), state-preserving bash execution, 12k char output truncation, file copy I/O, port 3000/8080 tunnels, and zero-cost filesystem snapshot hibernation.
  - Minimal Claude tool interface (`agent_tools.py`) exposing `discover_mcp_modules`, `execute_sandbox_code`, `export_artifact`, and specialized code-mode system prompt.
- A generic third-party runtime/plugin contribution API remains open; only explicitly allowlisted built-ins can currently attach.
- Added an authenticated admin reload route to reset ephemeral plugin state and reconnect MCP servers.

## Phase 4: Operator experience — implemented

- `oh` CLI for server, catalogs, event streaming, prompts, config, encrypted secrets, plugin lifecycle, MCP presets and management, and JSONL or restricted-YAML eval suites with tool/approval assertions.
- Config schema and offline demo eval suite.

## Phase 5: Packaging and delivery — implemented; binary build verified

- Single Bun server binary, Node 24 Docker targets for backend and web, Compose, CI build/typecheck/eval workflow, environment template, and deployment docs.
- The server binary build and `git diff --check` succeed. `typecheck:server` cannot run because `tsc` is not installed. Web builds failed in this sandbox (Turbopack worker spawn failure; webpack `EPERM` creating a generated `.next/types` directory). End-to-end eval has not been run.

## Distributed scaling migration — phases 2–6 in progress

- The requested scaling specification and remaining implementation gaps are tracked in `docs/SCALING.md` and `TODO.md`.
- Postgres state/job/permission/identity/usage adapters, numbered migrations, transactional events/outbox, Redis event/cancel/rate/quota adapters, worker lifecycle and reaper primitives, OIDC verification, session authorization, and phase 6 request/SSE limits have been added.
- The server binary build and server typecheck pass; the server/SDK suites report 35 passing tests. The local JSON store retries transient Windows sharing violations during atomic rename. No live Postgres/Redis or multi-node integration has been run.
- Remaining work through phase 6: wire Postgres state/jobs and durable approvals into API/worker execution, extract the resumable step machine, forward end-user identity through the web proxy, enforce tenant configuration authorization, then run distributed adapter/integration/chaos tests.
- The default server still uses local session/job state and in-process run execution. Do not claim distributed readiness until the listed integration and acceptance checks pass.

Other backend feature work remains tracked in `TODO.md`.
