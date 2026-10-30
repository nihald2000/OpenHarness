"""In-sandbox execution helper for Agent Code-Mode scripts."""

from __future__ import annotations

import io
import os
import sys
import time
import traceback
from typing import Any, Dict, Optional


def run_code_script(code_content: str, workdir: str = "/mnt/data") -> Dict[str, Any]:
    """Executes a Python code-mode script string in an isolated context and captures output.
    
    Returns:
        dict with stdout, stderr, exit_code, duration_ms, and artifacts
    """
    if not os.path.exists(workdir):
        os.makedirs(workdir, exist_ok=True)
    os.chdir(workdir)

    stdout_capture = io.StringIO()
    stderr_capture = io.StringIO()
    old_stdout = sys.stdout
    old_stderr = sys.stderr

    start_time = time.perf_counter()
    exit_code = 0
    error_message: Optional[str] = None

    # Track files before execution to detect newly created artifacts
    before_files = set(os.listdir(workdir)) if os.path.exists(workdir) else set()

    try:
        sys.stdout = stdout_capture
        sys.stderr = stderr_capture

        # Execute in dedicated globals with mcp_servers importable
        exec_globals = {
            "__name__": "__main__",
            "__file__": os.path.join(workdir, "agent_run.py"),
        }
        exec(code_content, exec_globals)

    except SystemExit as exc:
        exit_code = exc.code if isinstance(exc.code, int) else (0 if exc.code is None else 1)
    except Exception as exc:
        exit_code = 1
        error_message = str(exc)
        traceback.print_exc(file=stderr_capture)
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    duration_ms = (time.perf_counter() - start_time) * 1000

    after_files = set(os.listdir(workdir)) if os.path.exists(workdir) else set()
    new_artifacts = sorted(list(after_files - before_files))

    return {
        "stdout": stdout_capture.getvalue(),
        "stderr": stderr_capture.getvalue(),
        "exit_code": exit_code,
        "error": error_message,
        "duration_ms": round(duration_ms, 2),
        "new_artifacts": new_artifacts,
        "workdir": workdir,
    }
