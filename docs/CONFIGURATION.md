# Configuration and environment

Use `.env.example` as the environment variable template. The server reads JSON settings from `<OPENHARNESS_DATA_DIR>/config.json`; the default directory is `.openharness`. Updates through the admin API are persisted atomically. Credentials placed in secret-like settings fields are extracted into the encrypted secret store and represented in settings by `{secret:NAME}` references.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENHARNESS_HOST` | `127.0.0.1` | Server bind host. |
| `OPENHARNESS_PORT` | `4096` | Server port. |
| `OPENHARNESS_URL` | `http://127.0.0.1:4096` | CLI server URL. |
| `OPENHARNESS_DATA_DIR` | `.openharness` | Persistent settings, sessions, events, MCP state, and secrets directory. |
| `OPENHARNESS_WORKSPACE` | Current directory | Workspace root for repository tools and context discovery. |
| `OPENHARNESS_SERVER_TOKEN` | Unset | Optional bearer token required for `/v1/**`. |
| `OPENHARNESS_ADMIN_TOKEN` | Unset | Optional separate admin token for `/v1/admin/**`. The server token also authorizes admin routes; with both tokens unset and OIDC disabled, development mode opens admin routes for initial Settings setup while production remains closed. |
| `DATABASE_URL` | Unset | Postgres connection for OIDC tenant/user provisioning. Run `bun run oh migrate` with `OPENHARNESS_DATABASE_URL` configured before enabling OIDC. |
| `REDIS_URL` | Unset | Optional shared backend for API/provider token buckets and expiring run quota leases. |
| `OIDC_ISSUER` / `OIDC_AUDIENCE` | Unset | Enable bearer JWT verification and tenant identity provisioning. |
| `OIDC_TENANT_CLAIM` | `tid` | JWT claim mapped to the tenant slug. |
| `OIDC_ROLE_CLAIM` / `OIDC_ADMIN_VALUES` | `role` / `admin` | Trusted role claim and comma-separated values that provision tenant admins. Existing database roles remain authoritative. |
| `OIDC_ALLOWED_TENANTS` | Unset | Optional comma-separated tenant allowlist. |
| `OPENHARNESS_SERVICE_TENANT_ID` | Unset | UUID tenant used by service and break-glass tokens when OIDC is enabled. |
| `API_RPM` / `API_BURST` | `1800` / `60` | Per-identity API token-bucket refill rate per minute and burst capacity. |
| `PROMPT_RPM` / `PROMPT_BURST` | `10` / `5` | Per-identity prompt/compaction refill rate per minute and burst capacity. |
| `ADMIN_RPM` / `ADMIN_BURST` | `300` / `5` | Per-tenant admin API refill rate per minute and burst capacity. |
| `PROMPT_MAX_BYTES` | `262144` | Maximum UTF-8 prompt body size. |
| `QUEUE_HIGH_WATERMARK` | `2000` | Local queue depth threshold for prompt admission. |
| `QUEUE_MAX_AGE_MS` | `60000` | Oldest queued job age allowed per tenant before prompt admission returns 503 with `Retry-After`. |
| `USER_MAX_RUNS` / `TENANT_MAX_RUNS` | `3` / `4` | Concurrent run-slot limits. Redis leases are shared when `REDIS_URL` is set. |
| `TENANT_MONTHLY_BUDGET_USD` | Unset | Optional monthly USD ceiling for OIDC tenants with usage recorded in Postgres. |
| `TENANT_PLAN_BUDGETS_USD` | Unset | Optional JSON map of tenant plan names to monthly USD ceilings, for example `{"free":5,"pro":100}`. A matching plan value overrides `TENANT_MONTHLY_BUDGET_USD`. |
| `PROVIDER_RPM` | Unset | Optional per-tenant, provider/model request limit per minute. Uses Redis when `REDIS_URL` is configured. |
| `PROVIDER_TPM` | Unset | Optional per-tenant, provider/model estimated token limit per minute. Admission reserves estimated prompt tokens plus the output-token maximum. |
| `SSE_MAX_BUFFER` / `SSE_MAX_PER_USER` | `1000` / `10` | Bounded queued SSE envelopes and per-user stream limit. |
| `OPENHARNESS_SECRET_KEY` | Generated local key | Optional secret-store encryption key material; set a stable high-entropy value for portable deployments. |
| `OPENHARNESS_PROVIDER` | `mock` | Provider selection; `mock` supports offline use. |
| `OPENHARNESS_MODEL` | `mock/demo` | Default model ID. |
| `OPENAI_API_KEY` | Unset | OpenAI-compatible API credential when provider configuration uses this environment value. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible provider endpoint. |
| `OPENHARNESS_CONFIG_DIR` | Platform config directory | Global discovery root for agents, skills, and commands. |
| `OPENHARNESS_CORS_ORIGINS` | Local web origins | Comma-separated allowed browser origins. |
| `OPENHARNESS_WEB_PORT` | `3000` | Web app port. |
| `OPENHARNESS_WEB_SESSION_SECRET` | Unset | Web session signing secret. |
| `OPENHARNESS_WEB_URL` | Local request origin in development | Public web origin used to construct fixed OAuth callback URLs. Required in production; use HTTPS. |
| `OPENHARNESS_AUTH_DATA_DIR` | `OPENHARNESS_DATA_DIR` or `.openharness-auth` | Persistent directory for linked web account profiles. |
| `OPENHARNESS_AUTH_ALLOWED_EMAILS` | Empty | Comma-separated verified email invite list; when present it restricts signup. |
| `OPENHARNESS_AUTH_ALLOW_SIGNUP` | `false` | Enables automatic Google/GitHub account creation when no email allowlist is set. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Unset | Google OAuth web client credentials. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | Unset | GitHub OAuth app credentials. |
| `MODAL_TOKEN_ID` | Unset | Modal credential required by the opt-in Modal sandbox plugin. |
| `MODAL_TOKEN_SECRET` | Unset | Modal credential required by the opt-in Modal sandbox plugin. |
| `MODAL_APP_NAME` | `openharness` | Modal app name for isolated Python sandboxes. |
| `OPENHARNESS_MODAL_PYTHON` | `python` on Windows, `python3` elsewhere | Local Python interpreter used to launch the Modal SDK runner. |

## Settings sections

The settings endpoint accepts JSON objects for `model`, `smallModel`, `defaultAgent`, `defaultRuntime`, `providers`, `mcp`, `plugins`, `codeMode`, `permissions`, `limits`, `compaction`, `verify`, `guardrails`, `advanced`, `agents`, `skills`, `commands`, `prompt`, and `hooks`.

- `limits` bounds concurrent runs, duration, context, per-turn tokens, tool output, iterations, delegation depth, subagents, and optionally `maxCostPerRun` / `maxCostPerSession`. Cost limits require both model pricing fields and cap each provider request using its token limit.
- `compaction.enabled`, `compaction.triggerTokens`, and `compaction.keepRecentMessages` control automatic history compaction. The default threshold is 80% of `maxSessionContextTokens` (102,400 tokens at the default context limit), with four recent messages retained.
- `prompt.includeRepositoryInstructions` defaults to `false`. Set it to `true` only when sending repository `AGENTS.md` context to the configured provider is intended. When enabled, `prompt.instructionPaths` accepts workspace-relative files and `prompt.instructionGlobs` currently accepts the bounded `**/AGENTS.md` pattern.
- `skills.paths` accepts workspace-relative directories containing skill subdirectories with `SKILL.md`. Absolute paths and paths escaping the workspace are ignored. Built-in global and workspace skill roots are also searched.
- Agent, skill, and command Markdown frontmatter supports nested mappings/lists, common scalar types, and inline lists. Malformed metadata, duplicate keys, and YAML features outside this bounded subset (such as anchors and aliases) cause the resource to be skipped.
- `verify.maxIterations` caps verifier calls. The verifier accepts only fixed check names; checks may run repository scripts and require permission. `verify.auto: true` asks the agent to run configured entries whose `name` is one of `typecheck`, `server-build`, `web-build`, or `diff-check`. Prompt requests may select those names, or their matching configured command strings; unsupported commands are rejected. Failed checks are returned to the agent so it can attempt a fix within the same call limit, with progress sent as `fix.status` events.
- `providers` configures OpenAI-compatible models and base URLs. Model entries may specify non-negative `inputCostPerMillion` and `outputCostPerMillion` values; these are used for cost reporting and required when a hard cost limit is set. Keep credentials in environment or secret references rather than plain JSON.
- `codeMode` is persisted for SDK/UI compatibility; the general TypeScript `run_code` sandbox is not implemented yet.

See [the JSON schema](config.schema.json) and [API route reference](API.md) for the current contract.

Server errors are emitted as JSON records. Secret-like fields and common bearer/API key strings are redacted before output; logs avoid request bodies, prompts, and full provider payloads.


## Long-Horizon Environment Variables & CLI Commands

- `LLAMA_API_KEY`: API key for Meta Llama API (`https://api.llama.com/compat/v1`).
- `GROQ_API_KEY`, `TOGETHER_API_KEY`, `FIREWORKS_API_KEY`, `ANTHROPIC_API_KEY`: Provider API credentials.
- `oh model probe <id> [--json]`: Empirically probes a model for tool calling, `max_completion_tokens`, streaming tool calls, and usage reporting, and stores the measured `ModelProfile`.
- `oh session checkpoints <session-id> [--json]`: Lists shadow-git checkpoints for a session.
- `oh session rewind <session-id> --checkpoint <sha> [--files] [--conversation] [--json]`: Rewinds workspace files (and optionally conversation transcript) to a checkpoint.
- `oh session fork <session-id> [--checkpoint <sha>] [--at-message <msg-id>] [--json]`: Forks a session from a message or checkpoint.


## Long-Horizon `openharness.json` Settings Reference (§14)

Unknown keys in `openharness.json` or `/v1/admin/settings` are rejected fail-closed (`validateOpenHarnessConfig` & `docs/config.schema.json`).

- `mode.default`: `"chat" | "task" | "long_task"` (default `"chat"`).
- `providers.<id>`: `{ wire, baseUrl, apiKey, models }` — e.g. `llama` (`wire: "openai-chat"`, `baseUrl: "https://api.llama.com/compat/v1"`, `apiKey: "{secret:LLAMA_API_KEY}"`).
- `agents.<name>`: `{ model, tools, description }` — e.g. `reviewer` (`model: "openai/gpt-5"`, `tools: ["read_file", "search", "glob", "list"]`).
- `sandbox`:
  - `default`: `"local" | "srt-local" | "docker" | "modal"`
  - `allowUnsandboxedAutonomy`: `boolean` (default `false`; refuses autonomous runs on `local` when `false`).
  - `docker`: `{ image, cpus, memoryMb, diskMb }`
  - `modal`: `{ app, runtime: "vm", idleTtlSec }`
  - `filesystem`: `{ extraAllowWrite: string[], extraDenyRead: string[] }`
  - `network`: `{ setupPresets: string[], agentPresets: string[], allowedDomains: string[], methods: string[] }`
  - `pauseIdleTtlSec`: Idle seconds before a paused sandbox is snapshotted and released (default `900`).
- `limits`: Mode-scoped budget overrides (`chat`, `task`, `long_task.maxCostPerTask`).
- `context`: `{ clearAfterTurns: 6, recitationEveryTurns: 8, keepRecentTokens: 20000, handoffAtRatio: 0.6, precompute: true }`.
- `verify`: `{ commands: string[], maxIterations: 6, noProgressLimit: 2, e2e: object[] }`.
- `confirmation`: `{ policy: "always" | "risky" | "never", unattended: { onConfirm: "deny" | "pause" } }`.
- `stuckDetection`: `{ actionObservation: 4, actionError: 3, monologue: 3, alternating: 6, malformed: 5 }`.
- `schedules`: Array of cron/webhook schedule definitions.

See also [Sandbox Architecture](SANDBOX.md) and [Long-Horizon Tasks Guide](LONG_TASKS.md).
