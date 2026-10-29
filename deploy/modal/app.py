"""Deploy the OpenHarness Bun server on Modal.

The server is compiled to a single Bun binary, then exposed with
``@modal.web_server`` so Modal's proxy can stream SSE responses. State lives on
a Modal Volume mounted at ``/data``; the repository checkout at ``/repo`` is the
agent workspace.

Prerequisites (once per workspace):

    modal volume create --version=2 openharness-data
    modal secret create openharness-server \
        OPENHARNESS_SERVER_TOKEN=... OPENHARNESS_ADMIN_TOKEN=...

Then:

    modal deploy deploy/modal/app.py
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import modal

def _repo_root() -> Path:
    """Resolve the checkout locally; inside a container Modal copies this file
    to /root, where __file__ no longer has a grandparent."""
    if not modal.is_local():
        return Path("/repo")
    return Path(__file__).resolve().parents[2]


REPO_ROOT = _repo_root()
APP_NAME = "openharness-server"
VOLUME_NAME = "openharness-data"
SECRET_NAME = "openharness-server"
PORT = 4096

# Keep the upload small. These paths are either rebuilt in the image or must
# never leave the developer machine.
IGNORE = [
    ".git",
    ".openharness",
    ".openharness-auth",
    ".vercel",
    ".tmp",
    ".bun-tmp",
    "node_modules",
    "**/node_modules",
    ".next",
    "**/.next",
    "dist",
    "**/dist",
    "*.log",
    "*.tsbuildinfo",
    ".env",
    ".env.*",
]

app = modal.App(APP_NAME)

image = (
    modal.Image.from_registry("oven/bun:1.4.4-slim", add_python="3.13")
    .apt_install("ca-certificates", "git", "ripgrep")
    .add_local_dir(REPO_ROOT, "/repo", copy=True, ignore=IGNORE)
    .run_commands(
        # One layer: install, compile, then drop node_modules and the web app so
        # they never reach the runtime image.
        "cd /repo"
        " && bun install --frozen-lockfile"
        " && bun build --compile packages/server/src/main.ts --outfile /usr/local/bin/openharness"
        " && rm -rf /repo/node_modules /repo/apps /repo/packages/*/node_modules",
    )
    .env(
        {
            "OPENHARNESS_HOST": "0.0.0.0",
            "OPENHARNESS_PORT": str(PORT),
            "OPENHARNESS_DATA_DIR": "/data",
            "OPENHARNESS_WORKSPACE": "/repo",
            "OPENHARNESS_CORS_ORIGINS": "https://openharness-web-six.vercel.app",
            # Offline demo provider by default. Override the secret/env to use a
            # real OpenAI-compatible endpoint.
            "OPENHARNESS_PROVIDER": "mock",
            "OPENHARNESS_MODEL": "mock/demo",
        }
    )
    .workdir("/repo")
)

data_volume = modal.Volume.from_name(VOLUME_NAME)
server_secret = modal.Secret.from_name(SECRET_NAME)


@app.function(
    image=image,
    volumes={"/data": data_volume},
    secrets=[server_secret],
    min_containers=0,
    # The JSON state store assumes a single writer. Keep one container and rely
    # on input concurrency for simultaneous SSE streams.
    max_containers=1,
    scaledown_window=180,
    timeout=3600,
)
@modal.concurrent(max_inputs=100)
@modal.web_server(PORT, startup_timeout=60)
def server() -> None:
    subprocess.Popen(["/usr/local/bin/openharness"], cwd="/repo")
