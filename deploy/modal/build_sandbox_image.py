# deploy/modal/build_sandbox_image.py -- build and publish the Modal sandbox image; writes deploy/modal/image-manifest.json
import json
import pathlib
import modal

ROOT = pathlib.Path(__file__).resolve().parents[2]
APP = "openharness"
PLAYWRIGHT = "1.48.2"

WRAPPER = """#!/usr/bin/env bash
set -euo pipefail
exec /opt/oh/node_modules/.bin/tsx /opt/oh/packages/sandboxd/src/bin.ts "$@"
"""


def build_sandbox_image() -> modal.Image:
    return (
        modal.Image.debian_slim(python_version="3.11")
        .apt_install(
            "ca-certificates",
            "curl",
            "git",
            "bubblewrap",
            "socat",
            "util-linux",
            "build-essential",
            "jq",
            "tar",
            "gzip",
            "unzip",
        )
        .run_commands(
            "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs",
            "useradd --create-home -u 1000 --shell /bin/bash agent || true",
        )
        .env({"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright"})
        .add_local_dir(str(ROOT / "packages"), remote_path="/opt/oh/packages", copy=True)
        .add_local_file(str(ROOT / "package.json"), remote_path="/opt/oh/package.json", copy=True)
        .run_commands(
            f"cd /opt/oh && npm install --no-audit --no-fund tsx@^4.19.0 playwright@{PLAYWRIGHT}",
            "cd /opt/oh && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright",
            f"printf %s {json.dumps(WRAPPER)} > /usr/local/bin/oh-sandboxd && chmod 0755 /usr/local/bin/oh-sandboxd",
            "install -d -o agent -g agent -m 0755 /workspace /memories /tmp/oh /oh/.shadow-git",
        )
    )


def main() -> None:
    app = modal.App.lookup(APP, create_if_missing=True)
    image = build_sandbox_image()
    with modal.enable_output():
        built = image.build(app)
        manifest = {
            "imageId": built.object_id,
            "sandboxImage": built.object_id,
            "app": APP,
            "playwright": PLAYWRIGHT,
        }
        out_path = ROOT / "deploy/modal/image-manifest.json"
        out_path.write_text(json.dumps(manifest, indent=2) + "\n")
        print(json.dumps(manifest))


if __name__ == "__main__":
    main()
