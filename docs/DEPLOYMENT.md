# Build and deployment

## Local development

Run `bun install`, then run `bun run server` and `bun run dev` in separate terminals. The server defaults to `127.0.0.1:4096`, stores sessions and encrypted secrets under `.openharness/`, and uses the offline mock provider. Configure `OPENHARNESS_ADMIN_TOKEN` for both server and web processes before signing in. The web app requires a login for all `/v1/**` requests; use the admin token recovery option or configure Google/GitHub OAuth. New OAuth signup is invite-only by default. See [Authentication](AUTHENTICATION.md) for provider setup and callback URLs.

## Single binary

Run `bun run build:server`. Bun compiles `packages/server/src/main.ts` into `dist/openharness`. The binary uses `OPENHARNESS_HOST`, `OPENHARNESS_PORT`, `OPENHARNESS_DATA_DIR`, and `OPENHARNESS_WORKSPACE` at runtime.

## Secrets and backups

Secret values use AES-256-GCM. When `OPENHARNESS_SECRET_KEY` is unset, the server creates `.openharness/secret.key` with restrictive file permissions and stores ciphertext in `.openharness/secrets.json`. Back up the key and data directory together; without the key, stored values cannot be decrypted. Set a stable `OPENHARNESS_SECRET_KEY` in managed deployments and keep it in the deployment secret manager.

## Modal backend

`deploy/modal/web_server.py` runs the API at port 4096 in Modal app `openharness-server`, function `server`, with application data on Volume `openharness-data`. `deploy/modal/sandbox_server.py` runs the port-8080 hub in app `openharness-sandboxd`, function `sandboxd`, with workspaces on Volume `openharness-workspaces`. Vercel rewrites `/v1/*` and `/health` to the API. Guest browsers receive signed tenant cookies.

Create the dedicated hub key locally and store it only in the named secret:

```powershell
$k = python -c "import secrets; print(secrets.token_hex(32))"
modal secret create openharness-sandbox-key OH_MODAL_SANDBOX_KEY=$k
```

The `openharness-server` Modal secret contains model/provider keys, `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` (server only), `OPENHARNESS_MODEL`, `OPENHARNESS_WEB_GUEST_SECRET`, and optional `OH_MAX_ACTIVE_RUNS`, `OH_GUEST_MAX_ACTIVE_RUNS`, and `OH_GUEST_MAX_RUNS_PER_DAY`. The `openharness-sandbox-key` secret contains only `OH_MODAL_SANDBOX_KEY` and is attached to both apps. Never attach `openharness-server` to the hub. Remove any old hub shared key from `openharness-server`; do not put a secret in a `VITE_*` variable. Remove any old frontend access-key environment variable from Vercel.

Deploy in this order: create/update both secrets, run `modal deploy deploy/modal/sandbox_server.py`, then `modal deploy deploy/modal/web_server.py`; update Vercel rewrites to the Modal server URL and run `vercel deploy --prod`. Verify the guest cookie flow with `node scripts/smoke.mjs https://<project>.vercel.app`. The server works with `MODEL_API_KEY` for Meta Model API or with a provider configured in Admin Settings; a Muse Glimmer GPU endpoint is optional.

The hub runs one warm container by default at 0.25 CPU and 1 GiB, which the deployment plan estimates at roughly $10–15/month against $30 of monthly free credit. Set `OH_SANDBOX_MIN_CONTAINERS=0` to trade first-request cold start for lower idle cost. Guest run limits default to 3 active runs globally, 1 active run per browser, and 20 runs per browser per day. They are in-memory limits and reset on process restart.

The hub creates per-session workspace/home/tmp folders and dedicated non-root UIDs. The hub receives only its dedicated key and a minimal environment. Sessions share a network namespace, so a session may reach another session's development server via localhost; `/preview/<port>` is unauthenticated. Modal Volumes are last-write-wins, and both apps remain at one container while the local JSON state path assumes a single writer. Modal web requests cap at 150 seconds; background runs use authenticated keepalive requests under 120 seconds and SSE clients reconnect by event cursor.

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
