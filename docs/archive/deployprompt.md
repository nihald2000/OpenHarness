# OpenHarness deployment checklist

## §1. Topology

Vercel serves the web UI and rewrites `/v1/*` and `/health` to Modal app `openharness-server`, function `server` on port 4096. The API stores application data in Volume `openharness-data` and issues signed guest cookies. It connects to Modal app `openharness-sandboxd`, function `sandboxd` on port 8080. The hub keeps session workspaces in Volume `openharness-workspaces`, with one private workspace and Linux UID per session. Per-session Modal Sandboxes remain an optional path when `OH_MODAL_IMAGE_ID` is configured.

## §2. Deployment cleanup

Removed obsolete files after checking scripts, CI, tests, and documentation:

| Removed file | Reason |
| --- | --- |
| `Dockerfile`, `docker-compose.yml` | The supported deployment path is Modal and Vercel. |
| `deploy/modal/app.py`, `deploy/modal/openharness.py`, `deploy/modal/build_image.py`, `deploy/modal/__init__.py` | Replaced by `sandbox_server.py`, `web_server.py`, and `build_sandbox_image.py`. |
| `scripts/modal-stub.mjs`, `scripts/ts-loader.mjs` | CI now uses the installed Modal SDK and `tsx`. |

## §3. Hub isolation

The hub must receive only its dedicated hub key, not server/model credentials or Modal tokens. Its Node process uses a minimal environment. Linux shell and background processes run under a per-session non-root UID. Session workspace, home, and tmp directories are mode 700; the daemon returns ownership of root-written workspace files to that session UID. `setpriv` and `find` are installed in the image, and `/opt/oh` and `/ms-playwright` are readable/executable by session users.

## §4. Secrets

Create the dedicated key on a trusted local machine:

```powershell
$k = python -c "import secrets; print(secrets.token_hex(32))"
modal secret create openharness-sandbox-key OH_MODAL_SANDBOX_KEY=$k
```

`openharness-server` contains model/provider keys, `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` for the API server only, `OPENHARNESS_MODEL`, the guest cookie signing secret, and optional run limits: `OH_MAX_ACTIVE_RUNS`, `OH_GUEST_MAX_ACTIVE_RUNS`, and `OH_GUEST_MAX_RUNS_PER_DAY`. `openharness-sandbox-key` contains only `OH_MODAL_SANDBOX_KEY` and is attached to both apps. Never attach `openharness-server` to the hub. Remove any old `OH_MODAL_SANDBOX_KEY` from `openharness-server`.

## §5. First deployment

1. Create the two secrets and populate `openharness-server` with the required server credentials.
2. Deploy the hub: `modal deploy deploy/modal/sandbox_server.py`.
3. Deploy the API: `modal deploy deploy/modal/web_server.py`.
4. Set Vercel rewrites in `vercel.json` to the deployed server URL and deploy Vercel with `vercel deploy --prod`.
5. Run `node scripts/smoke.mjs https://<project>.vercel.app`.

Deploy the hub before the API after changing the shared key or hub image.

## §6. Smoke test

`scripts/smoke.mjs` uses the guest cookie flow and does not use an API access key. It checks `/health`, guest session creation, hidden unauthenticated keepalive, session creation, and completion of a mock-model run.

## §7. Runtime settings

- `OH_MODAL_IMAGE_ID`: optional image ID for per-session Modal Sandboxes.
- `OH_MODAL_SANDBOX_URL`: optional pinned hub URL override; otherwise the API discovers the hub endpoint.
- `OH_MODAL_SANDBOX_RUNTIME`: defaults to `gvisor`; `vm` is available for images requiring KVM.
- `OPENHARNESS_WEB_GUEST=1`: enables signed guest cookies.
- Do not configure a frontend access-key variable. Vite variables are public; remove any old frontend access-key setting from Vercel.

The API works with `MODEL_API_KEY` for Meta Model API or another provider configured in Admin Settings. The optional Muse Glimmer service is not required.

## §8. Guest run limits

Defaults are three active runs globally, one active run per browser, and 20 runs per browser per UTC day. Override them with `OH_MAX_ACTIVE_RUNS`, `OH_GUEST_MAX_ACTIVE_RUNS`, and `OH_GUEST_MAX_RUNS_PER_DAY`. Limits are in-memory in the single API process and reset when it restarts.

## §9. Key rotation

Generate a new random key, update `openharness-sandbox-key` with `--force`, then redeploy both apps:

```powershell
$k = python -c "import secrets; print(secrets.token_hex(32))"
modal secret create --force openharness-sandbox-key OH_MODAL_SANDBOX_KEY=$k
modal deploy deploy/modal/sandbox_server.py
modal deploy deploy/modal/web_server.py
```

## §10. Budget

The hub defaults to 0.25 CPU, 1 GiB, and one warm container. The estimate is roughly $10–15/month against $30 monthly free credit while idle. Set `OH_SANDBOX_MIN_CONTAINERS=0` to reduce idle cost at the expense of cold start latency on the first request.

## §11. Known limits

- All sessions share the hub network namespace; a session may reach another session's development server through localhost.
- `/preview/<port>` is public and unauthenticated.
- Modal web requests have a 150-second cap. SSE clients reconnect; background keepalive uses authenticated requests shorter than 120 seconds through public ingress.
- Modal Volumes are last-write-wins. Both apps stay at one container while the JSON/local state path assumes one writer.
- Guest run quotas are process-local, not distributed quotas. Postgres/Redis integration and multi-node replay coverage are still required before making distributed-readiness claims.
