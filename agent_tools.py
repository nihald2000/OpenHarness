"""Anthropic Code-Mode MCP Host-Side Agent Tools & System Prompt.

Exposes exactly 3 minimal LLM tools to Claude/agents:
1. `discover_mcp_modules`: Inspects in-sandbox MCP modules, classes, and function signatures.
2. `execute_sandbox_code`: Executes a Python script inside the Modal sandbox and captures output.
3. `export_artifact`: Transfers generated files (PDFs, Excel, PNGs, etc.) from sandbox to host.

Includes the specialized system prompt instructing the agent on the
Code Execution with MCP architectural pattern.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Literal, Optional

from mcp_code_bridge import get_available_mcp_modules_metadata
from sandbox_manager import ModalSandboxManager, NetworkMode


# ---------------------------------------------------------------------------
# Specialized Claude System Prompt for Code-Mode MCP Execution
# ---------------------------------------------------------------------------

CODE_MODE_SYSTEM_PROMPT = """You are an advanced AI engineering agent equipped with a secure, VM-grade Linux sandbox on Modal.com.

## Architecture: Code Execution with MCP
Unlike traditional agents that load 100+ raw JSON tool schemas into the conversation context (which wastes tokens and causes hallucination), you interact with tools and services by **writing concise Python code** against the in-sandbox `/mnt/mcp_servers/` modules.

### Available In-Sandbox Modules
You can directly import and call:
- `mcp_servers.playwright`: Headless Chromium navigation, screenshotting, DOM evaluation, and Axe accessibility audits.
- `mcp_servers.github`: GitHub repository search, issue management, and file inspection.
- `mcp_servers.filesystem`: High-speed structured filesystem reads, writes, and searches under `/mnt/data`.
- `mcp_servers.skills`: Native generation of Excel workbooks (`.xlsx`), Word docs (`.docx`), PowerPoint decks (`.pptx`), high-res charts (`matplotlib`), and PDF compilation.

### Key Rules for Writing Sandbox Code:
1. **Filter Data in Sandbox Memory**: Never dump entire web pages, multi-megabyte API payloads, or raw file dumps into standard output. Filter, slice, aggregate, or search data *inside Python* and only `print()` the exact answer or summary needed.
2. **State Persistence**: The sandbox retains `/mnt/data` and your working directory/environment across code executions.
3. **Artifact Creation**: Save all produced files (reports, charts, spreadsheets, presentations, screenshots) to `/mnt/data/` or `/mnt/artifacts/`. Afterwards, call `export_artifact` to deliver them.
4. **Network Modes**:
   - `connected`: Default mode. Use for web scraping, Playwright testing, or package installations.
   - `github_only`: Restricts network access solely to GitHub domains.
   - `airgapped`: Completely offline execution for untrusted scripts or sensitive computations.
5. **Discovery**: Call `discover_mcp_modules` whenever you need to check exact function signatures or parameter names.
"""


# ---------------------------------------------------------------------------
# Anthropic Tool Schemas (for Claude API / Anthropic SDK `tools` argument)
# ---------------------------------------------------------------------------

ANTHROPIC_TOOLS: List[Dict[str, Any]] = [
    {
        "name": "discover_mcp_modules",
        "description": "Discovers all available in-sandbox MCP Python modules, function signatures, and docstrings under /mnt/mcp_servers/.",
        "input_schema": {
            "type": "object",
            "properties": {
                "module_name": {
                    "type": "string",
                    "description": "Optional specific module name to filter (e.g. 'mcp_servers.playwright' or 'mcp_servers.skills'). If omitted, returns all modules.",
                }
            },
            "required": [],
        },
    },
    {
        "name": "execute_sandbox_code",
        "description": "Executes a Python script inside the Modal Linux VM sandbox. The script can import and use modules from /mnt/mcp_servers. Standard output and error are returned (truncated to 12,000 chars).",
        "input_schema": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "The complete Python code to execute inside the sandbox.",
                },
                "network_mode": {
                    "type": "string",
                    "enum": ["connected", "github_only", "airgapped"],
                    "description": "Network security mode: 'connected' (standard egress), 'github_only' (allowlist GitHub), or 'airgapped' (offline).",
                    "default": "connected",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Execution timeout in seconds (default 120, max 600).",
                    "default": 120,
                },
            },
            "required": ["code"],
        },
    },
    {
        "name": "export_artifact",
        "description": "Transfers an artifact (PDF, image, Excel spreadsheet, report) from the sandbox /mnt/data directory to the local host machine.",
        "input_schema": {
            "type": "object",
            "properties": {
                "sandbox_path": {
                    "type": "string",
                    "description": "Path to the file inside the sandbox (e.g. '/mnt/data/report.xlsx' or '/mnt/data/screenshot.png').",
                },
                "local_destination": {
                    "type": "string",
                    "description": "Local path on the host where the file should be saved.",
                },
            },
            "required": ["sandbox_path", "local_destination"],
        },
    },
]


# ---------------------------------------------------------------------------
# Host-Side Tool Executor
# ---------------------------------------------------------------------------

class AgentToolExecutor:
    """Dispatches and executes Anthropic agent tool calls against a ModalSandboxManager instance."""

    def __init__(self, sandbox_manager: ModalSandboxManager):
        self.sandbox_manager = sandbox_manager

    def bootstrap_sandbox(self) -> None:
        if hasattr(self.sandbox_manager, "_bootstrap_in_sandbox_mcp"):
            self.sandbox_manager._bootstrap_in_sandbox_mcp()

    def discover_mcp_modules(self, module_name: Optional[str] = None) -> Dict[str, Any]:
        """Returns metadata for all or a specific in-sandbox MCP module."""
        metadata = get_available_mcp_modules_metadata()
        if module_name and module_name in metadata:
            return {module_name: metadata[module_name]}
        return metadata

    def execute_sandbox_code(
        self,
        code: str,
        network_mode: NetworkMode = "connected",
        timeout: int = 120,
    ) -> Dict[str, Any]:
        """Switches network mode if needed, executes the code, and formats the output."""
        if self.sandbox_manager.network_mode != network_mode:
            self.sandbox_manager.set_network_mode(network_mode)

        res = self.sandbox_manager.exec_python(code, timeout=timeout)
        return res.to_dict()

    def export_artifact(self, sandbox_path: str, local_destination: str) -> Dict[str, Any]:
        """Downloads a file artifact from the sandbox to the host filesystem."""
        try:
            self.sandbox_manager.download_file(sandbox_path, local_destination)
            return {
                "success": True,
                "message": f"Successfully exported artifact to {local_destination}",
                "sandbox_path": sandbox_path,
                "local_destination": local_destination,
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "sandbox_path": sandbox_path,
                "local_destination": local_destination,
            }

    def dispatch_tool_call(self, tool_name: str, arguments: Dict[str, Any]) -> Any:
        """Central dispatcher for tool calls received from LLM tool-calling loops."""
        if tool_name == "discover_mcp_modules":
            return self.discover_mcp_modules(module_name=arguments.get("module_name"))
        elif tool_name == "execute_sandbox_code":
            return self.execute_sandbox_code(
                code=arguments["code"],
                network_mode=arguments.get("network_mode", "connected"),
                timeout=arguments.get("timeout", 120),
            )
        elif tool_name == "export_artifact":
            return self.export_artifact(
                sandbox_path=arguments["sandbox_path"],
                local_destination=arguments["local_destination"],
            )
        else:
            raise ValueError(f"Unknown tool name: {tool_name}")
