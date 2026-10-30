"""Bootstrap script executed inside the sandbox to link and initialize MCP modules."""

from __future__ import annotations

import os
import sys
import shutil
from pathlib import Path


MCP_ROOT = Path("/mnt/mcp_servers")
DATA_ROOT = Path("/mnt/data")


def bootstrap() -> dict:
    """Sets up directories, sys.path hooks, and verification markers."""
    status = {"created_dirs": [], "python_path_updated": False, "ok": True}

    # Ensure directories exist
    for directory in [MCP_ROOT, DATA_ROOT, Path("/tmp")]:
        if not directory.exists():
            directory.mkdir(parents=True, exist_ok=True)
            status["created_dirs"].append(str(directory))

    # Add MCP_ROOT to default python site-packages / .pth file if possible
    pth_file = Path("/usr/local/lib/python3.12/dist-packages/mcp_servers.pth")
    try:
        if pth_file.parent.exists():
            pth_file.write_text("/mnt\n", encoding="utf-8")
            status["python_path_updated"] = True
    except Exception:
        # Fallback to appending sys.path
        if "/mnt" not in sys.path:
            sys.path.insert(0, "/mnt")

    # Set default agent cwd tracker if missing
    cwd_marker = Path("/tmp/.agent_cwd")
    if not cwd_marker.exists():
        cwd_marker.write_text(str(DATA_ROOT), encoding="utf-8")

    return status


if __name__ == "__main__":
    result = bootstrap()
    print(f"[BOOTSTRAP] Code mode initialized: {result}")
