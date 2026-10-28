# `@openharness/server`

The OpenHarness API server. It runs on Bun and currently provides durable local sessions and messages, the SDK's core session and catalog routes, bearer/admin authentication, a deterministic offline chat provider, replayable SSE events, and permission-gated workspace tools.

## Run locally

From the workspace root:

```bash
bun install
bun run server
```

The server listens on `127.0.0.1:4096` by default. Start the web UI separately with `bun run dev`.

## Environment

| Variable | Default | Description |
| --- | --- | --- |
| `OPENHARNESS_HOST` | `127.0.0.1` | Bind address. |
| `OPENHARNESS_PORT` | `4096` | HTTP port. |
| `OPENHARNESS_DATA_DIR` | `.openharness` | Local directory for persisted state. |
| `OPENHARNESS_WORKSPACE` | current directory | Root for workspace file tools. |
| `OPENHARNESS_SERVER_TOKEN` | unset | Optional bearer token for `/v1/**`; when set, clients must send it. |
| `OPENHARNESS_ADMIN_TOKEN` | unset | Admin token; admin endpoints fail closed until configured. |
| `OPENHARNESS_PROVIDER` | `mock` | `mock` for offline responses or `openai` for the OpenAI-compatible streaming adapter. |
| `OPENHARNESS_MODEL` | provider default | Model identifier sent to the provider. |
| `OPENAI_API_KEY` | unset | Required for `OPENHARNESS_PROVIDER=openai`; never returned by the API. |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | Optional OpenAI-compatible API base URL. |
| `OPENHARNESS_SECRET_KEY` | generated local key | Optional secret-key material; when unset, a 32-byte key is created in `OPENHARNESS_DATA_DIR/secret.key`. Back up this key with the encrypted secret store. |
| `OPENHARNESS_CORS_ORIGINS` | localhost ports 3000 | Comma-separated browser origins allowed by CORS. |

The mock provider is deterministic and echoes regular prompts into a streamed assistant response. Set `OPENHARNESS_PROVIDER=openai` and `OPENAI_API_KEY` to use the OpenAI-compatible streaming adapter. To call a built-in tool, submit `/tool <name> <JSON object>` as the prompt, for example `/tool word_count {"text":"hello OpenHarness"}`. `read_file` is limited to files inside the workspace and to 100 KB. `write_file` is limited to the workspace and waits for explicit approval in the UI; an `always` approval applies only to that tool and relative path. Do not expose the unauthenticated development server to an untrusted network.

The `oh` CLI supports `info`, `sessions`, `tools`, `plugins`, `mcp`, `run`, `eval`, `config`, `secrets`, and `admin token`. MCP presets include a scoped filesystem server and Microsoft's Playwright browser server. Install them explicitly with `oh mcp install filesystem` or `oh mcp install browser`; both require Node.js and npm, and calls remain approval-gated. Run `bun run oh help` for usage. Eval suites are JSON Lines with `prompt` and optional `contains`, `regex`, `tool`, and `maxMs` assertions.

The Modal sandbox plugin is also opt-in. Install the Modal Python SDK in the server's Python environment, set `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, then attach it with `bun run oh plugins attach modal-sandbox`. The `modal_exec` tool requires approval, supports Python only, limits code to 50 KB and execution to 120 seconds, caps returned output, and creates sandboxes with outbound networking blocked. Set `OPENHARNESS_MODAL_PYTHON` if the SDK is installed under a non-default Python executable. Modal's [Python installation and token setup](https://modal.com/docs/guide/getting-started) and [sandbox network controls](https://modal.com/docs/guide/sandbox-networking) are documented by Modal.

## Current API coverage

Implemented: health, server info, agents/models/tools/commands/skills/MCP/runtime/plugin catalogs, sessions, messages, prompt/abort/compact/context, native OpenAI-compatible function tool calls, approval-gated tools, bounded analysis-only delegation, an approval-gated verifier (`typecheck`, server/web build, and diff check), cancellation and run budgets, SSE events, admin-token verification, settings updates, encrypted secret CRUD, an allowlisted built-in plugin lifecycle, and MCP server configuration/connect/reconnect for stdio and HTTP/SSE transports. MCP reconnection uses capped exponential backoff; presets include filesystem and Playwright browser servers. The built-in plugin allowlist includes word-count and the opt-in Modal sandbox tool. Repository `AGENTS.md` context is available only when explicitly enabled with `prompt.includeRepositoryInstructions`; a generic third-party runtime/plugin contribution API and sandboxed TypeScript `run_code` remain future work.
