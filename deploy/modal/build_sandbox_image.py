# deploy/modal/build_sandbox_image.py -- build and publish the Modal sandbox image; writes deploy/modal/image-manifest.json
import json
import pathlib
import modal

ROOT = pathlib.Path(__file__).resolve().parents[2]
APP = "openharness"
PLAYWRIGHT = "1.48.2"

WRAPPER = """#!/usr/bin/env bash
set -euo pipefail
export NODE_PATH=/opt/oh/node_modules
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
export OH_VM_ISOLATED=1
if [ -f /opt/oh/oh-sandboxd.mjs ]; then
  exec node /opt/oh/oh-sandboxd.mjs "$@"
fi
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
            # Install the same OS-level process sandbox that the daemon requires
            # for enforcing its per-run filesystem and network policy.
            "npm install --global @anthropic-ai/sandbox-runtime && srt --version",
            "useradd --create-home -u 1000 --shell /bin/bash agent || true",
        )
        .env({"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright", "NODE_PATH": "/opt/oh/node_modules", "OH_VM_ISOLATED": "1"})
        .add_local_dir(str(ROOT / "packages"), remote_path="/opt/oh/packages", copy=True)
        .add_local_file(str(ROOT / "package.json"), remote_path="/opt/oh/package.json", copy=True)
        .run_commands(
            f"cd /opt/oh && npm install --no-audit --no-fund tsx@^4.19.0 playwright@{PLAYWRIGHT}",
            "find /opt/oh/packages -type f \\( -name '*.ts' -o -name '*.mjs' -o -name '*.js' -o -name '*.json' \\) -exec sed -i 's/\\r$//' {} +",
            'cd /opt/oh && npx --yes esbuild packages/sandboxd/src/bin.ts --bundle --platform=node --target=node22 --format=esm "--banner:js=import { createRequire as __ohCreateRequire } from \'node:module\'; const require = __ohCreateRequire(import.meta.url);" --external:playwright --external:playwright-core --outfile=/opt/oh/oh-sandboxd.mjs',
            "cd /opt/oh && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright",
            f"printf %s {json.dumps(WRAPPER)} > /usr/local/bin/oh-sandboxd && chmod 0755 /usr/local/bin/oh-sandboxd",
            "sed -i 's/\\r$//' /usr/local/bin/oh-sandboxd && chmod 0755 /usr/local/bin/oh-sandboxd",
            "install -d -o agent -g agent -m 0755 /workspace /memories /tmp/oh /oh/.shadow-git",
            (
                "bash -lc '"
                "OH_SESSION_KEY=buildcheck_secret_key_0123456789abcdef "
                "OH_SESSION_ID=sess_buildcheck "
                "OH_RUN_ID=run_buildcheck "
                "OH_VM_ISOLATED=1 "
                "/usr/local/bin/oh-sandboxd --host 127.0.0.1 --port 18080 >/tmp/oh-buildcheck.log 2>&1 & "
                "PID=$!; "
                "trap \"kill $PID 2>/dev/null || true\" EXIT; "
                "for i in $(seq 1 50); do "
                "  if curl -fsS http://127.0.0.1:18080/health | jq -e \".ok == true and .osEnforced == true\" >/dev/null 2>&1; then "
                "    curl -fsS -X POST http://127.0.0.1:18080/shell/main/exec "
                "      -H \"x-session-key: buildcheck_secret_key_0123456789abcdef\" "
                "      -H \"content-type: application/json\" "
                "      -d \"{\\\"command\\\":\\\"echo sandbox_ok\\\",\\\"timeoutSec\\\":10}\" "
                "      | jq -e \".exitCode == 0\" >/dev/null; "
                "    rm -rf /workspace/* /workspace/.[!.]* /oh/.shadow-git/* /oh/.shadow-git/.[!.]* /tmp/oh/* /tmp/oh-buildcheck.log 2>/dev/null || true; "
                "    exit 0; "
                "  fi; "
                "  if ! kill -0 $PID 2>/dev/null; then cat /tmp/oh-buildcheck.log >&2; exit 1; fi; "
                "  sleep 0.2; "
                "done; "
                "cat /tmp/oh-buildcheck.log >&2; exit 1'"
            ),
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
