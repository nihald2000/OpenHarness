# deploy/modal/build_image.py -- build and publish the sandbox image; writes deploy/modal/image-manifest.json
import hashlib
import json
import pathlib
import subprocess
import modal

ROOT = pathlib.Path(__file__).resolve().parents[2]
APP, SRT, PLAYWRIGHT = "openharness-sandboxes", "0.0.81", "1.48.2"


def main() -> None:
    binary = ROOT / "dist" / "oh-sandboxd"
    subprocess.run(
        [
            "bun",
            "build",
            "--compile",
            "--target=bun-linux-x64",
            "packages/sandboxd/src/main.ts",
            "--outfile",
            str(binary),
        ],
        cwd=ROOT,
        check=True,
    )

    image = (
        modal.Image.from_registry("ubuntu:24.04", add_python="3.12")
        .apt_install(
            "ca-certificates",
            "curl",
            "git",
            "bubblewrap",
            "socat",
            "util-linux",
            "build-essential",
            "jq",
            "unzip",
        )
        .run_commands(
            "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs",
            f"npm install -g @anthropic-ai/sandbox-runtime@{SRT}",
            "useradd --create-home -u 1000 --shell /bin/bash agent",
        )
        .env({"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright"})
        .run_commands(
            f"mkdir -p /opt/oh && cd /opt/oh && npm init -y >/dev/null && npm install playwright@{PLAYWRIGHT}",
            "cd /opt/oh && npx playwright install --with-deps chromium && chmod -R a+rX /ms-playwright",
        )
        .add_local_file(str(binary), "/usr/local/bin/oh-sandboxd", copy=True)
        .add_local_file(
            str(ROOT / "packages/sandboxd/browser-worker.mjs"),
            "/opt/oh/browser-worker.mjs",
            copy=True,
        )
        .run_commands(
            "chmod 0755 /usr/local/bin/oh-sandboxd",
            "install -d -o agent -g agent -m 0750 /workspace /memories /tmp/oh",
            "install -d -o root -g root -m 0755 /oh",
        )
    )

    app = modal.App.lookup(APP, create_if_missing=True)
    with modal.enable_output():
        built = image.build(app)
        manifest = {
            "sandboxImage": built.object_id,
            "app": APP,
            "srt": SRT,
            "playwright": PLAYWRIGHT,
            "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        }
        (ROOT / "deploy/modal/image-manifest.json").write_text(
            json.dumps(manifest, indent=2) + "\n"
        )
        print(json.dumps(manifest))


if __name__ == "__main__":
    main()
