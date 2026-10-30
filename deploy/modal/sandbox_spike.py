"""Phase 0 spike for the Modal sandbox harness.

This is intentionally throwaway validation, not the production manager. It
answers the four questions that decide whether the full architecture is viable:

1. Do ``bubblewrap`` and Anthropic's ``srt`` work inside a ``runtime="vm"``
   Modal Sandbox?
2. Does Playwright Chromium launch and render a page there?
3. Does ``snapshot_filesystem()`` / ``Image.from_id()`` round-trip state?
4. Do ``copy_from_local`` / ``copy_to_local`` and dynamic network policies work?

Run with:

    modal run deploy/modal/sandbox_spike.py

The image is deliberately small. It is not the production toolchain image.
"""

from __future__ import annotations

import json
import tempfile
import time
from pathlib import Path

import modal

APP_NAME = "openharness-sandbox-spike"

app = modal.App(APP_NAME)

image = (
    modal.Image.from_registry("ubuntu:24.04", add_python="3.12")
    .apt_install(
        "bubblewrap",
        "socat",
        "curl",
        "ca-certificates",
        "git",
        "ripgrep",
        "xvfb",
    )
    # Node 22: Ubuntu 24.04's apt nodejs is 18.x, which is too old for the
    # current MCP servers and Playwright tooling.
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
        "npm install -g @anthropic-ai/sandbox-runtime",
    )
    .pip_install("playwright")
    # The env must be set before `playwright install`, otherwise the browsers
    # land in /root/.cache/ms-playwright and the runtime path is empty.
    .env(
        {
            "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
            "PYTHONUNBUFFERED": "1",
        }
    )
    .run_commands(
        "python -m playwright install --with-deps chromium",
    )
)

OFFLINE_SRT = {
    "network": {
        "allowedDomains": [],
        "deniedDomains": [],
        "allowLocalBinding": True,
    },
    "filesystem": {
        "denyRead": ["/root", "/etc/shadow"],
        "allowWrite": ["/mnt/data", "/tmp"],
        "denyWrite": ["/etc", "/usr", "/bin", "/mnt/mcp_servers"],
    },
}

CONNECTED_SRT = {
    "network": {
        "allowedDomains": ["example.com"],
        "deniedDomains": [],
        "allowLocalBinding": True,
    },
    "filesystem": {
        "denyRead": ["/root", "/etc/shadow"],
        "allowWrite": ["/mnt/data", "/tmp"],
        "denyWrite": ["/etc", "/usr", "/bin", "/mnt/mcp_servers"],
    },
}


def _create_sandbox(**overrides):
    params = {
        "app": app,
        "image": image,
        "runtime": "vm",
        "cpu": 2.0,
        "memory": 4096,
        "timeout": 1800,
        "idle_timeout": 600,
        "workdir": "/mnt/data",
        "outbound_domain_allowlist": ["*"],
        "outbound_cidr_allowlist": ["0.0.0.0/0"],
        "encrypted_ports": [3000, 8080],
        "tags": {"phase": "0", "harness": "sandbox-spike"},
    }
    params.update(overrides)
    return modal.Sandbox.create("sleep", "infinity", **params)


def _run(sb, name, command, results, timeout=120):
    started = time.monotonic()
    proc = sb.exec("bash", "-lc", command, workdir="/mnt/data", timeout=timeout)
    proc.wait()
    results[name] = {
        "exit": proc.returncode,
        "duration_ms": round((time.monotonic() - started) * 1000),
        "stdout": proc.stdout.read()[-6000:],
        "stderr": proc.stderr.read()[-6000:],
    }
    return results[name]


@app.local_entrypoint()
def main():
    results: dict[str, object] = {}
    snapshot_image = None
    sb = _create_sandbox()
    local_upload = Path(tempfile.gettempdir()) / "oh-spike-upload.txt"
    local_download = Path(tempfile.gettempdir()) / "oh-spike-download.txt"
    local_upload.write_text("phase0 upload\n", encoding="utf-8")

    try:
        _run(
            sb,
            "environment",
            "set -x; uname -a; id; bwrap --version; srt --version; "
            "python --version; node --version; python -c 'import playwright; print(\"playwright import ok\")'",
            results,
        )

        _run(
            sb,
            "bwrap",
            "bwrap --ro-bind / / --dev /dev --proc /proc --unshare-net "
            "--die-with-parent echo bwrap-ok",
            results,
        )

        # Write the srt profiles at runtime so config changes do not require an
        # image rebuild while spiking.
        setup = f"""
mkdir -p /etc/srt /mnt/data /mnt/mcp_servers
cat > /etc/srt/offline.json <<'EOF'
{json.dumps(OFFLINE_SRT, indent=2)}
EOF
cat > /etc/srt/connected.json <<'EOF'
{json.dumps(CONNECTED_SRT, indent=2)}
EOF
ls -l /etc/srt
"""
        _run(sb, "srt_setup", setup, results)

        _run(
            sb,
            "srt_offline_blocked",
            "srt --settings /etc/srt/offline.json -- "
            "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://example.com",
            results,
        )

        _run(
            sb,
            "srt_connected_allowed",
            "srt --settings /etc/srt/connected.json -- "
            "curl -sS -m 20 -o /dev/null -w '%{http_code}' https://example.com",
            results,
        )

        _run(
            sb,
            "srt_connected_other_blocked",
            "srt --settings /etc/srt/connected.json -- "
            "curl -sS -m 10 -o /dev/null -w '%{http_code}' https://www.google.com",
            results,
        )

        _run(
            sb,
            "playwright",
            """
python - <<'PY'
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto("https://example.com", timeout=30000)
    body = page.locator("body").inner_text()
    print("title:", page.title())
    print("body:", body[:160].replace("\\n", " "))
    assert "documentation examples" in body, body[:200]
    browser.close()
PY
""",
            results,
            timeout=180,
        )

        # Dynamic network policy: narrow from allow-all to example.com only.
        sb._experimental_set_outbound_network_policy(
            outbound_domain_allowlist=["example.com"],
            outbound_cidr_allowlist=[],
        )
        _run(
            sb,
            "dynamic_policy_allowed",
            "curl -sS -m 15 -o /dev/null -w '%{http_code}' https://example.com",
            results,
        )
        _run(
            sb,
            "dynamic_policy_blocked",
            "curl -sS -m 15 -o /dev/null -w '%{http_code}' https://www.google.com",
            results,
        )
        sb._experimental_set_outbound_network_policy(
            outbound_domain_allowlist=["*"],
            outbound_cidr_allowlist=["0.0.0.0/0"],
        )

        # File transfer both ways.
        sb.filesystem.copy_from_local(str(local_upload), "/mnt/data/upload.txt")
        _run(sb, "uploaded_file", "cat /mnt/data/upload.txt", results)
        sb.filesystem.copy_to_local("/mnt/data/upload.txt", str(local_download))
        results["downloaded_file"] = {
            "path": str(local_download),
            "contents": local_download.read_text(encoding="utf-8"),
        }

        # Snapshot the root filesystem, then restore it in a fresh Sandbox.
        _run(
            sb,
            "snapshot_write",
            "printf 'phase0 snapshot\\n' > /mnt/data/snapshot_probe.txt && "
            "cat /mnt/data/snapshot_probe.txt",
            results,
        )
        snapshot_image = sb.snapshot_filesystem(timeout=180)
        results["snapshot"] = {"image_id": snapshot_image.object_id}
    finally:
        sb.terminate()

    if snapshot_image is not None:
        sb2 = _create_sandbox(
            image=snapshot_image,
            cpu=1.0,
            memory=2048,
            timeout=600,
            idle_timeout=300,
        )
        try:
            _run(
                sb2,
                "snapshot_restore",
                "cat /mnt/data/snapshot_probe.txt",
                results,
            )
        finally:
            sb2.terminate()

    print("\n=== PHASE 0 RESULTS ===")
    print(json.dumps(results, indent=2))
    return results
