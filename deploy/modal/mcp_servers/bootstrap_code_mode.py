"""In-sandbox bootstrap for the code-mode bridge.

Idempotent. Run it once after the sandbox starts (or after a snapshot restore)
to bring up MCP daemons, generate typed wrappers, and write ``index.json``::

    python /mnt/mcp_servers/bootstrap_code_mode.py
    python /mnt/mcp_servers/bootstrap_code_mode.py --server playwright --no-start

Output is a single JSON object so the host can log it without parsing prose.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from client import (  # noqa: E402
    MCPBridgeError,
    default_specs,
    ensure_daemon,
    list_tools,
    log_path,
    read_ready,
)
from code_mode import build_index, emit_wrappers, render_summary  # noqa: E402

WORKSPACE = Path(os.environ.get("OH_WORKSPACE", "/mnt/data"))
ARTIFACTS = Path(os.environ.get("OH_ARTIFACT_DIR", str(WORKSPACE / "artifacts")))
SKILLS = HERE / "skills"


def _dirs() -> dict[str, str]:
    created = {}
    for path in (HERE, WORKSPACE, ARTIFACTS, SKILLS):
        path.mkdir(parents=True, exist_ok=True)
        created[path.name] = str(path)
    return created


def bootstrap(servers: list[str] | None = None, *, start: bool = True) -> dict:
    report: dict = {
        "ok": True,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "dirs": _dirs(),
        "servers": {},
        "modules": {},
        "errors": [],
    }

    specs = default_specs()
    names = servers or ["playwright"]

    index_servers: dict = {}
    modules: dict[str, str] = {}

    for name in names:
        if name not in specs:
            report["errors"].append(f"unknown server {name!r}")
            continue

        spec = specs[name]
        entry: dict = {
            "command": [spec.command, *spec.args],
            "log": str(log_path(name)),
        }

        if shutil.which(spec.command) is None and not os.path.isabs(spec.command):
            entry.update({"ready": False, "error": f"{spec.command} not on PATH"})
            report["servers"][name] = entry
            report["ok"] = False
            report["errors"].append(f"{name}: {spec.command} not found")
            continue

        if not start:
            ready = read_ready(name) or {}
            entry.update({"ready": bool(ready), "tools": ready.get("tools", [])})
            report["servers"][name] = entry
            if not ready:
                continue
        else:
            try:
                ready = ensure_daemon(spec)
                tools = list_tools(name)
                entry.update(
                    {
                        "ready": True,
                        "pid": ready.get("pid"),
                        "tools": [tool["name"] for tool in tools],
                        "tool_count": len(tools),
                    }
                )
                index_servers[name] = {
                    "transport": "stdio",
                    "command": [spec.command, *spec.args],
                    "tools": tools,
                }
                module = emit_wrappers(name, tools, HERE)
                modules[name] = f"generated from {name}; {len(tools)} functions ({module.name})"
                entry["wrapper"] = str(module)
            except (MCPBridgeError, OSError) as exc:
                entry.update({"ready": False, "error": str(exc)})
                report["ok"] = False
                report["errors"].append(f"{name}: {exc}")
                report["servers"][name] = entry
                continue

        report["servers"][name] = entry

    if not start:
        # Regenerate the index from whatever is already running.
        for name, spec in specs.items():
            if name not in names:
                continue
            try:
                tools = list_tools(name)
            except MCPBridgeError:
                continue
            index_servers[name] = {
                "transport": "stdio",
                "command": [spec.command, *spec.args],
                "tools": tools,
            }
            modules[name] = f"generated from {name}; {len(tools)} functions"

    modules.update(
        {
            "filesystem": "workspace-confined file I/O under /mnt/data",
            "github": "gh CLI + REST wrappers; writes need a broker-issued token",
            "skills": "agent-writable verified workflows (snapshot this directory)",
        }
    )

    index_path = HERE / "index.json"
    index = build_index(
        index_servers,
        out_path=index_path,
        modules=modules,
        pythonpath=str(HERE),
    )
    report["index"] = str(index_path)
    report["index_bytes"] = index_path.stat().st_size
    report["summary"] = render_summary(index)

    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", action="append", default=None)
    parser.add_argument("--no-start", action="store_true", help="do not launch daemons")
    args = parser.parse_args(argv)

    try:
        report = bootstrap(args.server, start=not args.no_start)
    except Exception as exc:  # noqa: BLE001 - the host needs the traceback
        report = {
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc()[-4000:],
        }

    print(json.dumps(report, indent=2))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
