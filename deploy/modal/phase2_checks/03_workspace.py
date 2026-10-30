"""Check 3: workspace confinement, search, and agent-writable skills."""

from __future__ import annotations

import json
import sys

sys.path.insert(0, "/mnt/mcp_servers")

from filesystem import (  # noqa: E402
    PathEscape,
    glob,
    list_dir,
    read_text,
    search,
    tree,
    write_text,
)
from skills import list_skills, load, run, save  # noqa: E402


def main() -> int:
    out: dict = {}

    write_text("notes/todo.md", "# TODO\n- ship phase 2\n- verify the bridge\n")
    out["read"] = read_text("notes/todo.md")
    out["list"] = list_dir("notes")
    out["glob"] = glob("notes/*.md")
    out["search"] = search("phase 2", path="notes")
    out["tree"] = tree(".", max_depth=2, max_entries=15)

    try:
        read_text("../etc/passwd")
        out["escape"] = "NOT BLOCKED"
    except PathEscape as exc:
        out["escape"] = "blocked: " + str(exc)[:160]

    save(
        "greet",
        "def run(name='world'):\n    return 'hello ' + name\n",
        description="Return a greeting",
    )
    out["skills"] = list_skills()
    out["skill_run"] = run("greet", name="phase2")
    out["skill_source_head"] = load("greet").splitlines()[:3]

    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
