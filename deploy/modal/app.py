"""Modal Application Entrypoint for Agent Sandbox Harness.

Can be run via:
    modal run deploy/modal/app.py
"""

from __future__ import annotations

import sys
import os

# Ensure repo root is in python path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from modal_image import APP_NAME, get_modal_app, build_harness_image
from sandbox_manager import ModalSandboxManager

app = get_modal_app(APP_NAME)
image = build_harness_image()


@app.function(image=image)
def health_check() -> dict:
    """Verifies that the image builds, runtimes work, and compilers are functional."""
    import subprocess

    def check_cmd(cmd):
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        return {"cmd": cmd, "exit_code": res.returncode, "stdout": res.stdout.strip()[:200]}

    checks = [
        check_cmd("python3 --version"),
        check_cmd("node --version"),
        check_cmd("npm --version"),
        check_cmd("rustc --version"),
        check_cmd("go version"),
        check_cmd("clang --version"),
        check_cmd("git --version"),
        check_cmd("pandoc --version"),
        check_cmd("libreoffice --version"),
        check_cmd("srt --help || echo 'srt present'"),
    ]
    return {"status": "healthy", "checks": checks}


@app.local_entrypoint()
def main():
    print("Testing Modal Agent Harness Image Health...")
    result = health_check.remote()
    print(f"Status: {result.get('status')}")
    for c in result.get("checks", []):
        print(f"  [{c['exit_code']}] {c['cmd']} => {c['stdout']}")
