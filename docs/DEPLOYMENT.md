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

## CI

`.github/workflows/ci.yml` installs from the frozen Bun lockfile, builds the server binary and web app, runs the web type check, then starts the offline backend and executes the JSONL demo eval suite. CI does not publish images or artifacts.
