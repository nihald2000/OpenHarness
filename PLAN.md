# Backend & Long-Horizon Agent Harness Implementation Plan

## Phase 1–5 Baseline — Complete
- Bun server entrypoint, JSON-backed session persistence, SDK-compatible base APIs, server/admin auth, and replayable durable SSE event IDs.
- Offline mock and streaming OpenAI-compatible provider adapters.
- Built-in `word_count`, workspace-confined `read_file`, approval-gated `write_file`, once/always/reject policy, cancellation, and interrupted-run recovery.
- Production Modal Sandbox Harness (`modal_image.py`, `mcp_code_bridge.py`, `sandbox_manager.py`, `agent_tools.py`) with VM isolation and Anthropic Code-Mode MCP bridges.

## Long-Horizon Harness Architecture (Phases A–I) — Complete & Verified

### Phase A: Extract the Engine and Make Runs Durable — Complete
- Extracted `AgentEngine` (`packages/core/src/agent/engine.ts`, `phases.ts`, `deps.ts`) out of `packages/server/src/server.ts`.
- Mapped fine-grained `RunPhase` (`planning | building | testing | fixing | reviewing | awaiting_permission | paused | completed | failed | cancelled | stuck`) onto legacy `RunStatus` for API compatibility while emitting `run.phase` SSE events.
- Wired `LocalStateStore` / `PostgresStateStore`, `InProcessJobQueue` / `PostgresJobQueue`, and `DurableWorker` (`packages/core/src/infra/`).
- Added per-step checkpointing (`StepCheckpoint`) after every model turn and every tool call; on worker restart, completed tool calls are never replayed, and in-flight tool calls are re-executed only if declared `idempotent: true` (otherwise reported as `interrupted`).
- Added `async: true` on `POST /v1/sessions/:id/prompt` and added `GET /v1/runs/:id`, `POST /v1/runs/:id/pause|resume|cancel` with sandbox idle TTL hibernation.

### Phase B: Model-Agnostic Provider Layer — Complete
- Added `ModelProfile` capability profiles (`packages/core/src/provider/profiles.ts`) for OpenAI GPT-4.x/5.x, Anthropic Claude (explicit cache breakpoints), Meta Llama API (`max_completion_tokens`, `native-unreliable`, `parallelToolCalls: "unsupported"`), Together, Groq (128K), Fireworks, Ollama, vLLM/LiteLLM, Bedrock Converse (`streamingToolCalls: false`, 8K cap), Gemini, and a conservative fail-closed default (`32K`).
- Added `oh model probe <id>` to empirically measure and persist model profiles.
- Added robust tool-call decoding (`packages/core/src/provider/toolcall.ts`): stable ID synthesis (`call_<runId>_<n>`), JSON argument repair (code fences, trailing commas, single quotes, unescaped newlines, Python `True`/`False`/`None`, double-encoded strings), text fallback parser (Llama pythonic lists `[fn(a=1)]`, `<function=...>`, `<tool_call>`, fenced JSON), and non-fatal schema validation feedback.
- Added error classification, exponential backoff with jitter + `Retry-After` (`run.retry` SSE events), wait-for-capacity TPM/RPM pacing, idle-based stream timeouts (`90s`), and `fallbackModels` switching (`packages/core/src/provider/retry.ts`).

### Phase C: Sandbox Runtimes and In-Sandbox Agent-Server (`oh-sandboxd`) — Complete
- Implemented `SandboxProvider` contract (`packages/core/src/sandbox/contracts.ts`) for `local`, `srt-local`, `docker`, and `modal`.
- Implemented `oh-sandboxd` (`packages/sandboxd/src/server.ts`) with constant-time `X-Session-Key` verification, persistent shell sessions (`/shell/:sid/exec|input|interrupt`), background processes (`/processes`), paged/linter-gated file operations (`view`, `create`, `str_replace` with fuzzy fallback, `insert`, `undo_edit`, `apply_patch`), search (`glob`, `grep`), shadow-git checkpoints (`/checkpoints/create|diff|restore`), port previews (`/ports`), Playwright browser routes (`/browser/*` with `[ref=eN]` accessibility handles), optional `/ipython/exec`, and `srt --settings /oh/policy.json -- <argv>` wrapping + telemetry (`sandbox.violation`, `process.output`, `port.opened`).
- Implemented immutable per-run policy compilation (`packages/core/src/sandbox/policy.ts`) with deny-then-allow reads (`~/.ssh`, `~/.aws`, `~/.config/gcloud`), allow-only writes (`/workspace`, `/tmp`, `/memories`), mandatory non-overridable denies (`.git/hooks/**`, `.git/config`, shell rc files, `.env*`, `.mcp.json`, `.vscode/`, `.idea/`, `.openharness/agents|commands|skills`, `/oh/policy.json`), two-phase network policy (`setup` -> `agent`), mandatory private/metadata CIDR blocking (`169.254.169.254`, RFC1918), and brokered host secrets (`HostSecretBroker`).

### Phase D: Tool Surface for Real Software Work — Complete
- Implemented full sandbox-backed tool catalog (`packages/core/src/tools/catalog.ts`) with policy masking (`masked: true`) to keep tool lists stable across turns for prompt-cache validity.
- Enforced 50 KB / 2,000-line tool output limits (`packages/core/src/tools/output-limit.ts`) with automatic spill files under `.openharness/outputs/<callId>.txt`.

### Phase E: Context Engineering for Multi-Hour Runs — Complete
- Implemented `LayeredContextManager` (`packages/core/src/context/manager.ts`): byte-identical stable prefix, tool-result clearing after 6 turns with pinned items and 3-turn error retention, periodic todo/feature/budget recitation every 8 turns, LLM compaction with 15%/16K reserve and 85% background precomputation, progressive transcript shortening, overflow shrink retries (`85%`, `70%`, `50%`, `35%`), 5-attempt 80% hard reset (`context.hard_reset`), feature handoff context resets, subagent context isolation, and lazy hierarchical `AGENTS.md` loading.

### Phase F: Plan -> Build -> Test -> Fix -> Review Loop — Complete
- Implemented `chat`, `task`, and `long_task` run loop (`packages/core/src/agent/loop.ts`) with verification recipe resolution (config -> `.openharness/verify.json` -> auto-detection), condensed failure signatures (`<= 4 KB`), separate reviewer agent + structural diff test-tampering detector (`detectTestTamperingInDiff`), shadow-git checkpoints, and the `long_task` initializer/coding session protocol (`feature_list.json`, `progress.md`, `init.sh`).

### Phase G: Budgets, Stuck Detection, Safety, and Human-in-the-Loop — Complete
- Implemented mode-aware budgets (`chat`, `task`, `long_task`), 80% `budget.warning` events, graceful `MAX_STEPS_PROMPT` wrap-up on breach, and `extend: true` traffic-control doubling on resume.
- Implemented `StuckDetector` (`packages/core/src/agent/stuck.ts`) with all 7 heuristics and two-stage escalation (warning injection -> `blocked` / `paused`).
- Implemented deterministic sub-command shell parser and risk classifier (`packages/core/src/security/risk.ts`), confirmation policies (`always`, `risky`, `never`), taint tracking for untrusted external content, and deterministic lifecycle hooks (`packages/core/src/security/hooks.ts`).

### Phase H: Delegation, Parallelism, and Scheduling — Complete
- Implemented `DelegationCoordinator` (`packages/core/src/agent/delegate.ts`) with permission intersection, bounded parallel read-only explorers (`maxParallel: 3`), isolated git-worktree parallel writers with conflict detection and post-merge verification, and durable background tasks (`delegate_status` / `delegate_result`).
- Implemented `ScheduleManager` (`packages/core/src/scheduler/index.ts`) with `/v1/schedules` CRUD, concurrency-1 workspace locking, and tainted GitHub issue-to-PR workflows.

### Phase I: Checkpoints, Rewind, and Fork — Complete
- Implemented `SessionCheckpointManager` (`packages/core/src/checkpoints/index.ts`), `POST /v1/sessions/:id/rewind` (`{ checkpoint, files: true, conversation: false }`), `POST /v1/sessions/:id/fork`, `oh session checkpoints|rewind|fork` CLI commands, and the Web UI `CheckpointsPopover` (`src/components/checkpoints-popover.tsx`).
