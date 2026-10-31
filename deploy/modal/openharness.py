# deploy/modal/openharness.py -- Modal Starter (free) web_server + Volume deployment for OpenHarness
import json
import os
import pathlib
import subprocess
import modal

ROOT = pathlib.Path(__file__).resolve().parents[2]
MANIFEST_PATH = ROOT / "deploy/modal/image-manifest.json"

SANDBOX_IMAGE_ID = os.environ.get("OH_MODAL_IMAGE_ID", "")
if not SANDBOX_IMAGE_ID and MANIFEST_PATH.exists():
    try:
        SANDBOX_IMAGE_ID = json.loads(MANIFEST_PATH.read_text()).get("imageId", "")
    except Exception:
        pass

app = modal.App("openharness")
state_volume = modal.Volume.from_name("openharness-state", create_if_missing=True)

api_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ca-certificates", "curl", "git", "tar", "gzip")
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
    )
    .add_local_file(str(ROOT / "package.json"), remote_path="/app/package.json", copy=True)
    .add_local_file(str(ROOT / "tsconfig.json"), remote_path="/app/tsconfig.json", copy=True)
    .add_local_file(str(ROOT / "tsconfig.server.json"), remote_path="/app/tsconfig.server.json", copy=True)
    .add_local_dir(str(ROOT / "packages"), remote_path="/app/packages", copy=True)
    .add_local_dir(str(ROOT / "deploy/modal"), remote_path="/app/deploy/modal", copy=True)
    .run_commands(
        "cd /app && npm install --omit=dev --no-audit --no-fund --ignore-scripts"
    )
)


@app.function(
    image=api_image,
    volumes={"/data": state_volume},
    timeout=3600,
    min_containers=0,
    max_containers=1,
    allow_concurrent_inputs=100,
)
@modal.web_server(8000, startup_timeout=60)
def api() -> None:
    env = os.environ.copy()
    env.setdefault("OPENHARNESS_HOST", "0.0.0.0")
    env.setdefault("OPENHARNESS_PORT", "8000")
    env.setdefault("OPENHARNESS_DATA_DIR", "/data")
    env.setdefault("OH_AUTH_MODE", "open")
    env.setdefault("OH_MODAL_KEEPALIVE", "1")
    env.setdefault("OH_MODAL_APP", "openharness")
    if SANDBOX_IMAGE_ID:
        env.setdefault("OH_MODAL_IMAGE_ID", SANDBOX_IMAGE_ID)

    subprocess.Popen(
        ["npx", "tsx", "packages/server/src/main.ts"],
        cwd="/app",
        env=env,
    )
