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
- A generic third-party runtime/plugin contribution API remains open; only explicitly allowlisted built-ins can currently attach.
- Added an authenticated admin reload route to reset ephemeral plugin state and reconnect MCP servers.

## Phase 4: Operator experience — implemented

- `oh` CLI for server, catalogs, event streaming, prompts, config, encrypted secrets, plugin lifecycle, MCP presets and management, and JSONL or restricted-YAML eval suites with tool/approval assertions.
- Config schema and offline demo eval suite.

## Phase 5: Packaging and delivery — implemented; binary build verified

- Single Bun server binary, Node 24 Docker targets for backend and web, Compose, CI build/typecheck/eval workflow, environment template, and deployment docs.
- The server binary build and `git diff --check` succeed. `typecheck:server` cannot run because `tsc` is not installed. Web builds failed in this sandbox (Turbopack worker spawn failure; webpack `EPERM` creating a generated `.next/types` directory). End-to-end eval has not been run.

## Current starting point

- Existing workspace: Next.js web UI and SDK only; backend package is absent.
- Baseline commit: `aab4a94` (`chore: save existing OpenHarness workspace`).
- Working branch: `codex/backend-runtime`.
- Remaining work is tracked in `TODO.md`, including full browser/plugin lifecycle, general sandboxed `run_code`, automatic verify/fix loops, YAML evals, complete SDK event coverage, and automated safety-focused tests.
