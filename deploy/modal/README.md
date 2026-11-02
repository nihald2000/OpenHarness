# Modal and Vercel deployment

## Live topology

Vercel serves the web UI and rewrites `/v1/*` and `/health` to Modal's `openharness-server` app, function `server`, on port 4096. The server persists application data in the `openharness-data` Volume and creates tenant-scoped guest cookies.

The server calls the `openharness-sandboxd` app, function `sandboxd`, on port 8080. That always-on hub uses the `openharness-workspaces` Volume and creates a private workspace, home directory, temporary directory, and Linux uid per session. Per-session Modal Sandboxes remain available when `OH_MODAL_IMAGE_ID` is configured. The hub and server share only `OH_MODAL_SANDBOX_KEY` for hub authentication.

## Secrets

Create a random key locally and keep its value private:

```powershell
$k = python -c "import secrets; print(secrets.token_hex(32))"
modal secret create openharness-sandbox-key OH_MODAL_SANDBOX_KEY=$k
```

If the sandbox shared key is already in `openharness-server`, remove it there. `openharness-server` contains model/provider keys, Modal credentials used by the server only, `OPENHARNESS_MODEL`, the guest cookie secret, and optional run-limit values. `openharness-sandbox-key` contains only `OH_MODAL_SANDBOX_KEY` and is attached to both Modal apps. Never attach `openharness-server` to the hub. Never put API keys in `VITE_*` frontend variables; remove any old frontend access-key environment variable from Vercel.

The hub runs with a minimal environment and rejects startup if its key is missing or shorter than 32 characters. To rotate the key, update the `openharness-sandbox-key` secret with `--force`, then redeploy both apps so the server and hub use the same value.

## First deployment

1. Create the two secrets as above and populate `openharness-server` with the required server credentials (including `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, and a guest signing secret).
2. Deploy the hub: `modal deploy deploy/modal/sandbox_server.py`.
3. Deploy the API: `modal deploy deploy/modal/web_server.py`.
4. Set the `/v1/*` and `/health` destinations in `vercel.json` to the deployed `openharness-server` URL, then deploy the Vercel project with `vercel deploy --prod`.
5. Verify guest access: `node scripts/smoke.mjs https://<project>.vercel.app`.

After updates, deploy `sandbox_server.py` before `web_server.py` when changing the shared hub key or sandbox image. The web app works with Meta Model API through `MODEL_API_KEY` or with another provider configured in Admin Settings; the optional Muse Glimmer GPU server is not required.

## Run limits and operating costs

Guest limits are controlled by `OH_MAX_ACTIVE_RUNS` (global concurrent runs, default 3), `OH_GUEST_MAX_ACTIVE_RUNS` (per-browser concurrent runs, default 1), and `OH_GUEST_MAX_RUNS_PER_DAY` (default 20). The values apply in the single Modal server container and reset when that process restarts.

The hub defaults to 0.25 CPU, 1 GiB memory, and one warm container. This can consume roughly $10–15/month of a $30 monthly free credit while idle; set `OH_SANDBOX_MIN_CONTAINERS=0` to reduce idle cost at the expense of first-request cold starts.

## Security boundaries and known limits

- Session shell commands use distinct non-root UIDs on the Linux hub; each workspace and home directory is mode 700. Root-owned workspace files are reassigned to the session owner after authenticated writes.
- Sessions still share the hub's network namespace. A session can potentially reach another session's dev-server port on localhost; the public `/preview/<port>` proxy is unauthenticated.
- Modal Volumes are last-write-wins; both apps intentionally use one container because the JSON/local state path assumes one writer.
- Modal web requests have a 150-second cap. SSE clients reconnect with their event cursor; background runs use authenticated public-ingress keepalive requests of at most 120 seconds.
- Guest cookies isolate tenants in the application API but do not replace account login or isolate network namespaces.

## Environment settings

The deployment recognizes `OH_MODAL_IMAGE_ID` for per-session Modal Sandboxes and `OH_MODAL_SANDBOX_URL` to override hub URL discovery. `OH_MODAL_SANDBOX_RUNTIME` defaults to `gvisor`; set it to `vm` only when the selected image requires KVM. `OPENHARNESS_WEB_GUEST=1` enables signed guest cookies.

## Local and legacy files

The obsolete deployment files removed from this repository are `Dockerfile`, `docker-compose.yml`, `deploy/modal/app.py`, `deploy/modal/openharness.py`, `deploy/modal/build_image.py`, `deploy/modal/__init__.py`, `scripts/modal-stub.mjs`, and `scripts/ts-loader.mjs`. `web_server.py` and `sandbox_server.py` are the supported live deployment scripts.

For key rotation, generate a new random value, update `openharness-sandbox-key` using Modal's `--force` option, then redeploy the hub and API so both receive the same value:

```powershell
$k = python -c "import secrets; print(secrets.token_hex(32))"
modal secret create --force openharness-sandbox-key OH_MODAL_SANDBOX_KEY=$k
modal deploy deploy/modal/sandbox_server.py
modal deploy deploy/modal/web_server.py
```
