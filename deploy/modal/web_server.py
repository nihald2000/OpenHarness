"""Deploy the OpenHarness HTTP/SSE Backend Server on Modal.com.

Usage:
    modal deploy deploy/modal/web_server.py

This updates the existing openharness-server deployment and preserves its endpoint:
https://<workspace>--openharness-server-server.modal.run
which the Vercel rewrite proxies to. Leave VITE_OPENHARNESS_URL unset for the
Vercel frontend so browser requests and admin session cookies stay same-origin.
"""

from __future__ import annotations

import os
import pathlib
import json
import hashlib
import subprocess
import modal

MODULE_PATH = pathlib.Path(__file__).resolve()
ROOT = next(
    (parent for parent in MODULE_PATH.parents if (parent / "package.json").is_file()),
    pathlib.Path("/app"),
)
def read_manifest_image_id() -> str:
    # Modal loads this module from its uploaded source bundle, which may not
    # share the source file's original directory. The runtime image always
    # contains the repository under /app, so check that copy as well.
    candidates = (
        MODULE_PATH.parent / "image-manifest.json",
        ROOT / "deploy" / "modal" / "image-manifest.json",
    )
    for manifest_path in candidates:
        try:
            image_id = json.loads(manifest_path.read_text()).get("imageId", "")
        except (OSError, ValueError, TypeError):
            continue
        if isinstance(image_id, str) and image_id.strip():
            return image_id.strip()
    return ""


MANIFEST_IMAGE_ID = read_manifest_image_id()
RESOLVED_IMAGE_ID = (
    os.environ.get("OH_MODAL_IMAGE_ID_OVERRIDE", "").strip()
    or MANIFEST_IMAGE_ID.strip()
    or os.environ.get("OH_MODAL_IMAGE_ID", "").strip()
)
app = modal.App("openharness-server")
volume = modal.Volume.from_name("openharness-data", create_if_missing=True)

server_image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.12")
    .apt_install("ca-certificates", "git", "curl", "ripgrep")
    .add_local_dir(
        str(ROOT),
        remote_path="/app",
        ignore=[
            ".git",
            "node_modules",
            "dist",
            ".openharness",
            ".vercel",
        ],
        copy=True,
    )
    .run_commands("cd /app && npm ci")
    .env({"OH_MODAL_IMAGE_ID": RESOLVED_IMAGE_ID})
)


@app.function(
    image=server_image,
    volumes={"/data": volume},
    secrets=[modal.Secret.from_name("openharness-server")],
    cpu=0.5,
    memory=1024,
    timeout=3600,
    max_containers=1,
    min_containers=0,
    scaledown_window=60,
)
@modal.concurrent(max_inputs=100)
@modal.web_server(4096, startup_timeout=60)
def server():
    image_id = RESOLVED_IMAGE_ID.strip() or os.environ.get("OH_MODAL_IMAGE_ID", "").strip()
    sandbox_url = os.environ.get("OH_MODAL_SANDBOX_URL", "").strip()
    if not sandbox_url:
        try:
            sandbox_url = (modal.Function.from_name("openharness-sandboxd", "sandboxd").get_web_url() or "").strip()
        except Exception as exc:
            print(f"[openharness-server] warning: could not lookup openharness-sandboxd web url: {exc}", flush=True)
            sandbox_url = ""
    shared_key = os.environ.get("OH_MODAL_SANDBOX_KEY", "").strip()
    if not shared_key and os.environ.get("MODAL_TOKEN_SECRET"):
        shared_key = hashlib.sha256(
            f"oh-sandboxd-v1:{os.environ['MODAL_TOKEN_SECRET']}".encode()
        ).hexdigest()
    env = {
        **os.environ,
        # The Modal worker-local socket is not available to the Node subprocess
        # in this deployment. Use the public control-plane endpoint so the JS
        # SDK authenticates with MODAL_TOKEN_ID / MODAL_TOKEN_SECRET.
        "MODAL_SERVER_URL": "https://api.modal.com:443",
        "OH_MODAL_APP": os.environ.get("OH_MODAL_APP", "openharness"),
        "OH_MODAL_IMAGE_ID": image_id,
        "OH_MODAL_SANDBOX_URL": sandbox_url,
        "OH_MODAL_SANDBOX_KEY": shared_key,
        "OH_DEFAULT_RUNTIME": os.environ.get("OH_DEFAULT_RUNTIME", "modal"),
        "OH_MODAL_SANDBOX_RUNTIME": os.environ.get("OH_MODAL_SANDBOX_RUNTIME", "gvisor"),
        "OH_SANDBOX_IDLE_MS": os.environ.get("OH_SANDBOX_IDLE_MS", "180000"),
        "OH_MODAL_KEEPALIVE": "1",
        "OPENHARNESS_ISOLATE_SESSIONS": "1",
        # Give each anonymous browser a signed, isolated tenant cookie; admin
        # routes still require the separate administrator session.
        "OPENHARNESS_WEB_GUEST": "1",
        "OPENHARNESS_HOST": "0.0.0.0",
        "OPENHARNESS_PORT": "4096",
        "OPENHARNESS_DATA_DIR": "/data",
    }
    print(f"[openharness-server] active OH_MODAL_IMAGE_ID={image_id}", flush=True)
    print(f"[openharness-server] active OH_MODAL_SANDBOX_URL={sandbox_url}", flush=True)
    subprocess.Popen(
        ["node", "--import", "tsx", "packages/server/src/main.ts"],
        cwd="/app",
        env=env,
    )
