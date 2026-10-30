"""In-Sandbox MCP Code Bridge Generator & Modules.

This module provides the code and bootstrapping logic for the Anthropic
"Code Execution with MCP" architecture located inside the sandbox at `/mnt/mcp_servers`.

Rather than dumping dozens of bulky JSON schemas into the LLM context window,
the model is instructed to write Python scripts that import these lightweight,
in-sandbox wrappers. High-volume data (DOM trees, massive GitHub issue lists,
file listings) are processed, filtered, and aggregated inside sandbox memory,
returning only the precise answer or artifact to the LLM.

Directory layout populated inside `/mnt/mcp_servers`:
├── client.py
├── filesystem/
│   └── __init__.py
├── github/
│   └── __init__.py
├── playwright/
│   └── __init__.py
└── skills/
    └── __init__.py
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# In-Sandbox MCP Client Template (/mnt/mcp_servers/client.py)
# ---------------------------------------------------------------------------

CLIENT_PY_CONTENT = '''"""Async & Synchronous MCP Stdio Client Bridge for Modal Sandboxes."""

import asyncio
import json
import os
import sys
from typing import Any, Dict, List, Optional


class MCPClient:
    """Lightweight JSON-RPC 2.0 stdio client for Model Context Protocol servers."""

    def __init__(self, command: List[str], env: Optional[Dict[str, str]] = None):
        self.command = command
        self.env = {**os.environ, **(env or {})}
        self.process: Optional[asyncio.subprocess.Process] = None
        self._request_id = 0
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        """Starts the MCP server subprocess."""
        if self.process is not None:
            return
        self.process = await asyncio.create_subprocess_exec(
            *self.command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=self.env,
        )
        # Initialize MCP handshake
        await self._send_request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "modal-agent-harness", "version": "1.0.0"},
            },
        )
        await self._send_notification("notifications/initialized", {})

    async def _send_request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Any:
        if self.process is None or self.process.stdin is None or self.process.stdout is None:
            raise RuntimeError("MCP server process is not running")

        async with self._lock:
            self._request_id += 1
            req_id = self._request_id
            payload = {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": method,
                "params": params or {},
            }
            raw = json.dumps(payload) + "\\n"
            self.process.stdin.write(raw.encode("utf-8"))
            await self.process.stdin.drain()

            while True:
                line = await self.process.stdout.readline()
                if not line:
                    stderr = await self.process.stderr.read() if self.process.stderr else b""
                    raise RuntimeError(f"MCP server exited unexpectedly. stderr: {stderr.decode('utf-8', errors='replace')}")
                line_str = line.decode("utf-8").strip()
                if not line_str:
                    continue
                try:
                    res = json.loads(line_str)
                except json.JSONDecodeError:
                    continue
                if res.get("id") == req_id:
                    if "error" in res:
                        raise RuntimeError(f"MCP Error [{res['error'].get('code')}]: {res['error'].get('message')}")
                    return res.get("result")

    async def _send_notification(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        if self.process is None or self.process.stdin is None:
            return
        payload = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        raw = json.dumps(payload) + "\\n"
        self.process.stdin.write(raw.encode("utf-8"))
        await self.process.stdin.drain()

    async def list_tools(self) -> List[Dict[str, Any]]:
        res = await self._send_request("tools/list", {})
        return res.get("tools", []) if isinstance(res, dict) else []

    async def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        res = await self._send_request("tools/call", {"name": name, "arguments": arguments or {}})
        content = res.get("content", []) if isinstance(res, dict) else []
        texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
        if texts:
            return "\\n".join(texts)
        return res

    async def close(self) -> None:
        if self.process is not None:
            try:
                self.process.terminate()
                await asyncio.wait_for(self.process.wait(), timeout=3.0)
            except Exception:
                if self.process:
                    self.process.kill()
            self.process = None


def run_sync(coro):
    """Utility to execute an async coroutine synchronously in Python scripts."""
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    if loop.is_running():
        import nest_asyncio  # type: ignore
        nest_asyncio.apply()
    return loop.run_until_complete(coro)
'''


# ---------------------------------------------------------------------------
# In-Sandbox Playwright Wrapper (/mnt/mcp_servers/playwright/__init__.py)
# ---------------------------------------------------------------------------

PLAYWRIGHT_INIT_CONTENT = '''"""Playwright Browser Automation MCP wrapper.

Allows LLMs to control headless Chromium, take screenshots, navigate pages,
extract clean DOM subsets, and run accessibility audits without returning massive HTML.
"""

from typing import Any, Dict, Optional
from mcp_servers.client import MCPClient, run_sync

_client: Optional[MCPClient] = None


def _get_client() -> MCPClient:
    global _client
    if _client is None:
        _client = MCPClient(["npx", "-y", "@playwright/mcp", "run"])
        run_sync(_client.start())
    return _client


def navigate(url: str, timeout: int = 30000) -> str:
    """Navigates the browser to the specified URL.

    Args:
        url: Complete target URL (e.g. 'http://localhost:3000' or 'https://example.com').
        timeout: Navigation timeout in ms.
    """
    client = _get_client()
    return run_sync(client.call_tool("navigate", {"url": url, "timeout": timeout}))


def screenshot(path: str = "/mnt/data/screenshot.png", full_page: bool = True) -> str:
    """Takes a screenshot of the current page and saves it to disk.

    Args:
        path: Path where the PNG screenshot will be saved.
        full_page: Whether to capture full scrollable page.
    """
    client = _get_client()
    result = run_sync(client.call_tool("screenshot", {"path": path, "fullPage": full_page}))
    return f"Screenshot successfully saved to {path}"


def click(selector: str) -> str:
    """Clicks the element matched by the CSS or XPath selector."""
    client = _get_client()
    return run_sync(client.call_tool("click", {"selector": selector}))


def fill(selector: str, text: str) -> str:
    """Fills an input field with the given text."""
    client = _get_client()
    return run_sync(client.call_tool("fill", {"selector": selector, "value": text}))


def evaluate(expression: str) -> Any:
    """Executes a JavaScript expression inside the browser page context."""
    client = _get_client()
    return run_sync(client.call_tool("evaluate", {"script": expression}))


def get_content() -> str:
    """Returns the text or inner content of the page body."""
    client = _get_client()
    return run_sync(client.call_tool("get_content", {}))


def get_title() -> str:
    """Returns page title."""
    return str(evaluate("document.title"))


def axe_check() -> Dict[str, Any]:
    """Runs an axe-core accessibility check on the active page and summarizes violations."""
    js_axe = """
    (() => {
        return window.axe ? window.axe.run().then(r => ({
            violations: r.violations.map(v => ({ id: v.id, impact: v.impact, description: v.description, nodes: v.nodes.length }))
        })) : { error: 'axe-core not loaded on page' };
    })()
    """
    return evaluate(js_axe)


def close() -> None:
    """Closes the browser session."""
    global _client
    if _client is not None:
        run_sync(_client.close())
        _client = None
'''


# ---------------------------------------------------------------------------
# In-Sandbox GitHub Wrapper (/mnt/mcp_servers/github/__init__.py)
# ---------------------------------------------------------------------------

GITHUB_INIT_CONTENT = '''"""GitHub MCP Wrapper.

Provides clean Python functions to search issues, read repository files,
create issues/PRs, and inspect commits via the GitHub MCP server.
Requires GITHUB_PERSONAL_ACCESS_TOKEN or GH_TOKEN in environment.
"""

import os
from typing import Any, Dict, List, Optional
from mcp_servers.client import MCPClient, run_sync

_client: Optional[MCPClient] = None


def _get_client() -> MCPClient:
    global _client
    if _client is None:
        token = os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN") or os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
        env = {"GITHUB_PERSONAL_ACCESS_TOKEN": token} if token else {}
        _client = MCPClient(["npx", "-y", "@modelcontextprotocol/server-github"], env=env)
        run_sync(_client.start())
    return _client


def search_issues(query: str, repo: Optional[str] = None, limit: int = 10) -> List[Dict[str, Any]]:
    """Searches issues/PRs across GitHub. Filters locally to prevent context blowup."""
    client = _get_client()
    q = f"repo:{repo} {query}" if repo else query
    raw = run_sync(client.call_tool("search_issues", {"query": q}))
    if isinstance(raw, str):
        import json
        try:
            items = json.loads(raw)
            return items[:limit] if isinstance(items, list) else items
        except Exception:
            return [{"raw": raw[:2000]}]
    return raw[:limit] if isinstance(raw, list) else [raw]


def create_issue(repo: str, title: str, body: str) -> str:
    """Creates a new issue in target 'owner/repo'."""
    client = _get_client()
    owner, repo_name = repo.split("/")
    return run_sync(client.call_tool("create_issue", {"owner": owner, "repo": repo_name, "title": title, "body": body}))


def get_file(repo: str, path: str, branch: str = "main") -> str:
    """Fetches the contents of a file from target repository."""
    client = _get_client()
    owner, repo_name = repo.split("/")
    return run_sync(client.call_tool("get_file_contents", {"owner": owner, "repo": repo_name, "path": path, "branch": branch}))


def search_code(query: str, limit: int = 10) -> Any:
    """Searches code using the GitHub code search API."""
    client = _get_client()
    return run_sync(client.call_tool("search_code", {"q": query}))
'''


# ---------------------------------------------------------------------------
# In-Sandbox Filesystem Wrapper (/mnt/mcp_servers/filesystem/__init__.py)
# ---------------------------------------------------------------------------

FILESYSTEM_INIT_CONTENT = '''"""Filesystem MCP wrapper.

Fast, structured file manipulation under /mnt/data and sandbox workspace paths.
"""

import os
from pathlib import Path
from typing import Any, Dict, List, Optional
from mcp_servers.client import MCPClient, run_sync

_client: Optional[MCPClient] = None


def _get_client() -> MCPClient:
    global _client
    if _client is None:
        _client = MCPClient(["npx", "-y", "@modelcontextprotocol/server-filesystem", "/mnt/data"])
        run_sync(_client.start())
    return _client


def read_file(path: str, max_chars: int = 20000) -> str:
    """Reads a file with safety limits to avoid overflowing context."""
    p = Path(path)
    if not p.is_absolute():
        p = Path("/mnt/data") / p
    if not p.exists():
        raise FileNotFoundError(f"File not found: {p}")
    content = p.read_text(encoding="utf-8", errors="replace")
    if len(content) > max_chars:
        return content[:max_chars] + f"\\n... [Truncated: {len(content) - max_chars} characters omitted] ..."
    return content


def write_file(path: str, content: str) -> str:
    """Writes text content to a destination file, creating parent directories as needed."""
    p = Path(path)
    if not p.is_absolute():
        p = Path("/mnt/data") / p
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return f"Wrote {len(content)} bytes to {p}"


def list_directory(path: str = "/mnt/data") -> List[Dict[str, Any]]:
    """Lists directory contents with file metadata (size, type, permissions)."""
    p = Path(path)
    if not p.exists():
        return []
    entries = []
    for item in p.iterdir():
        stat = item.stat()
        entries.append({
            "name": item.name,
            "path": str(item),
            "is_dir": item.is_dir(),
            "size_bytes": stat.st_size,
        })
    return entries


def search_files(root: str = "/mnt/data", pattern: str = "*") -> List[str]:
    """Finds files matching glob pattern."""
    p = Path(root)
    return [str(f) for f in p.glob(pattern)]
'''


# ---------------------------------------------------------------------------
# In-Sandbox Skills & Document Generation (/mnt/mcp_servers/skills/__init__.py)
# ---------------------------------------------------------------------------

SKILLS_INIT_CONTENT = '''"""Office Document Generation & Data Visualization Skills.

Built-in helpers for producing Excel spreadsheets, Word documents,
PowerPoint presentations, matplotlib charts, and Pandoc PDF reports.
"""

import os
from typing import Any, Dict, List, Optional


def create_excel(filepath: str, sheets_data: Dict[str, List[List[Any]]]) -> str:
    """Creates a multi-tab Excel workbook using openpyxl.

    Args:
        filepath: Output .xlsx path (e.g. '/mnt/data/financial_report.xlsx').
        sheets_data: Dictionary mapping sheet name to 2D list of rows.
    """
    import openpyxl
    wb = openpyxl.Workbook()
    first = True
    for sheet_name, rows in sheets_data.items():
        ws = wb.active if first else wb.create_sheet(title=sheet_name)
        first = False
        ws.title = sheet_name
        for row in rows:
            ws.append(row)
    wb.save(filepath)
    return f"Created Excel workbook at {filepath}"


def create_word_doc(filepath: str, title: str, paragraphs: List[str]) -> str:
    """Creates a formatted Word document using python-docx."""
    import docx
    doc = docx.Document()
    doc.add_heading(title, 0)
    for p in paragraphs:
        doc.add_paragraph(p)
    doc.save(filepath)
    return f"Created Word document at {filepath}"


def create_presentation(filepath: str, title: str, slides: List[Dict[str, Any]]) -> str:
    """Creates a PowerPoint presentation using python-pptx."""
    from pptx import Presentation
    from pptx.util import Inches, Pt

    prs = Presentation()
    # Title slide
    title_slide_layout = prs.slide_layouts[0]
    slide = prs.slides.add_slide(title_slide_layout)
    slide.shapes.title.text = title

    bullet_layout = prs.slide_layouts[1]
    for s in slides:
        slide = prs.slides.add_slide(bullet_layout)
        slide.shapes.title.text = s.get("heading", "")
        body_shape = slide.shapes.placeholders[1]
        tf = body_shape.text_frame
        for bullet in s.get("bullets", []):
            p = tf.add_paragraph()
            p.text = bullet
            p.level = 0

    prs.save(filepath)
    return f"Created PowerPoint presentation at {filepath}"


def render_chart(filepath: str, x: List[Any], y: List[Any], title: str, chart_type: str = "line", x_label: str = "", y_label: str = "") -> str:
    """Generates a high-resolution PNG chart using matplotlib."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.figure(figsize=(10, 6), dpi=150)
    if chart_type == "bar":
        plt.bar(x, y, color="#2563eb")
    elif chart_type == "scatter":
        plt.scatter(x, y, color="#dc2626")
    else:
        plt.plot(x, y, marker="o", color="#2563eb", linewidth=2)

    plt.title(title, fontsize=14, fontweight="bold")
    if x_label:
        plt.xlabel(x_label)
    if y_label:
        plt.ylabel(y_label)
    plt.grid(True, linestyle="--", alpha=0.6)
    plt.tight_layout()
    plt.savefig(filepath)
    plt.close()
    return f"Rendered {chart_type} chart to {filepath}"


def render_markdown_to_pdf(markdown_content: str, output_path: str) -> str:
    """Converts markdown content to PDF via Pandoc."""
    import subprocess
    import tempfile

    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(markdown_content)
        temp_md = f.name

    try:
        subprocess.run(["pandoc", temp_md, "-o", output_path, "--pdf-engine=weasyprint"], check=True)
    except Exception:
        # Fallback to wkhtmltopdf or pdflatex if available
        subprocess.run(["pandoc", temp_md, "-o", output_path], check=True)
    finally:
        if os.path.exists(temp_md):
            os.remove(temp_md)

    return f"Rendered PDF to {output_path}"
'''


# ---------------------------------------------------------------------------
# Host-side Bootstrap & Discovery Utilities
# ---------------------------------------------------------------------------

def get_mcp_server_files() -> Dict[str, str]:
    """Returns mapping of relative file paths to file contents for /mnt/mcp_servers."""
    return {
        "client.py": CLIENT_PY_CONTENT,
        "playwright/__init__.py": PLAYWRIGHT_INIT_CONTENT,
        "github/__init__.py": GITHUB_INIT_CONTENT,
        "filesystem/__init__.py": FILESYSTEM_INIT_CONTENT,
        "skills/__init__.py": SKILLS_INIT_CONTENT,
        "__init__.py": '"""Anthropic Code-Mode MCP In-Sandbox Root Module."""\n',
    }


def get_available_mcp_modules_metadata() -> Dict[str, Any]:
    """Returns structured documentation of available in-sandbox Python modules.

    This payload is returned by the host `discover_mcp_modules` tool to let
    the LLM discover available tools without loading massive JSON schemas.
    """
    return {
        "mcp_servers.playwright": {
            "description": "Headless Chromium browser automation via Playwright MCP",
            "functions": [
                {"name": "navigate", "signature": "navigate(url: str, timeout: int = 30000) -> str"},
                {"name": "screenshot", "signature": "screenshot(path: str = '/mnt/data/screenshot.png', full_page: bool = True) -> str"},
                {"name": "click", "signature": "click(selector: str) -> str"},
                {"name": "fill", "signature": "fill(selector: str, text: str) -> str"},
                {"name": "evaluate", "signature": "evaluate(expression: str) -> Any"},
                {"name": "get_content", "signature": "get_content() -> str"},
                {"name": "get_title", "signature": "get_title() -> str"},
                {"name": "axe_check", "signature": "axe_check() -> Dict[str, Any]"},
            ],
        },
        "mcp_servers.github": {
            "description": "GitHub API wrapper for issues, code search, and file management",
            "functions": [
                {"name": "search_issues", "signature": "search_issues(query: str, repo: Optional[str] = None, limit: int = 10) -> List[Dict]"},
                {"name": "create_issue", "signature": "create_issue(repo: str, title: str, body: str) -> str"},
                {"name": "get_file", "signature": "get_file(repo: str, path: str, branch: str = 'main') -> str"},
                {"name": "search_code", "signature": "search_code(query: str, limit: int = 10) -> Any"},
            ],
        },
        "mcp_servers.filesystem": {
            "description": "Structured file read/write, traversal, and search in /mnt/data",
            "functions": [
                {"name": "read_file", "signature": "read_file(path: str, max_chars: int = 20000) -> str"},
                {"name": "write_file", "signature": "write_file(path: str, content: str) -> str"},
                {"name": "list_directory", "signature": "list_directory(path: str = '/mnt/data') -> List[Dict]"},
                {"name": "search_files", "signature": "search_files(root: str = '/mnt/data', pattern: str = '*') -> List[str]"},
            ],
        },
        "mcp_servers.skills": {
            "description": "Office documents, Excel spreadsheets, presentations, and charts",
            "functions": [
                {"name": "create_excel", "signature": "create_excel(filepath: str, sheets_data: Dict[str, List[List]]) -> str"},
                {"name": "create_word_doc", "signature": "create_word_doc(filepath: str, title: str, paragraphs: List[str]) -> str"},
                {"name": "create_presentation", "signature": "create_presentation(filepath: str, title: str, slides: List[Dict]) -> str"},
                {"name": "render_chart", "signature": "render_chart(filepath: str, x: List, y: List, title: str, chart_type: str = 'line') -> str"},
                {"name": "render_markdown_to_pdf", "signature": "render_markdown_to_pdf(markdown_content: str, output_path: str) -> str"},
            ],
        },
    }
