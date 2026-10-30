"""Production Host-Side Modal Sandbox Manager.

Manages execution, network mode switching, file transfers, persistent working state,
port tunnels, snapshots for hibernation, and tenant-scoped session sandboxes.
Strictly conforms to current official modal.Sandbox SDK signatures.
"""

from __future__ import annotations

import base64
import logging
import os
import shlex
import tempfile
import time
from typing import Any, Dict, List, Literal, Optional, Tuple

logger = logging.getLogger("modal_sandbox_manager")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO)

try:
    import modal
    HAS_MODAL = True
except ImportError:
    modal = None  # type: ignore
    HAS_MODAL = False

from mcp_code_bridge import get_mcp_server_files
from modal_image import APP_NAME, SANDBOX_WORKDIR, harness_image


NetworkMode = Literal["connected", "github_only", "airgapped"]

OUTPUT_TRUNCATION_LIMIT = 12000
DEFAULT_SESSION_TIMEOUT = 1800      # 30 min max session
DEFAULT_IDLE_TIMEOUT = 180          # 3 min inactivity auto-terminate
DEFAULT_COMMAND_TIMEOUT = 120       # 2 min per command execution


class ExecutionResult:
    """Encapsulates the standard output, standard error, exit code, and truncation status."""

    def __init__(self, stdout: str, stderr: str, exit_code: int, truncated: bool = False):
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code
        self.truncated = truncated

    @property
    def success(self) -> bool:
        return self.exit_code == 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "stdout": self.stdout,
            "stderr": self.stderr,
            "exit_code": self.exit_code,
            "success": self.success,
            "truncated": self.truncated,
        }


    def __str__(self) -> str:
        parts = []
        if self.stdout:
            parts.append(f"STDOUT:\n{self.stdout}")
        if self.stderr:
            parts.append(f"STDERR:\n{self.stderr}")
        parts.append(f"Exit Code: {self.exit_code}")
        if self.truncated:
            parts.append("(Output was truncated to 12,000 characters)")
        return "\n\n".join(parts)


SandboxExecutionResult = ExecutionResult


class ModalSandboxManager:
    """Production manager for Modal Sandboxes using the official modal.Sandbox API."""

    def __init__(
        self,
        app_name: str = APP_NAME,
        tenant_id: str = "default-tenant",
        session_id: Optional[str] = None,
        github_token: Optional[str] = None,
    ):
        self.app_name = app_name
        self.tenant_id = tenant_id
        self.session_id = session_id or f"session_{int(time.time())}"
        self.github_token = github_token or os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN") or os.environ.get("GH_TOKEN")
        self.app = None
        self.sandbox: Optional[modal.Sandbox] = None
        self.network_mode: NetworkMode = "connected"
        self._bootstrap_completed = False

    def _ensure_app(self):
        if not HAS_MODAL:
            raise RuntimeError("The 'modal' package is required. Install via 'pip install modal'.")
        if self.app is None:
            self.app = modal.App.lookup(self.app_name, create_if_missing=True)
        return self.app

    def create(
        self,
        snapshot_id: Optional[str] = None,
        network_mode: NetworkMode = "connected",
        cpu: float = 2.0,
        memory_mb: int = 4096,
        timeout: int = DEFAULT_SESSION_TIMEOUT,
        idle_timeout: int = DEFAULT_IDLE_TIMEOUT,
    ) -> modal.Sandbox:
        """Creates a new VM-backed sandbox conforming to the strict official Modal signatures."""
        self._ensure_app()

        image = modal.Image.from_id(snapshot_id) if snapshot_id else harness_image
        if image is None:
            raise RuntimeError("Harness image definition could not be resolved.")

        secrets = []
        if self.github_token:
            secrets.append(modal.Secret.from_dict({"GITHUB_PERSONAL_ACCESS_TOKEN": self.github_token}))

        # Establish initial network allowlists based on requested network_mode
        if network_mode == "airgapped":
            outbound_domain_allowlist: List[str] = []
            outbound_cidr_allowlist: List[str] = []
        elif network_mode == "github_only":
            outbound_domain_allowlist = ["github.com", "*.github.com", "*.githubusercontent.com"]
            outbound_cidr_allowlist = []
        else:
            outbound_domain_allowlist = ["*"]
            outbound_cidr_allowlist = ["0.0.0.0/0"]

        tags = {
            "env": "production",
            "harness": "code-mode-mcp",
            "tenant_id": self.tenant_id,
            "session_id": self.session_id,
            "network_mode": network_mode,
        }

        logger.info(
            f"Creating Modal VM sandbox for tenant='{self.tenant_id}', session='{self.session_id}', network='{network_mode}'"
        )

        sb = modal.Sandbox.create(
            "sleep", "infinity",
            app=self.app,
            image=image,
            runtime="vm",
            cpu=cpu,
            memory=memory_mb,
            timeout=timeout,
            idle_timeout=idle_timeout,
            workdir=SANDBOX_WORKDIR,
            encrypted_ports=[3000, 8080],
            outbound_domain_allowlist=outbound_domain_allowlist,
            outbound_cidr_allowlist=outbound_cidr_allowlist,
            secrets=secrets,
            tags=tags,
        )

        self.sandbox = sb
        self.network_mode = network_mode
        self._bootstrap_in_sandbox_mcp()
        return sb

    def reconnect(self, sandbox_id: str) -> modal.Sandbox:
        """Reconnects to an active sandbox instance from a previous worker turn or ID."""
        self._ensure_app()
        logger.info(f"Reconnecting to active sandbox ID: {sandbox_id}")
        self.sandbox = modal.Sandbox.from_id(sandbox_id)
        return self.sandbox

    def detach(self) -> None:
        """Detaches from the sandbox without terminating it (allowing subsequent reconnections)."""
        if self.sandbox is not None:
            try:
                self.sandbox.detach()
                logger.info(f"Detached from sandbox {self.sandbox.object_id}")
            except Exception as e:
                logger.warning(f"Error during detach: {e}")
            finally:
                self.sandbox = None

    def terminate(self) -> None:
        """Terminates and destroys the running sandbox."""
        if self.sandbox is not None:
            try:
                self.sandbox.terminate()
                logger.info("Sandbox successfully terminated.")
            except Exception as e:
                logger.warning(f"Error terminating sandbox: {e}")
            finally:
                self.sandbox = None

    def set_network_mode(self, mode: NetworkMode) -> None:
        """Dynamically switches network isolation mode for subsequent process executions."""
        if self.sandbox is None:
            raise RuntimeError("No active sandbox attached.")

        self.network_mode = mode
        logger.info(f"Setting sandbox network mode to: {mode}")

        # Attempt to invoke Modal's runtime network allowlist update if supported by SDK
        try:
            if hasattr(self.sandbox, "set_network_allowlist"):
                if mode == "airgapped":
                    self.sandbox.set_network_allowlist(outbound_domains=[], outbound_cidrs=[])
                elif mode == "github_only":
                    self.sandbox.set_network_allowlist(
                        outbound_domains=["github.com", "*.github.com", "*.githubusercontent.com"],
                        outbound_cidrs=[],
                    )
                else:
                    self.sandbox.set_network_allowlist(outbound_domains=["*"], outbound_cidrs=["0.0.0.0/0"])
        except Exception as e:
            logger.debug(f"Dynamic set_network_allowlist call: {e}")

    def _bootstrap_in_sandbox_mcp(self) -> None:
        """Populates the /mnt/mcp_servers directory layout in the sandbox."""
        if self._bootstrap_completed or self.sandbox is None:
            return

        logger.info("Bootstrapping /mnt/mcp_servers code-mode bridges inside sandbox...")
        files = get_mcp_server_files()

        for rel_path, content in files.items():
            full_path = f"/mnt/mcp_servers/{rel_path}"
            parent_dir = os.path.dirname(full_path)
            # Write file using base64 decoding inside bash to handle formatting and characters cleanly
            b64_content = base64.b64encode(content.encode("utf-8")).decode("ascii")
            setup_cmd = f"mkdir -p {parent_dir} && echo {b64_content} | base64 -d > {full_path}"
            proc = self.sandbox.exec("bash", "-c", setup_cmd, workdir=SANDBOX_WORKDIR, timeout=15, pty=False)
            proc.wait()

        self._bootstrap_completed = True
        logger.info("MCP server bridge bootstrapping complete.")

    def exec(
        self,
        command: str,
        timeout: int = DEFAULT_COMMAND_TIMEOUT,
        workdir: str = SANDBOX_WORKDIR,
    ) -> ExecutionResult:
        """Executes a bash command with persistent cwd and environment state.

        Wraps the command in state persistence logic:
        - Restores /tmp/.agent_env and cd's to /tmp/.agent_cwd before running.
        - Captures new cwd to /tmp/.agent_cwd and new exported variables to /tmp/.agent_env.
        - Applies Anthropic srt network wrapper if configured.
        - Truncates output to 12,000 chars to avoid blowing LLM context window.
        """
        if self.sandbox is None:
            raise RuntimeError("No active sandbox attached. Call create() or reconnect() first.")

        # Prepare state-preserving bash script wrapper
        wrapped_script = f"""
set +e
if [ -f /tmp/.agent_env ]; then
    . /tmp/.agent_env 2>/dev/null
fi
if [ -f /tmp/.agent_cwd ]; then
    saved_cwd="$(cat /tmp/.agent_cwd 2>/dev/null)"
    if [ -d "$saved_cwd" ]; then
        cd "$saved_cwd"
    fi
fi

# Execute command
{command}
__status=$?

# Persist environment and working directory
pwd > /tmp/.agent_cwd 2>/dev/null
export -p > /tmp/.agent_env 2>/dev/null
exit $__status
"""

        # Enforce network isolation wrapper based on network_mode
        if self.network_mode == "airgapped":
            final_cmd = f"srt --profile /etc/srt/airgapped.json bash -c {shlex.quote(wrapped_script)}"
        elif self.network_mode == "connected":
            final_cmd = f"srt --profile /etc/srt/connected.json bash -c {shlex.quote(wrapped_script)}"
        else:
            final_cmd = f"bash -c {shlex.quote(wrapped_script)}"

        logger.debug(f"Executing sandbox command: {command[:100]}...")
        proc = self.sandbox.exec("bash", "-c", final_cmd, workdir=workdir, timeout=timeout, pty=False)
        proc.wait()

        raw_stdout = proc.stdout.read()
        raw_stderr = proc.stderr.read()
        exit_code = proc.returncode if hasattr(proc, "returncode") and proc.returncode is not None else 0

        stdout_str = raw_stdout if isinstance(raw_stdout, str) else raw_stdout.decode("utf-8", errors="replace")
        stderr_str = raw_stderr if isinstance(raw_stderr, str) else raw_stderr.decode("utf-8", errors="replace")

        truncated = False
        if len(stdout_str) > OUTPUT_TRUNCATION_LIMIT:
            stdout_str = stdout_str[:OUTPUT_TRUNCATION_LIMIT] + f"\n\n... [STDOUT Truncated: {len(stdout_str) - OUTPUT_TRUNCATION_LIMIT} bytes omitted] ..."
            truncated = True

        if len(stderr_str) > OUTPUT_TRUNCATION_LIMIT:
            stderr_str = stderr_str[:OUTPUT_TRUNCATION_LIMIT] + f"\n\n... [STDERR Truncated: {len(stderr_str) - OUTPUT_TRUNCATION_LIMIT} bytes omitted] ..."
            truncated = True

        return ExecutionResult(stdout=stdout_str, stderr=stderr_str, exit_code=exit_code, truncated=truncated)

    def exec_python(
        self,
        code: str,
        timeout: int = DEFAULT_COMMAND_TIMEOUT,
    ) -> ExecutionResult:
        """Writes Python code to `/mnt/data/_eval_script.py` and executes it."""
        b64_code = base64.b64encode(code.encode("utf-8")).decode("ascii")
        write_and_run = (
            f"echo {b64_code} | base64 -d > /mnt/data/_eval_script.py && "
            "python3 /mnt/data/_eval_script.py"
        )
        return self.exec(write_and_run, timeout=timeout)

    def upload_file(self, local_path: str, remote_path: str) -> None:
        """Transfers a local file into the sandbox via sb.filesystem.copy_from_local."""
        if self.sandbox is None:
            raise RuntimeError("No active sandbox attached.")
        logger.info(f"Uploading file {local_path} -> {remote_path}")
        self.sandbox.filesystem.copy_from_local(local_path, remote_path)

    def download_file(self, remote_path: str, local_path: str) -> None:
        """Downloads a remote sandbox file locally via sb.filesystem.copy_to_local."""
        if self.sandbox is None:
            raise RuntimeError("No active sandbox attached.")
        logger.info(f"Downloading file {remote_path} -> {local_path}")
        os.makedirs(os.path.dirname(os.path.abspath(local_path)), exist_ok=True)
        self.sandbox.filesystem.copy_to_local(remote_path, local_path)

    def get_tunnels(self) -> Dict[int, str]:
        """Retrieves exposed public tunnel URLs for sandbox ports."""
        if self.sandbox is None:
            raise RuntimeError("No active sandbox attached.")
        tunnels = self.sandbox.tunnels()
        return {port: tunnel.url for port, tunnel in tunnels.items()} if tunnels else {}

    def get_tunnel_url(self, port: int = 3000) -> Optional[str]:
        """Returns the public tunnel URL for the specified port (e.g. 3000 or 8080)."""
        tunnels = self.get_tunnels()
        return tunnels.get(port)

    def hibernate_to_snapshot(self, ttl_days: int = 7) -> str:
        """Snapshots the filesystem before terminating the sandbox for zero-cost hibernation.

        Subsequent user turns can resurrect this state instantly via `create(snapshot_id=...)`.
        """
        if self.sandbox is None:
            raise RuntimeError("No active sandbox attached to hibernate.")

        logger.info("Creating filesystem snapshot before hibernation...")
        snapshot_img = self.sandbox.snapshot_filesystem(
            timeout=55,
            ttl=ttl_days * 24 * 3600,
        )
        snapshot_id = snapshot_img.object_id
        logger.info(f"Snapshot created successfully: {snapshot_id}")
        self.terminate()
        return snapshot_id
