# HTTP API

The Bun server defaults to `http://127.0.0.1:4096`. JSON routes return `{ "error": "..." }` for failures. Request bodies are capped at 1 MB, including chunked bodies.

## Authentication

- If `OPENHARNESS_SERVER_TOKEN` is set, send `Authorization: Bearer <token>` for `/v1/**` routes except `/v1/admin/verify`.
- Every `/v1/admin/**` route requires the separate `OPENHARNESS_ADMIN_TOKEN`, sent as `X-OpenHarness-Admin: <token>` or as a bearer token. `/v1/admin/verify` accepts the admin token as a bearer token.
- CORS origins are controlled by `OPENHARNESS_CORS_ORIGINS`. The server sets `x-request-id`, `x-content-type-options`, and `referrer-policy` response headers.

## Health and catalogs

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness and server version. |
| GET | `/v1/info` | Workspace and effective defaults. |
| GET | `/v1/agents` | Built-in, discovered, and configured agent catalog. |
| GET | `/v1/models` | Configured model catalog. |
| GET | `/v1/commands` | Discovered slash command metadata. |
| GET | `/v1/skills` | Discovered skill metadata. |
| GET | `/v1/tools` | Enabled built-in and connected MCP tools. |
| GET | `/v1/mcp` | Public MCP connection status and counts. |
| GET | `/v1/plugins` | Plugin status. |
| GET | `/v1/runtimes` | Runtime catalog (currently local Bun only). |

## Sessions and events

| Method | Route | Purpose |
| --- | --- | --- |
| GET, POST | `/v1/sessions` | List sessions or create one. Creation accepts optional `agent`, `model`, and `runtime`. |
| GET, PATCH, DELETE | `/v1/sessions/:id` | Read, update title/agent/model/runtime, or delete a session. |
| GET | `/v1/sessions/:id/messages` | Read the message transcript and latest event sequence. |
| POST | `/v1/sessions/:id/prompt` | Start a prompt with `{ "text": "...", "fix": { "commands": ["typecheck"] } }`; `fix` is optional and accepts up to four fixed verification names (or matching configured command strings). Returns HTTP 202 with the user `messageId`. |
| POST | `/v1/sessions/:id/abort` | Abort the active run. |
| POST | `/v1/sessions/:id/compact` | Summarize older messages and retain recent messages and active tool calls. |
| GET | `/v1/sessions/:id/context` | Return an approximate context-use estimate. |
| GET | `/v1/events` | Authenticated SSE stream; accepts `Last-Event-ID` or `?after=` and optional `?sessionId=`. |

SSE frames use monotonically increasing `id` values and JSON `data`. The server replays retained events after the requested sequence, then sends live updates and periodic comment heartbeats. Event retention is bounded; clients should refresh session/message state if they resume from an ID older than retention.

## Permissions

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/v1/permissions?sessionId=:id` | List pending requests, optionally filtered by session. |
| POST | `/v1/permissions/:requestId/reply` | Reply with `{ "reply": "once" | "always" | "reject" }`. |

Tool permissions are enforced by the server. An `always` grant is scoped to the tool and the request pattern. Expired, rejected, or aborted requests do not run the tool.

## Administration

All routes below require admin authentication.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/admin/verify` | Validate the admin bearer token. |
| POST | `/v1/admin/reload` | Stop active runs, reset ephemeral plugin state, and reconnect configured MCP servers. |
| GET | `/v1/admin/settings` | Read stored and effective settings. |
| PUT | `/v1/admin/settings/:section` | Save `{ "value": object-or-null, "force": boolean? }`; force stops active runs. |
| GET | `/v1/admin/secrets` | List secret names and update timestamps, never values. |
| PUT, DELETE | `/v1/admin/secrets/:name` | Set `{ "value": "..." }` or delete a secret. |
| GET | `/v1/admin/mcp` | Read configured MCP server details with secret references masked. |
| GET | `/v1/admin/mcp/presets` | List MCP presets. |
| POST | `/v1/admin/mcp/presets/:preset/install` | Install a preset, optionally with a name or workspace root. |
| PUT, DELETE | `/v1/admin/mcp/:name` | Create/update or delete an MCP server. |
| POST | `/v1/admin/mcp/:name/enable` | Set `{ "enabled": true | false }`. |
| POST | `/v1/admin/mcp/:name/reconnect` | Reconnect one MCP server. |

Plugins use `POST /v1/plugins` to attach an allowlisted plugin and `DELETE /v1/plugins/:name` to detach it. `PUT /v1/runtimes/default` selects the only currently supported runtime, `local`.
