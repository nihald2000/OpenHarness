"""Phase 2 validation: the /mnt/mcp_servers code-mode bridge.

Builds a sandbox image with Playwright MCP, axe-core, gh, and the bridge, then
runs the checks in separate ``sb.exec`` calls so the persistent MCP daemon is
actually exercised:

1. bootstrap_code_mode.py starts the daemon and generates index.json
2. a *separate* exec confirms the daemon survived the exec that started it
3. browser navigate / snapshot filtering / click / type / screenshot / axe
4. generated wrappers import and call a tool
5. GitHub reads (unauthenticated), write dry-run, fail-closed code search
6. filesystem confinement + skills persistence via snapshot_directory

Run with::

    modal run deploy/modal/phase2_bridge.py
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
APP_NAME = "openharness-phase2-bridge"

app = modal.App(APP_NAME)

CHECKS = HERE / "phase2_checks"
SERVERS = HERE / "mcp_servers"

image = (
    modal.Image.from_registry("ubuntu:24.04", add_python="3.12")
    .apt_install(
        "curl",
        "ca-certificates",
        "git",
        "gh",
        "jq",
        "ripgrep",
        "bubblewrap",
        "socat",
        "xvfb",
        "unzip",
        "fonts-liberation",
        "fonts-noto-color-emoji",
    )
    # Node 22: Ubuntu 24.04 ships Node 18, which is too old for @playwright/mcp.
    .run_commands(
        "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -",
        "apt-get install -y nodejs",
        "npm install -g @playwright/mcp@0.0.83 axe-core@4.14.0",
    )
    # The env must be set before `playwright install`, or browsers land in
    # /root/.cache and the MCP server cannot find them.
    .env(
        {
            "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
            "PYTHONUNBUFFERED": "1",
            "PYTHONPATH": "/mnt/mcp_servers",
            "OH_WORKSPACE": "/mnt/data",
            "OH_ARTIFACT_DIR": "/mnt/data/artifacts",
        }
    )
    .run_commands(
        # Match the revision pinned by @playwright/mcp so the MCP server finds it.
        "npx --yes playwright@1.64.0-alpha-1790635538000 install --with-deps chromium",
        "mkdir -p /mnt/mcp_servers /mnt/data/artifacts /mnt/data/checks",
    )
    # mcp 1.9.0 imports `eval_type_backport` from pydantic internals, which was
    # removed in pydantic 2.12. Pin the pair that is verified to work.
    .pip_install("mcp==1.9.0", "pydantic==2.11.5", "pyyaml")
    .add_local_dir(str(SERVERS), remote_path="/mnt/mcp_servers", copy=True)
    .add_local_dir(str(CHECKS), remote_path="/mnt/data/checks", copy=True)
)

SANDBOX_ENV = {
    "PYTHONPATH": "/mnt/mcp_servers",
    "PYTHONUNBUFFERED": "1",
    "OH_WORKSPACE": "/mnt/data",
    "OH_ARTIFACT_DIR": "/mnt/data/artifacts",
}


def _create(**overrides):
    params = {
        "app": app,
        "image": image,
        "runtime": "vm",
        "cpu": 2.0,
        "memory": 4096,
        "timeout": 2400,
        "idle_timeout": 900,
        "workdir": "/mnt/data",
        "env": SANDBOX_ENV,
        "outbound_domain_allowlist": ["*"],
        "outbound_cidr_allowlist": ["0.0.0.0/0"],
        "tags": {"phase": "2", "harness": "code-mode-mcp"},
    }
    params.update(overrides)
    return modal.Sandbox.create("sleep", "infinity", **params)


def _run(sb, name, command, results, timeout=300):
    started = time.monotonic()
    proc = sb.exec("bash", "-lc", command, workdir="/mnt/data", env=SANDBOX_ENV, timeout=timeout)
    proc.wait()
    entry = {
        "exit": proc.returncode,
        "duration_ms": round((time.monotonic() - started) * 1000),
        "stdout": proc.stdout.read()[-14000:],
        "stderr": proc.stderr.read()[-6000:],
    }
    results[name] = entry
    # Echo progress so an aborted run still leaves useful logs.
    print(f"\n--- {name} exit={entry['exit']} {entry['duration_ms']}ms ---")
    print(entry["stdout"])
    if entry["stderr"].strip():
        print("STDERR:", entry["stderr"][-2000:])
    return entry


def _json_stdout(entry: dict):
    try:
        return json.loads(entry.get("stdout") or "")
    except json.JSONDecodeError:
        return None


@app.local_entrypoint()
def main():
    results: dict[str, object] = {}
    sb = _create()
    snapshot = None

    try:
        bootstrap = _run(
            sb,
            "bootstrap",
            "cd /mnt/mcp_servers && python bootstrap_code_mode.py --server playwright",
            results,
            timeout=420,
        )
        boot_json = _json_stdout(bootstrap) or {}
        daemon_pid = (boot_json.get("servers", {}).get("playwright") or {}).get("pid")
        results["bootstrap_summary"] = {
            "ok": boot_json.get("ok"),
            "errors": boot_json.get("errors"),
            "tools": len((boot_json.get("servers", {}).get("playwright") or {}).get("tools", [])),
            "daemon_pid": daemon_pid,
            "index_bytes": boot_json.get("index_bytes"),
        }

        # Separate exec: proves the daemon outlived the exec that spawned it.
        persist = _run(
            sb,
            "daemon_persist",
            "cd /mnt/mcp_servers && python client.py status --name playwright",
            results,
        )
        status_json = _json_stdout(persist) or {}
        results["daemon_persist_summary"] = {
            "running": status_json.get("running"),
            "pid": (status_json.get("ready") or {}).get("pid"),
            "same_pid": (status_json.get("ready") or {}).get("pid") == daemon_pid,
        }

        _run(sb, "browser", "python /mnt/data/checks/01_browser.py", results, timeout=420)
        _run(sb, "generated", "python /mnt/data/checks/04_generated.py", results, timeout=300)
        _run(sb, "github", "python /mnt/data/checks/02_github.py", results, timeout=300)
        _run(sb, "workspace", "python /mnt/data/checks/03_workspace.py", results, timeout=180)

        snapshot = sb.snapshot_directory("/mnt/mcp_servers/skills", timeout=120)
        results["skills_snapshot"] = {"image_id": snapshot.object_id}
    finally:
        sb.terminate()

    if snapshot is not None:
        # Directory snapshots are not bootable images: mount one into a normal
        # sandbox at the original path. Using image=Image.from_id(dir_snapshot)
        # produces a sandbox that shuts down immediately.
        sb2 = _create(cpu=1.0, memory=2048, timeout=600, idle_timeout=300)
        try:
            sb2.mount_image("/mnt/mcp_servers/skills", snapshot)
            restore = (
                "import json, pathlib;"
                "p = pathlib.Path('/mnt/mcp_servers/skills/greet.py');"
                "print(json.dumps({'exists': p.is_file(),"
                " 'bytes': p.stat().st_size if p.is_file() else 0,"
                " 'files': sorted(x.name for x in p.parent.glob('*.py'))}))"
            )
            _run(sb2, "skills_restore", f"python -c {json.dumps(restore)}", results, timeout=120)
        except Exception as exc:  # noqa: BLE001 - recorded, not fatal
            results["skills_restore_error"] = f"{type(exc).__name__}: {exc}"
            print(f"\n--- skills_restore FAILED: {type(exc).__name__}: {exc}")
        finally:
            sb2.terminate()

    print("\n=== PHASE 2 RESULTS ===")
    print(json.dumps(results, indent=2))
    return results
