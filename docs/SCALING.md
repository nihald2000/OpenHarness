# Scaling Architecture and Migration Status

OpenHarness separates the stateless HTTP/SSE API layer from durable worker execution and isolated sandbox runtimes (`oh-sandboxd`), while keeping zero-setup local development as the default.

## Architecture Overview

1. **Control Plane (`packages/server`, `packages/core`)**:
   - `OpenHarnessServer` (`packages/server/src/server.ts`) is a thin HTTP/SSE adapter that enqueues jobs to `JobQueue` (`InProcessJobQueue` locally, `PostgresJobQueue` when `DATABASE_URL` is configured) and streams events from `StateStore` (`LocalStateStore` / `PostgresStateStore`) and `EventBus`.
   - `DurableWorker` (`packages/core/src/infra/durable-worker.ts`) claims leased jobs with fencing tokens, executes steps through the `AgentEngine` state machine (`packages/core/src/agent/engine.ts`), persists a `StepCheckpoint` after every model response and tool call, and releases worker slots when a run enters `awaiting_permission` or `paused`.
   - On worker restart, a re-claimed job resumes from the latest `StepCheckpoint`: completed tool calls are never re-executed, and any tool call that was in-flight when the worker died is re-issued only if declared `idempotent: true` (otherwise reported to the model as `interrupted`).

2. **Model-Agnostic Provider Layer (`packages/core/src/provider`)**:
   - Built-in capability profiles (`ModelProfile`) for OpenAI, Anthropic (with explicit prompt-cache breakpoints), Meta Llama API (`max_completion_tokens`, `native-unreliable` tool calling, no `parallel_tool_calls`), Together, Groq, Fireworks, Ollama, vLLM/LiteLLM, Bedrock Converse (`streamingToolCalls: false`), and Gemini.
   - Automatic tool-call ID synthesis, malformed JSON repair, text tool-call fallback parsing, exponential backoff with jitter + `Retry-After` (`run.retry` events), wait-for-capacity TPM/RPM pacing, idle-based stream timeouts (`90s`), and `fallbackModels` switching.

3. **Defense-in-Depth Sandbox Runtimes (`packages/core/src/sandbox`, `packages/sandboxd`)**:
   - `oh-sandboxd` runs inside the sandbox (`srt-local`, `docker`, or `modal`) behind `X-Session-Key` constant-time authentication.
   - Every spawned process is wrapped by `srt --settings /oh/policy.json -- <argv>` and governed by an immutable per-run `CompiledSandboxPolicy`: deny-then-allow reads (`~/.ssh`, `~/.aws`, `~/.config/gcloud` denied), allow-only writes (`/workspace`, `/tmp`, `/memories`), mandatory non-overridable denies (`.git/hooks/**`, `.git/config`, shell rc files, `.env*`, `.mcp.json`, `.vscode/`, `.idea/`, `.openharness/agents|commands|skills`, `/oh/policy.json`), and two-phase network egress (`setup` -> `agent`) blocking private/metadata CIDRs (`169.254.169.254`, RFC1918).
   - Secrets never enter the sandbox environment or filesystem; host-side brokered tools (`HostSecretBroker`) and egress header injection rules handle authenticated external actions, while all tool outputs are redacted.

4. **Long-Horizon Context, Loop, and Safety (`packages/core/src/context`, `packages/core/src/agent/loop.ts`, `packages/core/src/security`)**:
   - `LayeredContextManager` maintains a byte-identical prefix, clears old tool outputs after 6 turns (spilling full outputs to `.openharness/outputs/<callId>.txt`), recites todo/feature/budget state every 8 turns, precomputes structured LLM compactions at 85% of trigger, shrinks on overflow (`85% -> 70% -> 50% -> 35%`), performs 5-attempt 80% hard resets if needed, and resets context across feature handoffs in `long_task` mode.
   - `executeLongHorizonTask` orchestrates Initializer (`feature_list.json`, `progress.md`, `init.sh`) and Coding sessions through `Plan -> Build -> Test -> Fix -> Review -> Shadow-Git Checkpoint -> Handoff`, with structural diff detection of test tampering (`detectTestTamperingInDiff`).
   - `StuckDetector` monitors all 7 stuck heuristics, and `RiskPolicyGate` + `HookRunner` enforce sub-command shell risk classification, confirmation policies (`always`, `risky`, `never`), taint tracking for untrusted external content, and deterministic lifecycle hooks.
