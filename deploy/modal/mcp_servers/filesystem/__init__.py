"""Filesystem MCP & Workspace Module for Anthropic Code-Mode Execution."""

from __future__ import annotations

import fnmatch
import os
import re
from pathlib import Path
from typing import Any, Dict, List, Optional


DEFAULT_WORKSPACE = "/mnt/data"


def _resolve_path(path: str, workspace: str = DEFAULT_WORKSPACE) -> Path:
    base = Path(workspace).resolve()
    target = (base / path).resolve() if not os.path.isabs(path) else Path(path).resolve()
    # Workspace containment check
    try:
        target.relative_to(base)
    except ValueError:
        # If outside workspace, check if it's within /mnt or /tmp (permitted sandbox areas)
        if not (str(target).startswith("/mnt/") or str(target).startswith("/tmp/")):
            raise PermissionError(f"Access denied: Path '{path}' is outside sandbox workspace '{workspace}'")
    return target


def read_file(path: str, offset: int = 0, limit: int = 100_000, workspace: str = DEFAULT_WORKSPACE) -> str:
    """Reads content from a file with bounded size protection."""
    target = _resolve_path(path, workspace)
    if not target.exists():
        raise FileNotFoundError(f"File not found: {path}")
    if target.is_dir():
        raise IsADirectoryError(f"Path is a directory: {path}")

    with open(target, "r", encoding="utf-8", errors="replace") as f:
        if offset > 0:
            f.seek(offset)
        content = f.read(limit)
    return content


def write_file(path: str, content: str, workspace: str = DEFAULT_WORKSPACE) -> Dict[str, Any]:
    """Writes content to a file, creating parent directories if needed."""
    target = _resolve_path(path, workspace)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        f.write(content)
    return {"path": str(target), "bytes_written": len(content.encode("utf-8")), "ok": True}


def list_directory(path: str = ".", workspace: str = DEFAULT_WORKSPACE) -> List[Dict[str, Any]]:
    """Lists files and directories with metadata."""
    target = _resolve_path(path, workspace)
    if not target.exists():
        raise FileNotFoundError(f"Directory not found: {path}")
    if not target.is_dir():
        raise NotADirectoryError(f"Path is not a directory: {path}")

    entries = []
    for item in sorted(target.iterdir()):
        stat = item.stat()
        entries.append({
            "name": item.name,
            "path": str(item),
            "is_dir": item.is_dir(),
            "size_bytes": stat.st_size if not item.is_dir() else 0,
            "modified": stat.st_mtime,
        })
    return entries


def search_files(pattern: str, path: str = ".", max_results: int = 50, workspace: str = DEFAULT_WORKSPACE) -> List[str]:
    """Finds files matching a glob pattern."""
    target = _resolve_path(path, workspace)
    matches = []
    for root, _, filenames in os.walk(target):
        for name in filenames:
            rel = os.path.relpath(os.path.join(root, name), start=str(target))
            if fnmatch.fnmatch(rel, pattern) or fnmatch.fnmatch(name, pattern):
                matches.append(rel)
                if len(matches) >= max_results:
                    return matches
    return matches


def grep_search(regex: str, path: str = ".", max_matches: int = 50, workspace: str = DEFAULT_WORKSPACE) -> List[Dict[str, Any]]:
    """Searches file contents for a regular expression."""
    target = _resolve_path(path, workspace)
    compiled = re.compile(regex)
    results = []

    for root, _, filenames in os.walk(target):
        for name in filenames:
            file_path = os.path.join(root, name)
            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    for line_no, line in enumerate(f, start=1):
                        if compiled.search(line):
                            results.append({
                                "file": os.path.relpath(file_path, start=str(target)),
                                "line_number": line_no,
                                "match": line.strip()[:200],
                            })
                            if len(results) >= max_matches:
                                return results
            except Exception:
                continue
    return results
