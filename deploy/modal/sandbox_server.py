"""Deploy the always-on Modal sandbox hub used by pinned Modal sessions."""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import subprocess

import modal


ROOT = pathlib.Path(__file__).resolve().parents[2]
APP_NAME = "openharness-sandboxd"
PLAYWRIGHT = "1.48.2"

app = modal.App(APP_NAME)
workspaces_vol = modal.Volume.from_name("openharness-workspaces", create_if_missing=True)

smoke_test = """bash -lc '
OH_MODAL_SANDBOX_KEY=smoke_key OH_VM_ISOLATED=1 OH_DISABLE_SRT=1 \
  node /opt/oh/oh-sandboxd-hub.mjs --host 127.0.0.1 --port 18080 --root /tmp/oh-smoke >/tmp/oh-hub-smoke.log 2>&1 &
PID=$!
trap "kill $PID 2>/dev/null || true" EXIT
for i in $(seq 1 50); do
  if curl -fsS http://127.0.0.1:18080/health | jq -e ".ok == true and .mode == \\\"pinned-hub\\\"" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 $PID 2>/dev/null; then cat /tmp/oh-hub-smoke.log >&2; exit 1; fi
  sleep 0.2
done
curl -fsS -X POST http://127.0.0.1:18080/sessions/init \\
  -H "x-session-key: smoke_key" -H "x-oh-sandbox-id: smoke_session" \\
  -H "content-type: application/json" -d "{}" | jq -e ".ok == true" >/dev/null
curl -fsS -X POST http://127.0.0.1:18080/shell/main/exec \\
  -H "x-session-key: smoke_key" -H "x-oh-sandbox-id: smoke_session" \\
  -H "content-type: application/json" \\
  -d "{\\\"command\\\":\\\"python3 -c \\\\\\\"print(42)\\\\\\\"\\\",\\\"timeoutSec\\\":10}" \\
  | jq -e ".exitCode == 0 and (.output | contains(\\\"42\\\"))" >/dev/null
rm -rf /tmp/oh-smoke /tmp/oh/smoke_session /tmp/oh-hub-smoke.log
'"""


sandbox_image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.11")
    .apt_install(
        "ca-certificates", "curl", "git", "jq", "ripgrep", "tar", "gzip", "unzip",
        "build-essential", "procps",
    )
    .env({"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright", "NODE_PATH": "/opt/oh/node_modules"})
    .add_local_dir(str(ROOT / "packages"), remote_path="/opt/oh/packages", copy=True)
    .add_local_file(str(ROOT / "package.json"), remote_path="/opt/oh/package.json", copy=True)
    .run_commands(
        f"cd /opt/oh && npm install --no-audit --no-fund --no-save esbuild tsx playwright@{PLAYWRIGHT}",
        "find /opt/oh/packages -type f \\( -name '*.ts' -o -name '*.mjs' -o -name '*.js' -o -name '*.json' \\) -exec sed -i 's/\\r$//' {} +",
        "cd /opt/oh && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright",
        "cd /opt/oh && npx esbuild packages/sandboxd/src/hub.ts --bundle --platform=node --target=node22 --format=esm --external:playwright --external:playwright-core --outfile=/opt/oh/oh-sandboxd-hub.mjs",
        f"{smoke_test}",
    )
)


@app.function(
    image=sandbox_image,
    volumes={"/workspaces": workspaces_vol},
    secrets=[modal.Secret.from_name("openharness-server")],
    cpu=0.25,
    memory=1024,
    timeout=3600,
    max_containers=1,
    min_containers=int(os.environ.get("OH_SANDBOX_MIN_CONTAINERS", "1")),
    scaledown_window=900,
)
@modal.concurrent(max_inputs=100)
@modal.web_server(8080, startup_timeout=60)
def sandboxd():
    configured_key = os.environ.get("OH_MODAL_SANDBOX_KEY", "").strip()
    shared_key = configured_key or hashlib.sha256(
        f"oh-sandboxd-v1:{os.environ['MODAL_TOKEN_SECRET']}".encode()
    ).hexdigest()
    env = {
        **os.environ,
        "OH_MODAL_SANDBOX_KEY": shared_key,
        "OH_WORKSPACES_ROOT": "/workspaces",
        "OH_VM_ISOLATED": "1",
        "OH_DISABLE_SRT": "1",
        "NODE_PATH": "/opt/oh/node_modules",
        "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
    }
    subprocess.Popen(
        ["node", "/opt/oh/oh-sandboxd-hub.mjs", "--host", "0.0.0.0", "--port", "8080", "--root", "/workspaces"],
        cwd="/tmp",
        env=env,
    )
