# OpenHarness

OpenHarness is a model-agnostic, long-horizon AI agent harness and developer workspace. Any configured model (OpenAI, Anthropic, Meta Llama API, Together, Groq, Fireworks, Ollama, vLLM, LiteLLM, AWS Bedrock, Google Gemini, or the offline mock provider) can autonomously **plan → build → test in a sandbox → fix → review → checkpoint** across multi-hour runs and process restarts without exhausting its context window or escaping its sandbox.

## Key Capabilities

- **Durable Resumable Agent Engine (`packages/core/src/agent`, `packages/core/src/infra`)**:
  - Pure state machine (`planning | building | testing | fixing | reviewing | awaiting_permission | paused | completed | failed | cancelled | stuck`) executed by `DurableWorker` over `InProcessJobQueue` or `PostgresJobQueue`.
  - Per-step checkpoints (`StepCheckpoint`) after every model turn and tool call; mid-run restarts resume from the last checkpoint without replaying completed or non-idempotent tool calls or duplicating SSE sequence IDs.
  - Worker slots are released during permission waits and paused runs, with automatic sandbox idle TTL hibernation and snapshot restoration.
- **Model-Agnostic Provider Layer (`packages/core/src/provider`)**:
  - Built-in capability profiles (`ModelProfile`) for OpenAI, Anthropic Claude (explicit prompt caching), Meta Llama API (`max_completion_tokens`, no `parallel_tool_calls`, `native-unreliable` fallback), Together, Groq, Fireworks, Ollama, vLLM/LiteLLM, Bedrock Converse, and Gemini.
  - Synthesizes missing tool-call IDs, repairs malformed JSON arguments, parses text-emitted tool calls (Llama pythonic `[fn(a=1)]`, `<function=...>`, `<tool_call>`), validates against JSON schemas with in-context error recovery, and paces retries with exponential backoff + jitter + `Retry-After`.
- **OS-Enforced Sandboxes & `oh-sandboxd` (`packages/core/src/sandbox`, `packages/sandboxd`)**:
  - Supports `local` (offline demo), `srt-local` (Anthropic Sandbox Runtime), `docker` (hardened containers), and `modal` (cloud microVMs).
  - In-sandbox `oh-sandboxd` daemon provides persistent PTY/shell sessions, background process & port detection, paged and linter-gated file editing (`view`, `create`, `str_replace` with fuzzy fallback, `insert`, `undo_edit`, `apply_patch`), shadow-git checkpoints (`GIT_DIR=/oh/.shadow-git`), and Playwright Chromium automation with `[ref=eN]` accessibility handles.
  - Two-phase sandbox policy (`setup` -> `agent`) enforces deny-then-allow reads (`~/.ssh`, `~/.aws` blocked), allow-only writes (`/workspace`, `/tmp`, `/memories`), mandatory denies (`.git/hooks`, `.env*`, `.openharness/agents|commands|skills`), and private/metadata CIDR blocking (`169.254.169.254`).
- **Layered Context Engineering (`packages/core/src/context`)**:
  - Byte-identical prefix, tool-result clearing after 6 turns with disk spill (`.openharness/outputs/<callId>.txt`), todo/feature recitation every 8 turns, background-precomputed structured LLM compaction, overflow shrink steps (`85% -> 70% -> 50% -> 35%`), 5-attempt 80% hard reset, and feature handoffs.
- **Autonomous Verification, Review, Safety & Checkpoints (`packages/core/src/security`, `packages/core/src/checkpoints`)**:
  - Harness-driven verification recipes, failure signature deduplication, independent reviewer agent + structural diff test-tampering detection, 7-heuristic stuck detector, sub-command shell risk classifier, taint tracking for untrusted external content, parallel read-only subagent explorers, isolated git-worktree writers, `/v1/schedules` CRUD, and separate file vs conversation session rewind/fork (`POST /v1/sessions/:id/rewind`, `POST /v1/sessions/:id/fork`).

## Development & Testing

```bash
# Run all TypeScript acceptance test suites (Phases A through I)
node --loader ./scripts/ts-loader.mjs --test tests/*.test.ts

# Run Python Modal Sandbox unit test suite
python3 -m unittest discover -s tests -v
```
