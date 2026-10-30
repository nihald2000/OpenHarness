# OpenHarness Long-Horizon Tasks Guide (`docs/LONG_TASKS.md`)

OpenHarness supports multi-hour, multi-session software engineering workflows (`long_task` and `task` modes) that survive context window limits, provider rate limits, and server restarts.

## 1. Run Modes (`chat`, `task`, `long_task`)

- **`chat`**: Interactive conversational mode with tool support (`maxIterations: 25`, `maxRunDurationSec: 600`).
- **`task`**: Bounded single-objective engineering loop (`Plan -> Build -> Test -> Fix -> Review -> Checkpoint`, `maxIterations: 150`, `maxRunDurationSec: 3,600`).
- **`long_task`**: Multi-feature autonomous engineering protocol (`500` iterations per session, `5,000` per task, `28,800s` wall clock, required cost cap). Requires a sandboxed runtime (`srt-local`, `docker`, or `modal`).

## 2. The `Plan -> Build -> Test -> Fix -> Review -> Checkpoint` Loop

1. **Plan**: The `plan` agent explores with read-only tools (`masked: true` on mutating tools so prompt caches stay warm) and publishes a structured plan, acceptance criteria, and verification recipe.
2. **Build**: The coding agent implements one step or feature at a time, tracking sub-steps via `todo_write`.
3. **Test**: The harness executes the verification recipe inside the sandbox (resolved from `verify.commands` -> `.openharness/verify.json` -> auto-detected `package.json` / `pytest` / `go test` / `cargo test` / `mvn test` / `Makefile`).
4. **Fix**: On failure, the harness condenses errors (`<= 4 KB`), computes a normalized failure signature, and feeds it to the agent. The fix loop stops when checks pass, `verify.maxIterations` (default 6) is reached, or the same failure signature repeats `verify.noProgressLimit` (default 2) times.
5. **Review**: A separate reviewer agent (fresh context) and the structural diff analyzer (`detectTestTamperingInDiff`) inspect the diff from the last checkpoint for test tampering (deleted or `.skip`ped tests, tautological assertions like `expect(true).toBe(true)`, or edits to `.openharness/verify.json` / `.github/workflows/**`).
6. **Checkpoint**: On pass, the harness commits a shadow-git checkpoint (`checkpoint.created`) and marks the feature `passing`.

## 3. Initializer & Coding Sessions Protocol (`long_task`)

- **Initializer Session**: Explores the repository and writes under `.openharness/task/<taskId>/`:
  - `feature_list.json`: Immutable list of `{ id, title, description, acceptance, verification, status, attempts, lastCheckpoint }`. The model may only flip a feature to `in_progress`; deleting features, editing acceptance/verification criteria, or setting `passing` directly is rejected by the harness.
  - `progress.md`: Append-only cross-session log.
  - `init.sh`: Idempotent setup and environment smoke test.
- **Coding Sessions**: Each feature runs in a clean context seeded by the startup ritual (`pwd`, `progress.md` tail, shadow `git log -n 20`, `init.sh` smoke test). Upon feature completion (or when `context.handoffAtRatio` = 0.6 is reached at a feature boundary), the agent writes a handoff brief and starts a fresh context.

## 4. Layered Context Engineering (`packages/core/src/context/`)

1. **Stable Prefix**: Deterministic JSON key ordering and byte-identical system prompts across turns, with explicit Anthropic cache breakpoints.
2. **Tool-Result Clearing**: Clears unpinned tool outputs older than `context.clearAfterTurns` (default 6) while spilling full outputs to `.openharness/outputs/<callId>.txt` and pinning skills, latest verification results, `feature_list`, `todo_write`, and errors from the last 3 turns.
3. **Recitation**: Appends current feature, todo list, remaining budgets, and next move every `context.recitationEveryTurns` (default 8) steps and after every compaction.
4. **Precomputed LLM Compaction & Overflow Shrink**: Precomputes structured summaries at 85% of the trigger threshold (`contextWindow - max(16000, 15%)`), progressively shortens older exchanges, shrinks on `context_overflow` (`85% -> 70% -> 50% -> 35%`), and falls back to a 5-attempt 80% `context.hard_reset` if needed.

## 5. CLI Usage

```bash
# Start a long_task run in a Docker sandbox with a $20 budget
oh run --mode long_task --sandbox docker --budget-usd 20 "Build full-stack analytics dashboard"

# List active and completed runs
oh runs

# Pause, resume, or extend a run's budget allotment (2x traffic-control doubling)
oh run pause <run-id>
oh run resume <run-id>
oh run extend <run-id>

# Inspect checkpoints, rewind files, or fork a session
oh session checkpoints <session-id>
oh session rewind <session-id> --checkpoint <sha>
oh session fork <session-id> --checkpoint <sha>
```
