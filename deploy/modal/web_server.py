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
import subprocess
import modal

MODULE_PATH = pathlib.Path(__file__).resolve()
ROOT = next(
    (parent for parent in MODULE_PATH.parents if (parent / "package.json").is_file()),
    pathlib.Path("/app"),
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
)


@app.function(
    image=server_image,
    volumes={"/data": volume},
    secrets=[modal.Secret.from_name("openharness-server")],
    timeout=3600,
    max_containers=1,
)
@modal.concurrent(max_inputs=100)
@modal.web_server(4096, startup_timeout=60)
def server():
    env = {
        **os.environ,
        # The Modal worker-local socket is not available to the Node subprocess
        # in this deployment. Use the public control-plane endpoint so the JS
        # SDK authenticates with MODAL_TOKEN_ID / MODAL_TOKEN_SECRET.
        "MODAL_SERVER_URL": "https://api.modal.com:443",
        # Keep ordinary web conversations on the model path until a sandbox
        # runtime is explicitly selected for a Code run.
        "OPENHARNESS_WEB_DISABLE_SANDBOX": "1",
        # Give each anonymous browser a signed, isolated tenant cookie; admin
        # routes still require the separate administrator session.
        "OPENHARNESS_WEB_GUEST": "1",
        "OPENHARNESS_HOST": "0.0.0.0",
        "OPENHARNESS_PORT": "4096",
        "OPENHARNESS_DATA_DIR": "/data",
    }
    subprocess.Popen(
        ["node", "--import", "tsx", "packages/server/src/main.ts"],
        cwd="/app",
        env=env,
    )
