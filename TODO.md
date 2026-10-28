# OpenHarness backend completion checklist

The server typecheck script cannot find `tsc`; direct invocation reports missing Node/Bun type declarations and strict typing errors. See `docs/SCALING.md` for the current scaling migration status.

## Distributed scaling request

- [x] Add the initial shared infrastructure contracts and route local live SSE fan-out through the in-process EventBus; preserve the existing event replay store.
- [ ] Complete local adapters for state, jobs, cancellation, locks, rate limits, quotas, secrets, configuration, and runtime execution; remove direct infrastructure access from the server and runner.
- [ ] Add PostgreSQL/Redis adapters, schema migrations, atomic per-session event sequencing, and cross-node SSE replay recovery.
- [ ] Add durable worker jobs, leases, fencing, checkpoints, durable approvals, and resumable runs.
- [ ] Add OIDC identity, tenant-scoped authorization, rate limits/quotas, remote sandboxes, config/secret/content repositories, and operations instrumentation/deployment.
- [ ] Pass local compatibility checks plus distributed contract, integration, chaos, and load acceptance criteria from `docs/SCALING.md`.

Tracks the consolidated requirements in `prompt.md`. Items are checked only when implemented and verified. `build:server` and `git diff --check` pass for this workspace revision; the server typecheck script cannot find `tsc`, while direct invocation is blocked by missing Node/Bun type declarations and strict typing errors.

## Done in this pass

- [x] Add the four built-in agents and expose discovered/configured agents, skills, and commands in catalog routes.
- [x] Resolve simple slash commands with `$ARGUMENTS` and `$1`–`$9`; merge configured agent permissions restrictively.
- [x] Make `AGENTS.md` loading explicit opt-in (`prompt.includeRepositoryInstructions: true`); default is off. Bound loaded prompt context.
- [x] Wire plan mode to `update_plan`, keep all generated steps pending, and emit skill and verification parts.
- [x] Enforce prompt, output, and transcript context limits; improve manual compaction to preserve active tool calls and summarize recent requests and verification/error evidence.
- [x] Add bounded workspace `search` and approval-gated direct-process `shell` tools; avoid shell expansion.
- [x] Add the authenticated admin reload route for ephemeral plugin reset and MCP reconnection.
- [x] Enforce the 1 MB request-body cap for streamed bodies as well as declared `Content-Length`.
- [x] Publish verification start/completion events and keep the `verifying` session state covered by run timeouts.
- [x] Produce the server single-binary build and pass `git diff --check`.
- [x] Document HTTP routes, authentication, configuration sections, environment variables, eval formats, and current feature limits.
- [x] Point the server and binary entry points at the durable API implementation; preserve the scripted demo under `demo-main.ts`.

## Existing implemented baseline

- [x] Bun backend, persistence, sessions/messages, bearer auth, durable SSE replay, mock/OpenAI-compatible provider, and binary packaging.
- [x] Encrypted secret storage, settings endpoints, server-side tool approval, cancellation, and recovery of interrupted runs.
- [x] MCP stdio/HTTP/SSE support, secret references, reconnect behavior, bounded tool outputs, and filesystem/Playwright MCP presets.
- [x] CLI catalog/run/config/secrets/MCP/plugin/JSONL-eval commands, Docker/Compose, CI, and deployment documentation.
- [x] Bounded delegation, configured run limits, fixed approval-gated verifier, and opt-in Modal Python execution.

## Still to implement or verify

- [x] Support workspace-relative configured skill directories and bounded nested `AGENTS.md` path/glob discovery behind the repository-instructions opt-in.
- [x] Expand YAML frontmatter validation to support nested mappings/lists, quoted and scalar values, duplicate-key rejection, and explicit rejection of unsupported YAML features. This is a bounded subset, not full YAML 1.2.
- [x] Capture streamed provider token usage, estimate full serialized context when usage is unavailable, and report per-message/session cost when model prices are configured.
- [x] Enforce per-turn token caps and optional per-run/per-session cost limits when model prices are configured.
- [x] Compact older context automatically at the configured token threshold; preserve recent messages and active tool calls and summarize recent requirements, decisions, and verification/error evidence.
- [x] Persist extracted user requirements, assistant decisions, and outstanding question sentences as structured fields in compaction records; preserve the readable summary and keep extraction bounded.
- [ ] Implement general `run_code` with typed tool bindings and isolated execution; current Modal tool is Python-only and does not provide typed bindings.
- [ ] Finish configured verify/fix loops and focused coverage. Prompt `fix.commands` and `verify.auto` now guide the agent through the allowlisted checks, with bounded retries and `fix.status` events; arbitrary configured commands and integration coverage remain outstanding.
- [ ] Implement a first-party browser plugin and general trusted plugin manifests/contributions with lifecycle health and rollback; current browser support is a Playwright MCP preset and plugins are a small built-in allowlist.
- [x] Document each implemented HTTP route and auth rule.
- [x] Complete SDK shapes for reasoning/step parts, structured compaction fields, verification lifecycle events, runtime reloads, and permission replies; retain the run-status/fix-status variants for their public contract.
- [x] Add structured JSON error logs with common secret fields, bearer tokens, and API key patterns redacted before output.
- [x] Add SDK event shapes for all current server event variants, structured compaction fields, reasoning and step parts; cover SDK message/part event handling with two tests.
- [x] Add exact tool-call/success assertions and pending-approval reporting to JSONL eval output.
- [x] Add a constrained YAML suite parser for flat case mappings and scalar lists; unsupported nested YAML syntax is rejected and documented.
- [ ] Consider full YAML 1.2 support if suites need anchors, aliases, or nested structures.
- [x] Add and run Bun safety tests for workspace containment, plan validation, agent tool policies, secret masking, verifier allowlisting, eval parsing, plugin allowlisting, MCP config, configured skill/instruction boundaries, nested agent/skill frontmatter, provider pricing, compaction, context budgets, and log redaction (15 tests passed).
- [ ] Add focused coverage for server permission decisions, SSE replay, context limits, and plugin/MCP lifecycle.
- [x] Run the web application type check (`bun run typecheck`).
- [ ] Run clean-install and server type checks, offline acceptance flow, and eval suite. `tsc` is unavailable for the server package; web production build reached a sandbox process-spawn failure while parsing CSS; loopback HTTP requests are denied here, so the offline API smoke and eval suite remain unrun.

## Web authentication request

- [x] Add the `/login` page with Google/GitHub sign-in, signup/login mode, user-safe callback errors, and administrator-token recovery.
- [x] Implement server-side OAuth state, PKCE, Google ID-token validation, GitHub verified-email lookup, persistent profile creation, provider linking, session cookies, and logout.
- [x] Add invite-list and explicit open-signup controls; protect all web-proxied `/v1/**` routes behind a session and document the shared-workspace role model.
- [ ] Complete live provider callback verification after client credentials and registered callback URLs are configured.
