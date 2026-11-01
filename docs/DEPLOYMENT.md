# Build and deployment

## Local development

Run `bun install`, then run `bun run server` and `bun run dev` in separate terminals. The server defaults to `127.0.0.1:4096`, stores sessions and encrypted secrets under `.openharness/`, and uses the offline mock provider. Configure `OPENHARNESS_ADMIN_TOKEN` for both server and web processes before signing in. The web app requires a login for all `/v1/**` requests; use the admin token recovery option or configure Google/GitHub OAuth. New OAuth signup is invite-only by default. See [Authentication](AUTHENTICATION.md) for provider setup and callback URLs.

## Single binary

Run `bun run build:server`. Bun compiles `packages/server/src/main.ts` into `dist/openharness`. The binary uses `OPENHARNESS_HOST`, `OPENHARNESS_PORT`, `OPENHARNESS_DATA_DIR`, and `OPENHARNESS_WORKSPACE` at runtime.

## Docker Compose

Copy `.env.example` to `.env`, set matching admin/server tokens, a stable web session secret, and your public web URL. Configure OAuth client credentials and either an email allowlist or explicit signup policy as needed, then run:

```bash
docker compose up --build
```

Compose starts the API on port 4096 and the web UI on port 3000, persists server state in the `openharness-data` volume, and mounts the configured workspace to `/workspace`. Both runtime images are non-root and include HTTP health checks. Set `OPENHARNESS_WEB_SESSION_SECRET` to a stable random value in managed deployments. Do not mount sensitive host directories as the workspace.

## Secrets and backups

Secret values use AES-256-GCM. When `OPENHARNESS_SECRET_KEY` is unset, the server creates `.openharness/secret.key` with restrictive file permissions and stores ciphertext in `.openharness/secrets.json`. Back up the key and data directory together; without the key, stored values cannot be decrypted. Set a stable `OPENHARNESS_SECRET_KEY` in managed deployments and keep it in the deployment secret manager.

## Modal backend

`deploy/modal/web_server.py` runs the API server on Modal. The image installs the repository dependencies and starts `packages/server/src/main.ts` with Node. The function is exposed with `@modal.web_server(4096)`, so Modal's proxy streams SSE responses.

1. Create the persistent volume and the token secret once per workspace:

   ```bash
   modal volume create --version=2 openharness-data
   modal secret create openharness-server \
     OPENHARNESS_SERVER_TOKEN="<server-token>" \
     OPENHARNESS_ADMIN_TOKEN="<admin-token>"
   ```

2. Deploy:

   ```bash
   modal deploy deploy/modal/web_server.py
   ```

The server keeps state on the `openharness-data` volume at `/data`, uses `/app` as the agent workspace, and runs the offline `mock` provider by default. Configure `OPENHARNESS_SERVER_TOKEN` and `OPENHARNESS_ADMIN_TOKEN` in the `openharness-server` Modal secret before deployment; the function attaches that secret at runtime and does not use fallback credentials. The hosted web deployment enables `OPENHARNESS_WEB_GUEST=1`: first-time visitors receive a signed guest cookie and can start chats without administrator sign-in; each browser gets a separate tenant. Settings and `/v1/admin/**` still require administrator sign-in. Guest chats can use the configured model API key, so enable this only for a public-facing app where visitor model usage is intended. The web deployment sets `OPENHARNESS_WEB_DISABLE_SANDBOX=1`, so Ask mode can call a configured model without provisioning a sandbox and no runtime is selected by default. Code mode remains available when an active runtime is explicitly selected. The function is capped at one container because the JSON state store assumes a single writer; simultaneous SSE streams are handled with `@modal.concurrent`. Do not scale `max_containers` until the Postgres/Redis adapters are in use (see [Scaling](SCALING.md)).

To use Meta Model API, add `MODEL_API_KEY=<key>` to the existing `openharness-server` Modal secret and redeploy. The server defaults to `muse-spark-1.3` at `https://api.meta.ai/v1`; set `OPENHARNESS_MODEL` or `OPENHARNESS_BASE_URL` only to override those defaults. The key is read from the secret store/environment and is never returned by the settings API. OpenHarness routes the Muse model IDs directly to Meta, so their requests do not use Fireworks or Baseten credentials/credits.

SSE keep-alive pings are sent every 5 seconds and the Bun server uses a 120-second idle timeout, so streams survive Modal's proxy and Bun's default 10-second request timeout. Modal requests can last up to one hour; clients should still reconnect with `Last-Event-ID` after a disconnect.

## Vercel frontend

The React UI is a Vite single-page app at the repository root. The linked `openharness-web` project uses the root directory, Vite, `npm run build:web`, and `dist`. `vercel.json` serves the UI and proxies `/v1/*` and `/health` to the Modal backend, keeping browser API requests, login cookies, and SSE on the Vercel origin. Leave `VITE_OPENHARNESS_URL` unset for this deployment; setting it to the Modal URL bypasses the same-origin proxy. The proxy does not attach a server or admin token; users authenticate through the UI with the configured administrator token.

Deploy from the repository root:

```bash
vercel deploy --prod
```

The API remains on Modal with the persistent `openharness-data` volume. Keep `OPENHARNESS_SERVER_TOKEN` and `OPENHARNESS_ADMIN_TOKEN` in the `openharness-server` Modal secret. Do not place either token in a `VITE_*` variable, since Vite embeds those values into public browser assets. The offline mock model is for local development and evaluation; the web UI hides it and blocks chat until a real provider and model are configured in Settings.

Open the Vercel production domain listed for the project. Generated deployment URLs can be covered by Vercel Deployment Protection and may return Vercel's sign-in page instead of the app; they are not interchangeable with the production domain.

## CI

`.github/workflows/ci.yml` installs from the frozen Bun lockfile, builds the server binary and web app, runs the web type check, then starts the offline backend and executes the JSONL demo eval suite. CI does not publish images or artifacts.
