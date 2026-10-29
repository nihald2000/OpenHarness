# `@openharness/web`

Production chat and administrator settings UI for the OpenHarness agent server, built with Next.js 16 (App Router), React 19, Tailwind CSS v4, and `@openharness/sdk`.

## Features

- **Streaming Agent Chat**: Real-time SSE token and part streaming with `requestAnimationFrame` batching, automatic reconnection, and sequence resumption (`after: lastSeq`).
- **Interactive Parts**: Rich rendering for tool executions (with diffs, code blocks, call chips, and output previews), plans (`PlanCard`, `PlanDock`, and `Approve & build` workflow), delegated subagent tasks (with inline expandable transcripts), context compactions, reasoning traces, and verification loops (`VerifyCard`).
- **Tool Approvals**: Keyboard-accessible `alertdialog` permission prompts supporting `Allow once`, `Always`, and `Reject`.
- **Capabilities Drawer**: Inspect and manage plugins, execution runtimes, skills, agents, tools, MCP servers, and slash commands live.
- **Administrator Settings (`/settings`)**: Live configuration management across General defaults, Models & providers, MCP servers (custom + one-click presets), Plugins & runtimes, Tools & Code Mode, Permissions, Limits & context, Guardrails, encrypted Secrets, and Advanced maintenance.

## Architecture

The browser never communicates with the OpenHarness server directly. All requests and SSE streams flow through the Next.js same-origin proxy:

```text
Browser (React 19 UI)
  │
  ▼
@openharness/sdk (OpenHarnessClient({ baseUrl: "/api/oh" }))
  │
  ▼
Next.js Route Handler (app/api/oh/[...path]/route.ts)
  ├── Verifies same-origin on mutating / admin requests
  ├── Injects Authorization: Bearer <OPENHARNESS_SERVER_TOKEN>
  └── Decrypts httpOnly oh_admin cookie -> injects x-openharness-admin
  │
  ▼
OpenHarness Server (OPENHARNESS_URL, default http://127.0.0.1:4096)
```

## Folder Overview

```text
apps/web/
  app/
    api/auth/[provider]/route.ts          # OAuth start and PKCE/state cookie
    api/auth/[provider]/callback/route.ts # Verified provider callback and account signup
    api/auth/providers/route.ts           # Configured provider/signup status
    api/oh/[...path]/route.ts   # Same-origin proxy to /health and /v1/**
    api/admin/login/route.ts    # Rate-limited admin token verification & cookie sealing
    api/admin/logout/route.ts   # Clears the oh_admin session cookie
    api/admin/session/route.ts  # Checks whether a valid admin cookie is present
    login/page.tsx              # Google/GitHub sign-in and account creation
    c/[id]/page.tsx             # Session chat route
    settings/page.tsx           # Admin settings route
    globals.css                 # Tailwind v4 theme tokens & markdown typography
    layout.tsx                  # Root layout with no-flash theme script & AppShell
    page.tsx                    # New chat route
  components/
    parts/                      # ToolCard, PlanCard, TaskCard, VerifyCard, CompactionDivider, etc.
    settings/                   # Admin settings sections & shared form controls
    ...                         # AppShell, Sidebar, ChatView, ChatHeader, Composer, Transcript, etc.
  lib/
    admin-session.ts            # Server-only AES-256-GCM session cookie & rate-limiter
    oauth.ts                    # OAuth/PKCE, provider identity validation, and account store
    app-context.tsx             # Global catalog, sessions, permissions, theme, and toast state
    client.ts                   # Singleton OpenHarnessClient instance
    format.ts                   # Token, cost, duration, and relative time formatters
    hooks.ts                    # useSessions, useCatalog, usePermissions, useTools
    pending-prompts.ts          # Hand-off store for new session initial prompts
    use-admin.ts                # External store for admin authentication state
    use-session.ts              # Per-session message state & rAF-batched SSE subscription
```

## Running

1. Install dependencies from the monorepo root:

   ```bash
   bun install
   ```

2. Start the OpenHarness backend server:

   ```bash
   bun packages/server/src/main.ts
   ```

3. Start the web UI in development mode (in `apps/web`):

   ```bash
   cd apps/web
   bun run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

4. Production build and standalone server:

   ```bash
   cd apps/web
   bun run typecheck
   bun run build
   bun run start
   # Or run the standalone build directly:
   bun .next/standalone/apps/web/server.js
   ```

## Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `OPENHARNESS_URL` | `http://127.0.0.1:4096` | Upstream URL of the OpenHarness server (server-side only). |
| `OPENHARNESS_SERVER_TOKEN` | *(empty)* | Optional bearer token injected by the Next.js proxy on upstream requests. |
| `OPENHARNESS_WEB_SESSION_SECRET` | *(random per process)* | Secret used to derive the AES-256-GCM key for the `oh_admin` session cookie. Set a stable secret in production. |
| `OPENHARNESS_WEB_AUTH_DISABLED` | `false` | Skips the sign-in screen and proxy admin gate for temporary demos. Do not enable on a public deployment. |
| `OPENHARNESS_WEB_URL` | Local request origin in development | Public origin used to build the fixed OAuth callback URLs. |
| `OPENHARNESS_ADMIN_TOKEN` | *(empty)* | Server administrator token; must match the API server token. |
| `OPENHARNESS_AUTH_DATA_DIR` | `OPENHARNESS_DATA_DIR` or `.openharness-auth` | Persistent web account profile directory. |
| `OPENHARNESS_AUTH_ALLOWED_EMAILS` | *(empty)* | Comma-separated verified email allowlist for signup. |
| `OPENHARNESS_AUTH_ALLOW_SIGNUP` | `false` | Allows signup when no email allowlist is configured. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | *(empty)* | Google OAuth web application credentials. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | *(empty)* | GitHub OAuth app credentials. |

## Web Sign-In and Administrator Recovery

1. Generate or view the administrator token on the server:

   ```bash
   bun run oh admin token
   ```

2. Configure Google/GitHub OAuth callback URLs at `/api/auth/google/callback` and `/api/auth/github/callback`, then set the client credentials, `OPENHARNESS_WEB_URL`, and signup policy.
3. Navigate to `/login`. First OAuth signup requires a verified primary email and is stored in `web-users.json`; login for an unknown account does not auto-create it.
4. `POST /api/admin/login` remains available as a recovery path. It verifies the token against `POST /v1/admin/verify` and seals it in an AES-256-GCM encrypted `httpOnly` cookie valid for 8 hours.

## Security Notes

- **Strict Proxy Allowlist**: `/api/oh/[...path]` only forwards `/health` and `/v1/**`, rejecting path traversal segments.
- **CSRF & Header Stripping**: Mutating proxy requests and requests carrying an admin session require a valid same-origin header (`Origin` / `Sec-Fetch-Site`). Client-supplied `x-openharness-admin` headers are never forwarded.
- **Encrypted HttpOnly Cookie**: The admin token is sealed with AES-256-GCM (AAD `oh_admin_v1`) and is never readable by client JavaScript or stored in `localStorage`.
- **OAuth Flow**: Provider callbacks use state and PKCE; Google identity tokens are signature/claim checked. The proxy denies `/v1/**` without a valid login cookie. See [Authentication](../../docs/AUTHENTICATION.md) for signup policy and the current single-workspace authorization model.
- **Safe Markdown & Secret Handling**: Raw HTML and remote images are disabled in Markdown rendering, external links enforce `noopener noreferrer nofollow`, secrets are write-only, and web-submitted plugin options reject `{"@Env":...}` / `{env:...}` / `{file:...}` secret interpolation tokens.
