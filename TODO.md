# OpenHarness backend & long-horizon harness completion checklist

## Long-Horizon Agent Harness (Phases A–I)

- [x] **Phase A — Extract the engine and make runs durable**:
  - [x] Extract `AgentEngine` (`packages/core/src/agent/engine.ts`, `phases.ts`, `deps.ts`) out of `server.ts`.
  - [x] Migrate mutable store and global SSE sequence onto `StateStore` (`packages/core/src/infra/state-store.ts`).
  - [x] Route every prompt through `InProcessJobQueue` / `PostgresJobQueue` and `DurableWorker` with per-step checkpoints (`StepCheckpoint`).
  - [x] Ensure interrupted non-idempotent tool calls are marked `interrupted` and never re-executed on restart, while idempotent calls resume cleanly.
  - [x] Release worker slots while waiting for permission approval and resume via durable permission store.
  - [x] Add `async: true` to `POST /v1/sessions/:id/prompt` and add `GET /v1/runs/:id`, `POST /v1/runs/:id/pause|resume|cancel`.
- [x] **Phase B — Model-agnostic provider layer**:
  - [x] Add `ModelProfile` capability profiles (`packages/core/src/provider/profiles.ts`) for OpenAI, Anthropic, Meta Llama API (`max_completion_tokens`, no `parallel_tool_calls`), Together, Groq, Fireworks, Ollama, vLLM/LiteLLM, Bedrock Converse, Gemini, and conservative default.
  - [x] Add `oh model probe <id>` CLI command and empirical capability probe.
  - [x] Implement robust tool-call decoding (`packages/core/src/provider/toolcall.ts`): stable ID synthesis, JSON repair, text fallback parser (Llama pythonic lists, `<function=...>`, `<tool_call>`), and schema validation feedback.
  - [x] Implement error classification, exponential backoff + jitter + `Retry-After` (`run.retry` SSE events), wait-for-capacity TPM/RPM pacing, idle-based stream timeout, and `fallbackModels`.
- [x] **Phase C — Sandbox runtimes and in-sandbox agent-server (`oh-sandboxd`)**:
  - [x] Implement `SandboxProvider` contracts (`local`, `srt-local`, `docker`, `modal`) in `packages/core/src/sandbox/`.
  - [x] Implement `oh-sandboxd` (`packages/sandboxd/src/server.ts`) with constant-time `X-Session-Key` verification, persistent shell sessions, background processes, paged/linter-gated file ops, search, shadow-git checkpoints, ports/preview, Playwright browser automation, optional IPython, and `srt --settings /oh/policy.json -- <argv>` wrapping.
  - [x] Implement immutable policy compilation (`packages/core/src/sandbox/policy.ts`) with deny-then-allow reads (`~/.ssh`, `~/.aws`, `~/.config/gcloud`), allow-only writes (`/workspace`, `/tmp`, `/memories`), mandatory non-overridable denies (`.git/hooks/**`, `.git/config`, shell rc files, `.env*`, `.mcp.json`, `.vscode/`, `.idea/`, `.openharness/agents|commands|skills`, `/oh/policy.json`), two-phase network policy, private/metadata CIDR blocking (`169.254.169.254`), and brokered secrets.
- [x] **Phase D — Tool surface for real software work**:
  - [x] Implement full sandbox-backed tool catalog (`packages/core/src/tools/catalog.ts`) with policy masking (`mask, don't remove`).
  - [x] Enforce 50 KB / 2,000-line tool output limits with spill files under `.openharness/outputs/<callId>.txt`.
- [x] **Phase E — Context engineering for multi-hour runs**:
  - [x] Implement `LayeredContextManager` (`packages/core/src/context/manager.ts`) with stable prefix, tool-result clearing after 6 turns, pinned items, periodic recitation every 8 turns, LLM compaction with 85% background precomputation, progressive transcript shortening, overflow shrink retries (`85%`, `70%`, `50%`, `35%`), 5-attempt 80% hard reset (`context.hard_reset`), feature handoff resets, and lazy hierarchical `AGENTS.md` loading.
- [x] **Phase F — Plan -> Build -> Test -> Fix -> Review loop**:
  - [x] Implement `chat`, `task`, and `long_task` run loop (`packages/core/src/agent/loop.ts`).
  - [x] Implement verification recipe resolution, condensed failure signatures, separate reviewer agent + structural diff test-tampering detection, shadow-git checkpoints, and the `long_task` initializer/coding protocol (`feature_list.json`, `progress.md`, `init.sh`).
- [x] **Phase G — Budgets, stuck detection, safety, and human-in-the-loop**:
  - [x] Implement mode-aware budgets, 80% `budget.warning` events, graceful `MAX_STEPS_PROMPT` wrap-up on breach, and `extend: true` doubling on resume.
  - [x] Implement `StuckDetector` (`packages/core/src/agent/stuck.ts`) covering all 7 stuck heuristics.
  - [x] Implement deterministic shell sub-command parser and risk classifier (`packages/core/src/security/risk.ts`), confirmation policies (`always`, `risky`, `never`), taint tracking for untrusted external content, and deterministic lifecycle hooks (`packages/core/src/security/hooks.ts`).
- [x] **Phase H — Delegation, parallelism, scheduling**:
  - [x] Extend `delegate` with permission intersection, bounded parallel read-only explorers (`maxParallel: 3`), isolated git-worktree parallel writers with conflict detection and merge verification, and durable background tasks (`delegate_status` / `delegate_result`).
  - [x] Implement `/v1/schedules` CRUD, concurrency-1 workspace locking, and tainted GitHub issue-to-PR workflow.
- [x] **Phase I — Checkpoints, rewind, and fork**:
  - [x] Implement automatic shadow-git checkpoints, `POST /v1/sessions/:id/rewind`, `POST /v1/sessions/:id/fork`, `oh session checkpoints|rewind|fork` CLI commands, and Web UI `CheckpointsPopover`.

## Distributed scaling checklist

- [x] Add shared infrastructure contracts and route live SSE fan-out through `InProcessEventBus`.
- [x] Migrate the API's legacy mutable `Store` and global SSE event sequence onto `StateStore` without changing local SSE IDs or persistence compatibility.
- [x] Checkpoint each agent step (`StepCheckpoint`) and resume from those checkpoints after worker/process interruption.
- [x] Expose a worker process (`DurableWorker`) with a concrete run handler and resumable run step machine (`AgentEngine`).
- [x] Wire durable permissions into the session runner/API, free worker slots while waiting (`moveToWaiting`), and enforce restart replay rules for idempotent vs non-idempotent in-flight tool calls.
- [x] Add remote/isolated sandboxes (`srt-local`, `docker`, `modal`, `oh-sandboxd`).
