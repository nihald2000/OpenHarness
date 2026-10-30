"""Unit tests for Modal Sandbox Harness and MCP Code Bridge."""

import py_compile
import tempfile
import unittest

from agent_tools import (
    ANTHROPIC_TOOLS,
    CODE_MODE_SYSTEM_PROMPT,
    AgentToolExecutor,
)
from mcp_code_bridge import (
    CLIENT_PY_CONTENT,
    FILESYSTEM_INIT_CONTENT,
    GITHUB_INIT_CONTENT,
    PLAYWRIGHT_INIT_CONTENT,
    SKILLS_INIT_CONTENT,
    get_available_mcp_modules_metadata,
    get_mcp_server_files,
)
from sandbox_manager import ExecutionResult, ModalSandboxManager


class TestMCPCodeBridge(unittest.TestCase):
    """Validates the generated in-sandbox templates and syntax."""

    def test_mcp_server_files_structure(self):
        files = get_mcp_server_files()
        expected = [
            "client.py",
            "playwright/__init__.py",
            "github/__init__.py",
            "filesystem/__init__.py",
            "skills/__init__.py",
            "__init__.py",
        ]
        for path in expected:
            self.assertIn(path, files)
            self.assertTrue(len(files[path]) > 0)

    def test_in_sandbox_scripts_syntax(self):
        """Verifies that all generated Python files for /mnt/mcp_servers compile cleanly."""
        scripts = {
            "client.py": CLIENT_PY_CONTENT,
            "playwright.py": PLAYWRIGHT_INIT_CONTENT,
            "github.py": GITHUB_INIT_CONTENT,
            "filesystem.py": FILESYSTEM_INIT_CONTENT,
            "skills.py": SKILLS_INIT_CONTENT,
        }
        for name, code in scripts.items():
            with tempfile.NamedTemporaryFile("w", suffix=".py") as f:
                f.write(code)
                f.flush()
                # py_compile will raise py_compile.PyCompileError on syntax issues
                py_compile.compile(f.name, doraise=True)

    def test_discovery_metadata(self):
        metadata = get_available_mcp_modules_metadata()
        self.assertIn("mcp_servers.playwright", metadata)
        self.assertIn("mcp_servers.github", metadata)
        self.assertIn("mcp_servers.filesystem", metadata)
        self.assertIn("mcp_servers.skills", metadata)
        # Check functions
        pw_funcs = [fn["name"] for fn in metadata["mcp_servers.playwright"]["functions"]]
        self.assertIn("navigate", pw_funcs)
        self.assertIn("screenshot", pw_funcs)


class TestSandboxExecutionResult(unittest.TestCase):
    """Validates ExecutionResult and truncation logic."""

    def test_execution_result_truncation(self):
        res = ExecutionResult(stdout="hello world", stderr="", exit_code=0, truncated=False)
        self.assertTrue(res.success)
        d = res.to_dict()
        self.assertEqual(d["exit_code"], 0)
        self.assertFalse(d["truncated"])

    def test_truncation_detection(self):
        long_output = "x" * 15000
        res = ExecutionResult(stdout=long_output[:12000], stderr="", exit_code=0, truncated=True)
        self.assertTrue(res.truncated)
        self.assertIn("truncated", str(res).lower())


class TestAgentTools(unittest.TestCase):
    """Validates Anthropic tools schema and dispatcher."""

    def test_anthropic_tools_schema(self):
        self.assertEqual(len(ANTHROPIC_TOOLS), 3)
        tool_names = [t["name"] for t in ANTHROPIC_TOOLS]
        self.assertIn("discover_mcp_modules", tool_names)
        self.assertIn("execute_sandbox_code", tool_names)
        self.assertIn("export_artifact", tool_names)

        for tool in ANTHROPIC_TOOLS:
            self.assertIn("name", tool)
            self.assertIn("description", tool)
            self.assertIn("input_schema", tool)
            self.assertEqual(tool["input_schema"]["type"], "object")

    def test_system_prompt_content(self):
        self.assertIn("Code Execution with MCP", CODE_MODE_SYSTEM_PROMPT)
        self.assertIn("/mnt/mcp_servers/", CODE_MODE_SYSTEM_PROMPT)
        self.assertIn("mcp_servers.playwright", CODE_MODE_SYSTEM_PROMPT)

    def test_tool_executor_discovery(self):
        # Test tool discovery without active sandbox
        mgr = ModalSandboxManager(tenant_id="tenant-test", session_id="session-test")
        executor = AgentToolExecutor(mgr)

        res = executor.discover_mcp_modules()
        self.assertIn("mcp_servers.skills", res)

        pw_only = executor.discover_mcp_modules(module_name="mcp_servers.playwright")
        self.assertEqual(list(pw_only.keys()), ["mcp_servers.playwright"])


if __name__ == "__main__":
    unittest.main()
