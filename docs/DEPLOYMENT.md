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

`OPENHARNESS_URL` must be a public HTTPS origin reachable from Vercel Functions. The Bun server cannot run as a Vercel Function because it needs a long-lived process, local disk state, and SSE. Run it on Modal (or another container host) with a persistent volume and stream-friendly ingress, then point `OPENHARNESS_URL` at it.

Hobby notes: functions allow up to 300 seconds, builds are capped at 45 minutes, and deployment size is limited. The repository `.vercelignore` keeps the local `dist/` server binary out of CLI uploads. Git auto-deploy requires connecting GitHub under Vercel Account Settings -> Login Connections, then running `vercel git connect`.

## CI

`.github/workflows/ci.yml` installs from the frozen Bun lockfile, builds the server binary and web app, runs the web type check, then starts the offline backend and executes the JSONL demo eval suite. CI does not publish images or artifacts.
