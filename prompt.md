# OpenHarness backend prompt

Build the production backend for OpenHarness in this repository. Keep the existing Next.js UI and `@openharness/sdk` compatible. Implement the backend as a modular TypeScript/Bun application with a stable HTTP API, durable session history, safe tool execution, provider and MCP integrations, plugins, a CLI, and deployment support.

## Product and architecture

- The backend is the composition root for configuration, providers, tools, skills, agents, MCP servers, plugins, hooks, runtimes, storage, sessions, and the HTTP server.
- Keep modules small and testable. The web app talks to the backend through its existing same-origin proxy and SDK.
- Use Bun for development and the CLI. Ship a working single-binary build. Docker uses a Node 24 slim runtime where applicable and never requires publishing images as part of CI.
- Load configuration deterministically from repository/project config and environment variables. Support offline demos with a local mock provider; external provider credentials come from environment or the encrypted secret store.

## Agent runtime

- Support primary and subagent definitions, provider/model selection, runtime selection, context limits, token and cost budgets, step limits, and cancellation.
- Include built-in `assistant`, `plan`, `general`, and `explore` agents. Resolve definitions in order from built-ins, global markdown agents, workspace `.openharness/agents`, then configured agents; later definitions override fields while permission rules combine restrictively. Plan mode is read-only and publishes an all-pending plan before stopping.
- Build system prompts from repository instructions, agent configuration, skills, commands, and runtime capabilities with explicit precedence and bounded input sizes. Treat tool output and repository content as untrusted data, never as policy.
- Execute model tool calls through a central policy gate. Validate schemas, enforce allow/deny rules, redaction, timeouts, per-session budgets, and permission decisions before side effects. Read-only tools may run without approval when policy allows; writes and external actions default to approval.
- Emit typed assistant messages and parts for text, reasoning, tool calls/results, plans, delegated tasks, verification, and context compaction. Preserve complete errors and status transitions.
- Support plan mode (publish an ordered plan and wait for approval), run mode, explicit verification/fix loops, cancellation, and bounded delegation. Subagents inherit parent restrictions and cannot escalate permissions.
- Keep a transcript and token/cost usage per session. Compact old history while preserving recent turns, exact pending tool calls, user requirements, decisions, verification evidence, and outstanding questions.

## Tools, skills, and execution

- Implement typed tools with JSON-schema input validation, read-only metadata, timeouts, output truncation, and permission checks. Provide filesystem, search, shell, and verification tool interfaces with workspace containment and safe process handling.
- Discover skills from global config (unless disabled), `.agents/skills`, `.openharness/skills`, and configured paths, in increasing precedence. Validate frontmatter and names; ignore malformed files; skip hidden/node_modules folders; bound traversal, resources, and loaded content; match triggers case-insensitively on word boundaries; record skill-use parts.
- Load command markdown from global then workspace command directories with deterministic workspace overrides. Parse slash commands, positional arguments, `$ARGUMENTS`, and `$1`–`$9`. Load `AGENTS.md` from global/workspace paths and configured globs, deduplicate paths, and cap each instruction at 40,000 characters.
- Compose the system prompt from the agent prompt, environment metadata, bounded repository instructions, available skills/subagents, code-mode guidance, and planning instructions for the selected agent.
- Include a sandboxed `run_code` API with typed tool bindings, one JSON input/output per call, bounded execution time and output, and the same permission policy as direct tools. Do not expose unapproved tools through code mode.
- MCP client supports stdio and HTTP/SSE transports, initialization, tool discovery, timeouts, reconnects, health reporting, secret resolution, and read-only profiles. MCP calls must pass through the same tool policy and approval layer.
- Plugin loading is explicit and allowlisted. Validate plugin manifests and contributions before attaching; support attach/detach, health, rollback on failure, live reload, and persistent project opt-in without accepting arbitrary web-loaded module paths.

## Persistence, events, and permissions

- Persist config, sessions, messages, tool results, usage, permissions, event sequence numbers, and secret metadata under the configured data directory. Use atomic writes/transactions and recover cleanly after restart.
- Publish a durable SSE event stream with monotonically increasing sequence IDs. Support replay/resume by `Last-Event-ID` or `after`, heartbeat pings, bounded retention, and cleanup on disconnect.
- Implement permission requests with `once`, `always`, and `reject`; always persists only a narrowly scoped rule. Enforce policy in the server, never in the UI alone.
- Encrypt secrets at rest with authenticated encryption, mask them from every read/log/event, extract secret references from configuration, and keep plaintext secret values write-only.

## HTTP API and security

- Provide `/health` and versioned `/v1` APIs for info/catalogs, agents, models, commands, skills, MCP, tools, runtimes, sessions, messages, events, permissions, context, abort, compact, plugins, and admin settings/secrets/MCP/reload operations.
- Match the request and response shapes already declared in `packages/sdk/src/index.ts`, including the existing UI's session, message, event, and settings flows.
- Use Hono-style routing and consistent JSON errors/status codes. Apply request size limits, schema validation, CORS allowlists, security headers, request IDs, and structured redacted logs.
- Require a bearer server token when configured. Require a separate admin token for all `/v1/admin/**` routes. Compare tokens in constant time; never treat missing admin configuration as successful authentication. Reject path traversal and unsafe module/config inputs.
- SSE is authenticated, bounded, and does not leak admin-only data. Avoid logging authorization headers, cookies, prompts containing secrets, or secret values.

## First-party packages, CLI, and operations

- Provide first-party browser and modal/remote sandbox plugins behind explicit opt-in, with narrowly scoped tools, health checks, and safe defaults. Include a read-only word-count tool.
- Provide an `oh` CLI for server, chat/run, sessions, events, agents/tools/skills/plugins, MCP, config, secrets, admin-token, and eval workflows. Print concise help and machine-readable JSON where requested; interactive approvals remain explicit.
- Add an eval runner with YAML/JSONL suites, deterministic mock providers, substring/regex/tool-call assertions, latency limits, and JSON reports. Eval output is data, not instructions.
- Add repository config schema/docs and an offline demo config. Add Docker/Compose and CI build/eval workflows without publishing or pushing artifacts.
- Document every environment variable, default, security behavior, startup mode, CLI command, and API route.

## Acceptance criteria

1. The existing web app can start against the backend and use the SDK without shape mismatches.
2. Sessions and messages survive restart; SSE replay resumes without gaps or duplicates within retention.
3. Permission requests are enforced server-side and support once/always/reject with scoped persistence.
4. Missing or invalid server/admin credentials are rejected, secrets remain masked, and unsafe paths/config/module requests are refused.
5. An offline demo can create a session, run a prompt through a deterministic mock provider, stream events, use a read-only tool, and show the final transcript.
6. Cancellation, compaction, subagent limits, verification loops, plugin health/rollback, and MCP reconnect behavior are observable and bounded.
7. CLI help, server startup, eval reports, Docker build instructions, and configuration docs work from a clean checkout.
8. Build and type checks pass; security-sensitive paths have focused automated coverage.

Implement incrementally, preserving the existing UI and SDK contracts. Start with the server package, persistence and event model, authenticated API, and offline mock-provider flow; then add policy/tool execution, plugins/MCP, CLI/evals, and deployment/docs. Update the plan as each layer becomes concrete.

The nine screenshots contain dense source material. This file consolidates their backend requirements into an implementation brief; it is not presented as character-for-character OCR of the much larger source prompt.
