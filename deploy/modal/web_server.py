"""Deploy the OpenHarness HTTP/SSE Backend Server on Modal.com.

Usage:
    modal deploy deploy/modal/web_server.py

This publishes a persistent HTTPS endpoint (e.g. https://<workspace>--openharness-backend-web.modal.run)
that you set as VITE_OPENHARNESS_URL in Vercel -> Settings -> Environment Variables.
"""

from __future__ import annotations

import os
import pathlib
import subprocess
import modal

ROOT = pathlib.Path(__file__).resolve().parents[2]
app = modal.App("openharness-backend")
volume = modal.Volume.from_name("openharness-data", create_if_missing=True)

server_image = (
    modal.Image.from_registry("node:22-bookworm-slim")
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
    .run_commands("cd /app && npm install")
)


@app.function(
    image=server_image,
    volumes={"/data": volume},
    timeout=3600,
    allow_concurrent_inputs=100,
)
@modal.web_server(4096, startup_timeout=60)
def web():
    env = {
        **os.environ,
        "OPENHARNESS_HOST": "0.0.0.0",
        "OPENHARNESS_PORT": "4096",
        "OPENHARNESS_DATA_DIR": "/data",
        "OPENHARNESS_SERVER_TOKEN": os.environ.get(
            "OPENHARNESS_SERVER_TOKEN", "oh_modal_default_service_token_2026"
        ),
        "OPENHARNESS_ADMIN_TOKEN": os.environ.get(
            "OPENHARNESS_ADMIN_TOKEN", "oh_modal_default_admin_token_2026"
        ),
    }
    subprocess.Popen(
        ["node", "--loader", "./scripts/ts-loader.mjs", "packages/server/src/main.ts"],
        cwd="/app",
        env=env,
    )
