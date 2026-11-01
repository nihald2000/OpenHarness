# Production Modal.com Sandbox Harness (Anthropic Code-Mode MCP)

## OpenHarness Modal + Vercel deployment

This path builds the isolated sandbox image, starts a scale-to-zero Meta Muse Glimmer 30B endpoint, and deploys the hosted OpenHarness server. After the Glimmer deployment prints its URL, add it as `MUSE_GLIMMER_BASE_URL` to the existing Modal `openharness-server` secret before deploying the web server, and add the same URL to the Vercel project when prompted below.

```bash
python3 deploy/modal/build_sandbox_image.py
modal deploy deploy/modal/muse_glimmer_server.py
modal deploy deploy/modal/web_server.py
vercel env add MUSE_GLIMMER_BASE_URL production && vercel deploy --prod  # enter the Muse Glimmer Modal URL when prompted
```

The Glimmer endpoint defaults to one H200 and scales to zero after five idle minutes. To use a lower-cost A100 80 GB option, configure `MUSE_GPU=A100-80GB:1` and `MUSE_MAX_MODEL_LEN=32768` before deploying. The default H200 profile uses a 65,536 token served context; raise it only after checking available GPU memory. Optional DFlash speculation is enabled with `MUSE_ENABLE_DFLASH=1`. The Modal backend receives its own `MUSE_GLIMMER_BASE_URL` setting/secret so the server can route model requests to the endpoint.

This directory contains the production-grade remote sandbox execution harness built with the **official Modal Python SDK (`modal.Sandbox`)** and **Anthropic's "Code Execution with MCP" architecture**.

## Architecture Overview

Instead of burdening the LLM with 100+ bulky JSON tool definitions in its context window, this harness equips a secure Ubuntu 24.04 Linux VM sandbox on Modal with in-sandbox MCP bridges (`/mnt/mcp_servers/`).

The agent is instructed to **write Python code** that imports these modules directly. High-volume payloads (e.g. DOM nodes, massive search results, whole files) are filtered in sandbox memory/disk, returning only concise answers or artifacts to the LLM.

### Components

1. **`modal_image.py`**:
   - Ubuntu 24.04 LTS VM image (`runtime="vm"`).
   - Pre-installed compilers & runtimes: Python 3.12, Node.js 22, Rust, Go, Clang, gcc/g++, `uv`, `pytest`.
   - Browser & Web Testing: Playwright (`playwright install --with-deps chromium`), `@playwright/mcp`, `@axe-core/cli`, `lighthouse`, `xvfb`.
   - MCP Server packages: `@playwright/mcp`, `@modelcontextprotocol/server-github`, `@modelcontextprotocol/server-filesystem`.
   - Document & Office Engines: Pandoc, LibreOffice, Poppler-utils, ReportLab, OpenPyXL, python-docx, python-pptx, Matplotlib.
   - Anthropic Sandbox Runtime: `@anthropic-ai/sandbox-runtime` (`srt`), Bubblewrap, network filtering configs (`/etc/srt/`).

2. **`mcp_code_bridge.py`**:
   - Populates `/mnt/mcp_servers/` inside the sandbox with:
     - `client.py`: Async & sync JSON-RPC stdio MCP client.
     - `playwright/`: Headless Chromium navigation, screenshots, DOM evaluation, and Axe audits.
     - `github/`: Repository search, file retrieval, and issue management.
     - `filesystem/`: Bounded file read, write, search, and directory inspection.
     - `skills/`: Generation of `.xlsx`, `.docx`, `.pptx`, `matplotlib` charts, and PDF conversion.

3. **`sandbox_manager.py`**:
   - `ModalSandboxManager` wrapping current official `modal.Sandbox` APIs.
   - Timeout and cost protections: `timeout=1800` (30m max) and `idle_timeout=180` (3m idle kill).
   - Dynamic network modes (`connected`, `github_only`, `airgapped`) using `outbound_domain_allowlist` and `outbound_cidr_allowlist`.
   - State-preserving command execution: maintains `$CWD` (`/tmp/.agent_cwd`) and environment variables (`/tmp/.agent_env`) across commands.
   - Output truncation capped at 12,000 characters to protect context windows.
   - File transfer via `copy_from_local` and `copy_to_local`.
   - Web application tunnels on ports 3000 and 8080.
   - Zero-cost hibernation with `snapshot_filesystem()` and instant restoration via `Image.from_id()`.

4. **`agent_tools.py`**:
   - Exposes 3 minimal Anthropic tools to the LLM:
     - `discover_mcp_modules`
     - `execute_sandbox_code`
     - `export_artifact`
   - Claude-optimized system prompt for code-mode MCP execution.

## Usage

```python
from sandbox_manager import ModalSandboxManager
from agent_tools import AgentToolExecutor

# Initialize manager with tenant & session scope
manager = ModalSandboxManager(tenant_id="tenant-123", session_id="session-456")
sb = manager.create(network_mode="connected")

executor = AgentToolExecutor(manager)

# Execute Python code that navigates via Playwright and captures a screenshot
code = '''
from mcp_servers.playwright import navigate, screenshot
navigate("https://example.com")
print(screenshot("/mnt/data/example.png"))
'''
result = executor.execute_sandbox_code(code)
print(result["stdout"])

# Export generated artifact to host
executor.export_artifact("/mnt/data/example.png", "./local_example.png")

# Hibernate sandbox to zero-cost snapshot
snapshot_id = manager.hibernate_to_snapshot()
print(f"Hibernated to snapshot: {snapshot_id}")
```
