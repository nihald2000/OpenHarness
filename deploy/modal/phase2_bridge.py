"""Phase 2 Sandbox Bridge: End-to-End Orchestrator for Modal Sandboxes & MCP Code Execution.

This module provides the production bridge connecting OpenHarness agent runs
with the official Modal Sandbox VM environment, Anthropic Code-Mode MCP bridges,
and Phase 2 validation checks.
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

# Add repo root and deploy directory to sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEPLOY_DIR = Path(__file__).resolve().parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(DEPLOY_DIR) not in sys.path:
    sys.path.insert(0, str(DEPLOY_DIR))

from sandbox_manager import ModalSandboxManager, ExecutionResult
SandboxExecutionResult = ExecutionResult
from agent_tools import AgentToolExecutor


class Phase2SandboxBridge:
    """Production bridge managing Modal Sandboxes, MCP modules, and Phase 2 verification."""

    def __init__(
        self,
        tenant_id: str = "tenant-default",
        session_id: str = "session-default",
        app_name: str = "agent-harness",
        network_mode: Literal["connected", "github_only", "airgapped"] = "connected",
        image_id: Optional[str] = None,
        github_token: Optional[str] = None,
    ):
        self.tenant_id = tenant_id
        self.session_id = session_id
        self.network_mode = network_mode
        self.manager = ModalSandboxManager(
            tenant_id=tenant_id,
            session_id=session_id,
            app_name=app_name,
            github_token=github_token,
        )
        self.tool_executor = AgentToolExecutor(self.manager)
        self.is_bootstrapped = False
        self._image_id = image_id

    def initialize(self) -> Dict[str, Any]:
        """Creates or resumes the sandbox and ensures /mnt/mcp_servers is bootstrapped."""
        sb = self.manager.create(
            snapshot_id=self._image_id,
            network_mode=self.network_mode,
        )

        # Bootstrap in-sandbox layout
        self.tool_executor.bootstrap_sandbox()

        # Upload local check fixtures and on-disk mcp_servers to sandbox
        self._sync_mcp_servers_and_checks()
        self.is_bootstrapped = True

        return {
            "sandbox_id": sb.object_id if hasattr(sb, "object_id") else "mock-sb",
            "tenant_id": self.tenant_id,
            "session_id": self.session_id,
            "network_mode": self.network_mode,
            "status": "ready",
        }

    def _sync_mcp_servers_and_checks(self) -> None:
        """Uploads mcp_servers and phase2_checks to the sandbox."""
        mcp_servers_dir = DEPLOY_DIR / "mcp_servers"
        checks_dir = DEPLOY_DIR / "phase2_checks"

        # Transfer mcp_servers directory if available
        if mcp_servers_dir.exists():
            for root, _, files in os.walk(mcp_servers_dir):
                for f in files:
                    if f.endswith(".pyc") or "__pycache__" in root:
                        continue
                    local_p = os.path.join(root, f)
                    rel_p = os.path.relpath(local_p, str(mcp_servers_dir))
                    remote_p = f"/mnt/mcp_servers/{rel_p}"
                    self.manager.upload_file(local_p, remote_p)

        # Transfer checks directory if available
        if checks_dir.exists():
            for root, _, files in os.walk(checks_dir):
                for f in files:
                    if f.endswith(".pyc") or "__pycache__" in root:
                        continue
                    local_p = os.path.join(root, f)
                    rel_p = os.path.relpath(local_p, str(checks_dir))
                    remote_p = f"/mnt/data/phase2_checks/{rel_p}"
                    self.manager.upload_file(local_p, remote_p)

    def execute_code(self, code: str, timeout: int = 60) -> Dict[str, Any]:
        """Runs Python code using Anthropic's Code Mode paradigm."""
        return self.tool_executor.execute_sandbox_code(code, timeout=timeout)

    def switch_network_mode(self, mode: Literal["connected", "github_only", "airgapped"]) -> None:
        """Dynamically adjusts egress policies mid-flight."""
        self.manager.set_network_mode(mode)
        self.network_mode = mode

    def run_check(self, check_name: str) -> Dict[str, Any]:
        """Runs a designated Phase 2 verification check inside the sandbox.
        
        Args:
            check_name: One of '01_browser', '02_github', '03_workspace', '04_generated'
        """
        check_file = f"/mnt/data/phase2_checks/{check_name}.py"
        run_cmd = f"python3 {check_file}"

        t0 = time.perf_counter()
        exec_res = self.manager.exec(run_cmd, timeout=90)
        duration_ms = round((time.perf_counter() - t0) * 1000, 2)

        # Attempt to parse json from stdout
        parsed_data = {}
        for line in exec_res.stdout.splitlines():
            line_str = line.strip()
            if line_str.startswith("{") and line_str.endswith("}"):
                try:
                    parsed_data = json.loads(line_str)
                    break
                except json.JSONDecodeError:
                    continue

        return {
            "check": check_name,
            "exit_code": exec_res.exit_code,
            "duration_ms": duration_ms,
            "passed": exec_res.exit_code == 0 and parsed_data.get("passed", True),
            "output": exec_res.stdout,
            "errors": exec_res.stderr,
            "parsed": parsed_data,
        }

    def run_all_checks(self) -> Dict[str, Any]:
        """Executes the full suite of Phase 2 checks sequentially."""
        checks = ["01_browser", "02_github", "03_workspace", "04_generated"]
        summary = {
            "total": len(checks),
            "passed": 0,
            "failed": 0,
            "results": {},
            "all_passed": False,
        }

        for c in checks:
            res = self.run_check(c)
            summary["results"][c] = res
            if res["passed"]:
                summary["passed"] += 1
            else:
                summary["failed"] += 1

        summary["all_passed"] = (summary["failed"] == 0)
        return summary

    def hibernate(self, ttl_days: int = 7) -> str:
        """Captures zero-cost VM snapshot and terminates active sandbox."""
        return self.manager.hibernate_to_snapshot(ttl=ttl_days * 24 * 3600)

    def terminate(self) -> None:
        """Tears down sandbox resources."""
        self.manager.terminate()
