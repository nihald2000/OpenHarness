"""Modal Production Sandbox Harness with Anthropic Code-Mode MCP.

Modules:
- modal_image: Sandbox image definition (Ubuntu 24.04, compilers, Playwright, MCP, srt)
- mcp_code_bridge: In-sandbox MCP Python bridge generator and client
- sandbox_manager: ModalSandboxManager for VM lifecycle, network modes, bash persistence
- agent_tools: Minimal Claude tool definitions and system prompt
"""

from modal_image import APP_NAME, SANDBOX_WORKDIR, build_harness_image, get_modal_app
from mcp_code_bridge import (
    get_available_mcp_modules_metadata,
    get_mcp_server_files,
)
from sandbox_manager import ExecutionResult, ModalSandboxManager, NetworkMode
from agent_tools import (
    ANTHROPIC_TOOLS,
    CODE_MODE_SYSTEM_PROMPT,
    AgentToolExecutor,
)

__all__ = [
    "APP_NAME",
    "SANDBOX_WORKDIR",
    "build_harness_image",
    "get_modal_app",
    "get_mcp_server_files",
    "get_available_mcp_modules_metadata",
    "ExecutionResult",
    "ModalSandboxManager",
    "NetworkMode",
    "ANTHROPIC_TOOLS",
    "CODE_MODE_SYSTEM_PROMPT",
    "AgentToolExecutor",
]
