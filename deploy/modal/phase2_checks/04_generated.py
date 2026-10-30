"""Check 4: generated wrappers import and call a tool end to end."""

from __future__ import annotations

import json
import sys

sys.path.insert(0, "/mnt/mcp_servers")

import _generated_playwright as generated  # noqa: E402


def main() -> int:
    out: dict = {
        "tool_count": len(generated.TOOLS),
        "has_navigate": "browser_navigate" in generated.TOOLS,
        "has_snapshot": "browser_snapshot" in generated.TOOLS,
        "sample": generated.TOOLS[:6],
    }

    nav = generated.browser_navigate(url="https://example.com")
    out["navigate"] = {
        "is_error": nav.get("is_error"),
        "chars": len(nav.get("text", "")),
        "head": nav.get("text", "")[:120],
    }

    title = generated.browser_evaluate(function="() => document.title")
    out["title"] = title.get("text", "")[:120]

    snap = generated.browser_snapshot(depth=2)
    out["snapshot"] = {
        "is_error": snap.get("is_error"),
        "chars": len(snap.get("text", "")),
    }

    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
