"""Workspace-confined file helpers for code mode.

The agent already runs Python inside the sandbox, so a filesystem MCP server
would add a subprocess and a schema for no benefit. What it does not get from
``open()`` is a hard boundary and output truncation, which is what this module
provides.

Every path resolves under ``OH_WORKSPACE`` (default ``/mnt/data``). Escapes via
``..``, absolute paths outside the root, and symlinks pointing outside the root
raise ``PathEscape``.

    from filesystem import write_text, list_dir, glob

    write_text("notes/todo.md", "# TODO\n")
    list_dir(".")
"""

from __future__ import annotations

import fnmatch
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Iterable

ROOT = Path(os.environ.get("OH_WORKSPACE", "/mnt/data")).resolve()
MAX_READ_BYTES = int(os.environ.get("OH_FS_MAX_READ_BYTES", "200000"))
MAX_ENTRIES = int(os.environ.get("OH_FS_MAX_ENTRIES", "200"))


class PathEscape(ValueError):
    """Raised when a path resolves outside the workspace root."""


def resolve(path: str | os.PathLike[str]) -> Path:
    """Resolve ``path`` under the workspace root, or raise ``PathEscape``."""

    candidate = Path(path)
    if not candidate.is_absolute():
        candidate = ROOT / candidate

    # Resolve symlinks and ``..`` before comparing, so a symlink cannot point
    # outside the root.
    resolved = candidate.resolve()
    root = ROOT
    if resolved != root and root not in resolved.parents:
        raise PathEscape(f"{path!r} resolves to {resolved}, outside {root}")
    return resolved


def _display(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def read_text(path: str, *, max_bytes: int = MAX_READ_BYTES, encoding: str = "utf-8") -> dict[str, Any]:
    target = resolve(path)
    if not target.is_file():
        raise FileNotFoundError(f"no such file: {path}")
    raw = target.read_bytes()
    truncated = len(raw) > max_bytes
    text = raw[:max_bytes].decode(encoding, errors="replace")
    return {
        "path": _display(target),
        "text": text,
        "bytes": len(raw),
        "truncated": truncated,
    }


def read_bytes(path: str, *, max_bytes: int = MAX_READ_BYTES) -> bytes:
    target = resolve(path)
    with open(target, "rb") as handle:
        return handle.read(max_bytes)


def write_text(
    path: str,
    text: str,
    *,
    append: bool = False,
    encoding: str = "utf-8",
) -> dict[str, Any]:
    target = resolve(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    mode = "a" if append else "w"
    with open(target, mode, encoding=encoding) as handle:
        handle.write(text)
    return {"path": _display(target), "bytes": target.stat().st_size, "appended": append}


def write_bytes(path: str, data: bytes) -> dict[str, Any]:
    target = resolve(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    return {"path": _display(target), "bytes": len(data)}


def list_dir(path: str = ".", *, max_entries: int = MAX_ENTRIES) -> list[dict[str, Any]]:
    target = resolve(path)
    if not target.is_dir():
        raise NotADirectoryError(f"not a directory: {path}")

    entries = []
    for child in sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name)):
        try:
            stat = child.stat()
        except OSError:
            continue
        entries.append(
            {
                "name": child.name,
                "path": _display(child),
                "type": "dir" if child.is_dir() else "file",
                "bytes": stat.st_size if child.is_file() else None,
            }
        )
        if len(entries) >= max_entries:
            break
    return entries


def glob(pattern: str, *, max_results: int = MAX_ENTRIES) -> list[str]:
    """Glob relative to the workspace root, staying inside it."""

    matches: list[str] = []
    for path in ROOT.glob(pattern):
        try:
            matches.append(_display(resolve(path)))
        except PathEscape:
            continue
        if len(matches) >= max_results:
            break
    return sorted(matches)


def find_files(name_pattern: str, *, max_results: int = MAX_ENTRIES) -> list[str]:
    """Match filenames with ``fnmatch`` anywhere under the workspace."""

    matches: list[str] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules", "__pycache__"}]
        for filename in filenames:
            if fnmatch.fnmatch(filename, name_pattern):
                matches.append(_display(Path(dirpath) / filename))
                if len(matches) >= max_results:
                    return sorted(matches)
    return sorted(matches)


def search(
    pattern: str,
    *,
    path: str = ".",
    max_results: int = 100,
    glob: str | None = None,
) -> dict[str, Any]:
    """Search file contents with ripgrep when available, else Python."""

    target = resolve(path)
    rg = shutil.which("rg")
    if rg:
        command = [rg, "--line-number", "--no-heading", "--color", "never", "--max-count", "20"]
        if glob:
            command.extend(["--glob", glob])
        command.extend([pattern, str(target)])
        proc = subprocess.run(command, capture_output=True, text=True, timeout=60, check=False)
        lines = [line for line in proc.stdout.splitlines() if line.strip()]
        return {
            "engine": "rg",
            "matches": lines[:max_results],
            "count": len(lines),
            "truncated": len(lines) > max_results,
        }

    matches: list[str] = []
    for dirpath, dirnames, filenames in os.walk(target):
        dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules", "__pycache__"}]
        for filename in filenames:
            file_path = Path(dirpath) / filename
            try:
                text = file_path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for number, line in enumerate(text.splitlines(), start=1):
                if pattern in line:
                    matches.append(f"{_display(file_path)}:{number}:{line.strip()[:200]}")
                    if len(matches) >= max_results:
                        return {
                            "engine": "python",
                            "matches": matches,
                            "count": len(matches),
                            "truncated": True,
                        }
    return {"engine": "python", "matches": matches, "count": len(matches), "truncated": False}


def stat(path: str) -> dict[str, Any]:
    target = resolve(path)
    info = target.stat()
    return {
        "path": _display(target),
        "type": "dir" if target.is_dir() else "file",
        "bytes": info.st_size,
        "modified": info.st_mtime,
    }


def mkdir(path: str) -> dict[str, Any]:
    target = resolve(path)
    target.mkdir(parents=True, exist_ok=True)
    return {"path": _display(target), "created": True}


def remove(path: str, *, recursive: bool = False) -> dict[str, Any]:
    target = resolve(path)
    if target == ROOT:
        raise PathEscape("refusing to remove the workspace root")
    if target.is_dir():
        if not recursive:
            raise IsADirectoryError(f"{path} is a directory; pass recursive=True")
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    return {"path": _display(target), "removed": True}


def copy(src: str, dst: str) -> dict[str, Any]:
    source = resolve(src)
    destination = resolve(dst)
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination, dirs_exist_ok=True)
    else:
        shutil.copy2(source, destination)
    return {"src": _display(source), "dst": _display(destination)}


def move(src: str, dst: str) -> dict[str, Any]:
    source = resolve(src)
    destination = resolve(dst)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(destination))
    return {"src": _display(source), "dst": _display(destination)}


def tree(path: str = ".", *, max_depth: int = 3, max_entries: int = MAX_ENTRIES) -> list[str]:
    """Compact directory listing as ``path/`` + indented children."""

    root = resolve(path)
    lines: list[str] = []

    def walk(directory: Path, depth: int) -> None:
        if depth > max_depth or len(lines) >= max_entries:
            return
        try:
            children = sorted(directory.iterdir(), key=lambda item: (not item.is_dir(), item.name))
        except OSError:
            return
        for child in children:
            if child.name in {".git", "node_modules", "__pycache__"}:
                continue
            suffix = "/" if child.is_dir() else ""
            lines.append(f"{'  ' * depth}{_display(child)}{suffix}")
            if child.is_dir():
                walk(child, depth + 1)
            if len(lines) >= max_entries:
                return

    walk(root, 0)
    return lines


__all__ = [
    "ROOT",
    "PathEscape",
    "resolve",
    "read_text",
    "read_bytes",
    "write_text",
    "write_bytes",
    "list_dir",
    "glob",
    "find_files",
    "search",
    "stat",
    "mkdir",
    "remove",
    "copy",
    "move",
    "tree",
]
