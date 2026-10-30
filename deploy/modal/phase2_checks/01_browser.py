"""Check 1: browser navigation, filtered snapshots, interaction, axe."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, "/mnt/mcp_servers")

from playwright import (  # noqa: E402
    evaluate,
    find,
    format_snapshot,
    navigate,
    run_axe_audit,
    screenshot,
    snapshot_dom,
    type_text,
)

SITE = Path("/mnt/data/checks/site")


def flatten(nodes, out):
    for node in nodes:
        out.append(node)
        flatten(node.get("children") or [], out)
    return out


def main() -> int:
    out: dict = {}
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", "8765", "--bind", "127.0.0.1"],
        cwd=str(SITE),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(1.5)
        page = navigate("http://127.0.0.1:8765/", max_nodes=80)
        out["navigate"] = {
            "ok": page.get("ok"),
            "url": page.get("url"),
            "title": page.get("title"),
            "count": page.get("count"),
            "truncated": page.get("truncated"),
        }

        snap = snapshot_dom(max_nodes=40)
        out["snapshot"] = {
            "count": snap["count"],
            "total_nodes": snap["total_nodes"],
            "lines": format_snapshot(snap).splitlines()[:12],
        }

        nodes = flatten(page.get("nodes") or [], [])
        textbox = next((node for node in nodes if node["role"] == "textbox"), None)
        out["textbox"] = textbox

        if textbox and textbox.get("ref"):
            type_text(textbox["ref"], "phase2", submit=True)
            out["result_text"] = evaluate("() => document.getElementById('out').textContent")

        out["find"] = find(text="Harness")["text"][:400]
        out["screenshot"] = screenshot()

        audit = run_axe_audit(max_violations=10)
        out["axe"] = {
            "ok": audit.get("ok"),
            "violation_count": audit.get("violation_count"),
            "ids": [violation["id"] for violation in audit.get("violations") or []],
            "url": audit.get("url"),
            "error": audit.get("error"),
            "raw": audit.get("raw"),
        }
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
