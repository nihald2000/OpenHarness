"""Agent-writable store for verified multi-step workflows.

A skill is a plain Python file with a module docstring (its description) and an
optional ``run(**kwargs)`` entry point. Skills are written by the agent only
after a workflow has been executed successfully, so replaying one is cheaper
than rediscovering the steps.

Persist this directory across sessions with
``sb.snapshot_directory("/mnt/mcp_servers/skills")`` (or a Modal Volume).

    from skills import save, list_skills, run

    save("hn_top", "'''Top Hacker News titles.'''\\nfrom playwright import navigate\\n\\ndef run(limit=5): ...")
    list_skills()
    run("hn_top", limit=3)
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import time
from pathlib import Path
from typing import Any

SKILLS_DIR = Path(os.environ.get("OH_SKILLS_DIR", "/mnt/mcp_servers/skills"))
_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{1,60}$")


class SkillError(ValueError):
    pass


def _path(name: str) -> Path:
    if not _NAME_RE.match(name or ""):
        raise SkillError(
            f"invalid skill name {name!r}; use lowercase letters, digits, and underscores"
        )
    return SKILLS_DIR / f"{name}.py"


def _description(source: str) -> str:
    match = re.search(r'^\s*"""(.+?)"""', source, re.S)
    if not match:
        return ""
    return " ".join(match.group(1).split())[:200]


def list_skills() -> list[dict[str, Any]]:
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    skills = []
    for path in sorted(SKILLS_DIR.glob("*.py")):
        if path.name.startswith("_"):
            continue
        try:
            source = path.read_text(encoding="utf-8")
        except OSError:
            continue
        skills.append(
            {
                "name": path.stem,
                "description": _description(source),
                "bytes": path.stat().st_size,
                "has_run": bool(re.search(r"^def run\(", source, re.M)),
                "updated": time.strftime(
                    "%Y-%m-%dT%H:%M:%SZ", time.gmtime(path.stat().st_mtime)
                ),
            }
        )
    return skills


def save(
    name: str,
    code: str,
    *,
    description: str | None = None,
    overwrite: bool = True,
) -> dict[str, Any]:
    """Write a skill file. Adds a provenance header and a docstring if missing."""

    path = _path(name)
    if path.exists() and not overwrite:
        raise SkillError(f"skill {name!r} already exists")

    body = code.strip("\n")
    if description and not body.lstrip().startswith('"""'):
        body = f'"""{description}"""\n\n{body}'

    header = (
        f"# saved by code mode at {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
        f"# verify before reuse: skills are agent-written code\n\n"
    )
    SKILLS_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(header + body + "\n", encoding="utf-8")
    return {"name": name, "path": str(path), "bytes": path.stat().st_size}


def load(name: str) -> str:
    return _path(name).read_text(encoding="utf-8")


def delete(name: str) -> dict[str, Any]:
    path = _path(name)
    if path.exists():
        path.unlink()
    return {"name": name, "deleted": True}


def run(skill: str, **kwargs: Any) -> Any:
    """Import a skill and call its ``run(**kwargs)`` entry point."""

    path = _path(skill)
    if not path.is_file():
        raise SkillError(f"no such skill: {skill}")

    spec = importlib.util.spec_from_file_location(f"oh_skill_{skill}", path)
    if spec is None or spec.loader is None:
        raise SkillError(f"cannot load skill {skill}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    entry = getattr(module, "run", None)
    if not callable(entry):
        raise SkillError(f"skill {skill!r} has no run() function")
    return entry(**kwargs)


def index() -> str:
    return json.dumps(list_skills(), indent=2)


__all__ = ["SKILLS_DIR", "SkillError", "list_skills", "save", "load", "delete", "run", "index"]
