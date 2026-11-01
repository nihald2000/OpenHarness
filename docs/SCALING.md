# Scaling Architecture and Migration Status

## Hosted sandbox and model endpoint boundaries

Hosted sessions derive local workspace directories from a hash of tenant and session IDs. Their API facts report `/workspace`; host repository paths and host workspace outlines are excluded from guest prompts. When a session has a running sandbox, file listing, reads, archives, and filesystem MCP operations use that sandbox daemon transport. Modal preview links resolve from sandbox tunnels, while browser automation uses the sandbox-local `127.0.0.1` URL. The daemon port is never returned as a user preview.

Modal server startup requires real Modal credentials and a configured sandbox image manifest before selecting Modal automatically. Muse Glimmer vLLM runs as a separate Modal app with one GPU maximum and a five-minute scale-down window. These settings provide per-process/session isolation, not distributed state consistency: multi-node event replay and Postgres/Redis integration still need dedicated coverage before distributed-readiness claims.

The optional pinned Modal Sandbox Hub (`deploy/modal/sandbox_server.py`) provides a stable HTTPS daemon endpoint and keeps workspaces under tenant/session-derived IDs on the `openharness-workspaces` Modal Volume. `OH_MODAL_SANDBOX_URL` enables the `PinnedModalSandboxProvider`; if it is absent, the existing per-sandbox `ModalSandboxProvider` remains active. The hub runs one minimum container by default (`OH_SANDBOX_MIN_CONTAINERS=1`) and can be configured to scale to zero with `OH_SANDBOX_MIN_CONTAINERS=0`. Its single shared Modal volume and one-container limit are a persistence/availability strategy for this deployment, not a distributed multi-node storage or event-replay guarantee.

OpenHarness separates the stateless HTTP/SSE API layer from durable worker execution and isolated sandbox runtimes (`oh-sandboxd`), while keeping zero-setup local development as the default.

`McpClientManager` (`packages/core/src/mcp/client.ts`) supports in-process defaults and external HTTP/SSE/stdio MCP servers. Its active connections, discovered tools, and default memory graph are process-local; saved connection definitions do not make live sessions durable or shared across workers. MCP connection lifecycle and memory need tenant-scoped adapter contracts plus restart/replay coverage before they can be treated as distributed services.

The adapter contract includes tenant-scoped schedule record storage. Migration `003_schedules.sql` adds the PostgreSQL table, and `LocalStateStore` stores records in its snapshot. This does not yet make the `/v1/schedules` manager durable: that route still uses process-local state, and PostgreSQL/Redis integration plus multi-node replay coverage remains required before distributed readiness can be claimed.

## Architecture Overview

1. **Control Plane (`packages/server`, `packages/core`)**:
   - `OpenHarnessServer` (`packages/server/src/server.ts`) is a thin HTTP/SSE adapter that enqueues jobs to `JobQueue` (`InProcessJobQueue` locally, `PostgresJobQueue` when `DATABASE_URL` is configured) and streams events from `StateStore` (`LocalStateStore` / `PostgresStateStore`) and `EventBus`.
   - `DurableWorker` (`packages/core/src/infra/durable-worker.ts`) claims leased jobs with fencing tokens, executes steps through the `AgentEngine` state machine (`packages/core/src/agent/engine.ts`), persists a `StepCheckpoint` after every model response and tool call, and releases worker slots when a run enters `awaiting_permission` or `paused`.
   - On worker restart, a re-claimed job resumes from the latest `StepCheckpoint`: completed tool calls are never re-executed, and any tool call that was in-flight when the worker died is re-issued only if declared `idempotent: true` (otherwise reported to the model as `interrupted`).
   - Chat file attachments are stored in a tenant/session-scoped directory under `dataDir/attachments`, with metadata referenced by the durable user message and run record. The current implementation assumes the server's `dataDir` is persistent and shared by the API and worker; a multi-node deployment must move attachment bytes and metadata behind a tenant-scoped shared object-store adapter before distributing upload and execution across nodes.

2. **Model-Agnostic Provider Layer (`packages/core/src/provider`)**:
   - Built-in capability profiles (`ModelProfile`) for OpenAI, Anthropic (with explicit prompt-cache breakpoints), Meta Llama API (`max_completion_tokens`, `native-unreliable` tool calling, no `parallel_tool_calls`), Together, Groq, Fireworks, Ollama, vLLM/LiteLLM, Bedrock Converse (`streamingToolCalls: false`), and Gemini.
   - Automatic tool-call ID synthesis, malformed JSON repair, text tool-call fallback parsing, exponential backoff with jitter + `Retry-After` (`run.retry` events), wait-for-capacity TPM/RPM pacing, idle-based stream timeouts (`90s`), and `fallbackModels` switching.

3. **Defense-in-Depth Sandbox Runtimes (`packages/core/src/sandbox`, `packages/sandboxd`)**:
   - The `local` runtime runs `oh-sandboxd` in-process on the bound workspace with open network access. File tools enforce path policy, but shell commands run as the server process user and may access paths outside the workspace when SRT is unavailable. Use an OS-enforced runtime for untrusted work; local daemon state is process-local and not shared across server nodes.
   - The server disables host-binary preflight for `srt-local` and `docker`; these runtimes continue tool execution if host enforcement is absent and report `osEnforced: false`. Do not treat that fallback as an isolated runtime.
   - Non-Modal runs default to open egress so workspace commands can reach package registries and development services. Modal retains its configured allowlist because its adapter rejects open egress.
   - `oh-sandboxd` runs inside the sandbox (`srt-local`, `docker`, or `modal`) behind `X-Session-Key` constant-time authentication.
   - When OS enforcement is available, child processes use `srt --settings /oh/policy.json -- <argv>`. The managed daemon still applies filesystem policy checks, output redaction, and process timeout/cancellation; only SRT supplies OS-level isolation. Non-Modal egress defaults to open, while Modal keeps its domain allowlist because open egress is unsupported by its adapter.
   - Secrets never enter the sandbox environment or filesystem; host-side brokered tools (`HostSecretBroker`) and egress header injection rules handle authenticated external actions, while all tool outputs are redacted.

4. **Long-Horizon Context, Loop, and Safety (`packages/core/src/context`, `packages/core/src/agent/loop.ts`, `packages/core/src/security`)**:
   - `LayeredContextManager` maintains a byte-identical prefix, clears old tool outputs after 6 turns (spilling full outputs to `.openharness/outputs/<callId>.txt`), recites todo/feature/budget state every 8 turns, precomputes structured LLM compactions at 85% of trigger, shrinks on overflow (`85% -> 70% -> 50% -> 35%`), performs 5-attempt 80% hard resets if needed, and resets context across feature handoffs in `long_task` mode.
   - `executeLongHorizonTask` orchestrates Initializer (`feature_list.json`, `progress.md`, `init.sh`) and Coding sessions through `Plan -> Build -> Test -> Fix -> Review -> Shadow-Git Checkpoint -> Handoff`, with structural diff detection of test tampering (`detectTestTamperingInDiff`).
   - `StuckDetector` monitors all 7 stuck heuristics, and `RiskPolicyGate` + `HookRunner` enforce sub-command shell risk classification, confirmation policies (`always`, `risky`, `never`), taint tracking for untrusted external content, and deterministic lifecycle hooks.
