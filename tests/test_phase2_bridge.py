import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "deploy" / "modal" / "legacy"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "deploy" / "modal"))
"""Unit and Integration Tests for Phase 2 Modal Sandbox Bridge and Verification Checks."""

import os
import py_compile
import sys
import tempfile
import unittest
from pathlib import Path

# Add project root and deploy directory to path
REPO_ROOT = Path(__file__).resolve().parent.parent
DEPLOY_DIR = REPO_ROOT / "deploy" / "modal" / "legacy"
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(DEPLOY_DIR))

from deploy.modal.phase2_bridge import Phase2SandboxBridge
from deploy.modal.mcp_servers.code_mode import run_code_script


class TestPhase2MCPServersCompilation(unittest.TestCase):
    """Verifies that all files in deploy/modal/mcp_servers/ and deploy/modal/phase2_checks/ compile without syntax errors."""

    def test_mcp_servers_python_compilation(self):
        mcp_servers_dir = DEPLOY_DIR / "mcp_servers"
        self.assertTrue(mcp_servers_dir.exists())

        py_files = list(mcp_servers_dir.rglob("*.py"))
        self.assertGreater(len(py_files), 5)

        for py_file in py_files:
            # Will raise py_compile.PyCompileError on syntax error
            py_compile.compile(str(py_file), doraise=True)

    def test_phase2_checks_compilation(self):
        checks_dir = DEPLOY_DIR / "phase2_checks"
        self.assertTrue(checks_dir.exists())

        py_files = list(checks_dir.glob("*.py"))
        self.assertGreaterEqual(len(py_files), 4)

        for py_file in py_files:
            py_compile.compile(str(py_file), doraise=True)

    def test_fixture_site_html_exists(self):
        html_file = DEPLOY_DIR / "phase2_checks" / "site" / "index.html"
        self.assertTrue(html_file.exists())
        content = html_file.read_text(encoding="utf-8")
        self.assertIn("OpenHarness Sandbox Verification Fixture", content)
        self.assertIn("test-form", content)


class TestInSandboxCodeModeRunner(unittest.TestCase):
    """Validates the in-sandbox code_mode runner script execution, artifact detection, and error handling."""

    def test_run_code_script_success(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            code = """
import os
print("RUN_CODE_SUCCESS")
with open("generated_test.txt", "w") as f:
    f.write("hello from code mode")
"""
            res = run_code_script(code, workdir=tmpdir)
            self.assertEqual(res["exit_code"], 0)
            self.assertIn("RUN_CODE_SUCCESS", res["stdout"])
            self.assertIn("generated_test.txt", res["new_artifacts"])
            self.assertGreater(res["duration_ms"], 0)

    def test_run_code_script_error_handling(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            code = """
raise ValueError("Deliberate error in test")
"""
            res = run_code_script(code, workdir=tmpdir)
            self.assertEqual(res["exit_code"], 1)
            self.assertIn("Deliberate error in test", res["error"])
            self.assertIn("Traceback", res["stderr"])


class TestPhase2BridgeMockSandbox(unittest.TestCase):
    """Tests Phase 2 Bridge lifecycle in mock/local sandbox mode."""

    def setUp(self):
        self.bridge = Phase2SandboxBridge(
            tenant_id="test-tenant",
            session_id="test-session",
            network_mode="connected",
        )

    def test_initialization(self):
        status = self.bridge.initialize()
        self.assertEqual(status["status"], "ready")
        self.assertEqual(status["tenant_id"], "test-tenant")
        self.assertEqual(status["network_mode"], "connected")
        self.assertTrue(self.bridge.is_bootstrapped)

    def test_network_mode_switching(self):
        self.bridge.initialize()
        self.bridge.switch_network_mode("airgapped")
        self.assertEqual(self.bridge.network_mode, "airgapped")
        self.assertEqual(self.bridge.manager.current_network_mode, "airgapped")

        self.bridge.switch_network_mode("github_only")
        self.assertEqual(self.bridge.network_mode, "github_only")
        self.assertEqual(self.bridge.manager.current_network_mode, "github_only")

    def test_execute_code(self):
        self.bridge.initialize()
        code = 'print("HELLO_FROM_MODAL_BRIDGE")'
        result = self.bridge.execute_code(code)
        self.assertIn("status", result)
        self.assertEqual(result["status"], "completed")
        self.assertIn("HELLO_FROM_MODAL_BRIDGE", result["stdout"])

    def test_hibernate_and_terminate(self):
        self.bridge.initialize()
        snapshot_id = self.bridge.hibernate()
        self.assertTrue(snapshot_id.startswith("im-mock-"))
        self.assertIsNone(self.bridge.manager.active_sandbox)


if __name__ == "__main__":
    unittest.main()
