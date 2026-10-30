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

`deploy/modal/app.py` runs the API server on Modal. The image installs from the frozen lockfile, compiles `packages/server/src/main.ts` into a single Bun binary, and drops `node_modules` and the web app before the runtime layer. The function is exposed with `@modal.web_server(4096)`, so Modal's proxy streams SSE responses.

1. Create the persistent volume and the token secret once per workspace:

   ```bash
   modal volume create --version=2 openharness-data
   modal secret create openharness-server \
     OPENHARNESS_SERVER_TOKEN="<server-token>" \
     OPENHARNESS_ADMIN_TOKEN="<admin-token>"
   ```

2. Deploy:

   ```bash
   modal deploy deploy/modal/app.py
   ```

The server keeps state on the `openharness-data` volume at `/data`, uses `/repo` as the agent workspace, and runs the offline `mock` provider by default. The function is capped at one container because the JSON state store assumes a single writer; simultaneous SSE streams are handled with `@modal.concurrent`. Do not scale `max_containers` until the Postgres/Redis adapters are in use (see [Scaling](SCALING.md)).

To use a real OpenAI-compatible model, add `OPENHARNESS_PROVIDER=openai`, `OPENHARNESS_MODEL=<model>`, and `OPENAI_API_KEY=<key>` to the Modal secret (or `env` on the function), then redeploy. Secret values override the image defaults.

SSE keep-alive pings are sent every 5 seconds and the Bun server uses a 120-second idle timeout, so streams survive Modal's proxy and Bun's default 10-second request timeout. Modal requests can last up to one hour; clients should still reconnect with `Last-Event-ID` after a disconnect.

## Vercel frontend

The Next.js UI can be deployed to Vercel independently of the Bun API server. The project installs from the Bun workspace root and uses `apps/web` as its Root Directory.

1. Link the project from the repository root:

   ```bash
   vercel link --yes --project openharness-web
   vercel project update openharness-web --root-directory apps/web --framework nextjs --node-version 22.x
   ```

2. Set the runtime environment variables:

   ```bash
   vercel env add OPENHARNESS_WEB_SESSION_SECRET production --value "<stable-random-secret>" --sensitive
   vercel env add OPENHARNESS_URL production --value "https://<backend-host>"
   vercel env add OPENHARNESS_SERVER_TOKEN production --value "<server-token>"   # only if the API requires it
   vercel env add OPENHARNESS_WEB_URL production --value "https://<vercel-production-domain>"
   ```

3. Deploy:

   ```bash
   vercel deploy --prod
   ```

`OPENHARNESS_URL` must be a public HTTPS origin reachable from Vercel Functions. The Bun server cannot run as a Vercel Function because it needs a long-lived process, local disk state, and SSE. Run it on Modal with a persistent volume and stream-friendly ingress, then point `OPENHARNESS_URL` at the deployed `*.modal.run` URL. Set `OPENHARNESS_SERVER_TOKEN` on Vercel to the same value stored in the `openharness-server` Modal secret.

Do not set `OPENHARNESS_ADMIN_TOKEN` on a public deployment. Settings, secrets, MCP configuration, and reload are under `/v1/admin/**`; forwarding the admin token through the web proxy would grant every visitor administrator access. Chat, sessions, models, tools, and permissions work with the server token alone.

For a temporary UI-only demo, set `OPENHARNESS_WEB_AUTH_DISABLED=true`. This skips the sign-in screen and the proxy's admin-cookie requirement. If `OPENHARNESS_ADMIN_TOKEN` is also set, the proxy forwards it upstream, which gives every visitor administrator access; only do that for a private demo. Remove the variable and redeploy to restore sign-in.

Hobby notes: functions allow up to 300 seconds, builds are capped at 45 minutes, and deployment size is limited. The repository `.vercelignore` keeps the local `dist/` server binary out of CLI uploads. Git auto-deploy requires connecting GitHub under Vercel Account Settings -> Login Connections, then running `vercel git connect`.

## CI

`.github/workflows/ci.yml` installs from the frozen Bun lockfile, builds the server binary and web app, runs the web type check, then starts the offline backend and executes the JSONL demo eval suite. CI does not publish images or artifacts.
