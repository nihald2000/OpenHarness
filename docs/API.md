# HTTP API

The Bun server defaults to `http://127.0.0.1:4096`. JSON routes return `{ "error": "..." }` for failures. Request bodies are capped at 1 MB, including chunked bodies.

## Authentication

- If `OPENHARNESS_SERVER_TOKEN` is set, send `Authorization: Bearer <token>` for `/v1/**` routes except `/v1/admin/verify`.
- `/v1/admin/**` routes accept either the configured `OPENHARNESS_ADMIN_TOKEN` in `X-OpenHarness-Admin` or as a bearer token, or the configured `OPENHARNESS_SERVER_TOKEN` as a bearer token. With both tokens unset and OIDC disabled, development mode leaves admin routes open so Settings can be used to configure providers; production remains closed. `/v1/admin/verify` accepts either configured token.
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

When server/admin auth is configured, routes below require one of those bearer tokens. With no auth tokens and OIDC disabled, development mode leaves them open for local setup; production keeps them closed.

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


## Long-Horizon Runs, Checkpoints, Rewind, Fork, and Schedules (Additive API)

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/v1/sessions/:id/prompt` | Supports optional `"async": true` and `"mode": "chat" | "task" | "long_task"`, returning `{ "messageId", "runId" }` immediately. |
| GET | `/v1/runs/:id` | Read durable run state, fine-grained `phase`, iteration count, usage, cost, and latest checkpoint SHA. |
| POST | `/v1/runs/:id/pause` | Pause an active run; keeps the sandbox alive for `conversation_idle_ttl_seconds` before snapshotting. |
| POST | `/v1/runs/:id/resume` | Resume a paused run; pass `{ "extend": true }` to double the iteration/duration/cost budget allotment. |
| POST | `/v1/runs/:id/cancel` | Cancel an active or waiting run. |
| GET | `/v1/sessions/:id/checkpoints` | List automatic and manual shadow-git checkpoints for the session. |
| POST | `/v1/sessions/:id/rewind` | Rewind with `{ "checkpoint": "<sha>", "files": true, "conversation": false }`; restores workspace files only by default, or truncates conversation when `conversation: true`. |
| POST | `/v1/sessions/:id/fork` | Fork a new session sharing history up to `{ "atMessageId" | "checkpoint" }` and restoring the checkpoint. |
| GET, POST | `/v1/schedules` | List or create cron/webhook scheduled tasks (`mode`, `agent`, `prompt`, `concurrency`). |
| GET, PATCH, DELETE | `/v1/schedules/:id` | Read, update, or delete a schedule. |
| POST | `/v1/schedules/:id/trigger` | Trigger a scheduled run (enforces concurrency 1 and workspace locking). |

### Additive SSE Event Types
- `run.phase`: `{ type: "run.phase", sessionId, runId, phase, previousPhase, featureId }`
- `run.retry`: `{ type: "run.retry", sessionId, runId, attempt, delayMs, reason }`
- `run.stuck`: `{ type: "run.stuck", sessionId, runId, detector, count, message, action }`
- `budget.warning`: `{ type: "budget.warning", sessionId, runId, resource, used, limit, ratio }`
- `checkpoint.created`: `{ type: "checkpoint.created", sessionId, runId, checkpoint }`
- `context.hard_reset`: `{ type: "context.hard_reset", sessionId, runId, attempts, tokensBefore, tokensAfter }`
- `sandbox.violation`: `{ type: "sandbox.violation", sessionId, runId, kind, target, detail, timestamp }`
- `sandbox.policy_switched`: `{ type: "sandbox.policy_switched", sessionId, runId, fromPhase: "setup", toPhase: "agent", policy }`
- `process.output`: `{ type: "process.output", sessionId, processId, stream, data }`
- `port.opened`: `{ type: "port.opened", sessionId, port, previewUrl, processId }`


## Authentication, Admin Session Cookie & SSE Replay (`/v1/events`)

- **`POST /v1/admin/session`**: Exchanges `{ "token": "<admin-token>" }` for an `HttpOnly; SameSite=Strict` session cookie (`oh_session`). Returns `403` when no admin token is configured or the token does not match.
- **`GET /v1/admin/session`**: Returns `{ "admin": boolean, "authDisabled": boolean, "user": ... }`.
- **`DELETE /v1/admin/session`**: Clears the `oh_session` cookie.
- **`GET /v1/events?sessionId=<id>&after=<seq>`**: Server-Sent Events stream that replays historical events with `seq > after` (or `Last-Event-ID`), buffers live events during replay, and streams deduplicated live events in strict `seq` order.
