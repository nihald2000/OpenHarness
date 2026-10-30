# Anthropic Code-Mode In-Sandbox MCP Servers

This directory contains the Python modules deployed into `/mnt/mcp_servers` inside the Modal sandbox.

## Structure

- `client.py`: Async & sync JSON-RPC 2.0 stdio MCP client.
- `bootstrap_code_mode.py`: Bootstraps symlinks and directory structures inside the sandbox VM.
- `code_mode.py`: Helper library for code-mode Python scripts executed by the agent.
- `filesystem/`: Safe workspace filesystem operations.
- `github/`: GitHub repository, issue, and commit operations.
- `playwright/`: Headless Chromium browser automation, screenshots, and Axe accessibility audits.
- `skills/`: Document, spreadsheet, presentation, and data visualization generation.

## Usage in Code Mode

The LLM is prompted to write code like:

```python
from mcp_servers.playwright import navigate, screenshot, axe_audit
from mcp_servers.skills import generate_chart, generate_excel

# Inspect web app
navigate("http://localhost:3000")
audit = axe_audit()
print(f"Violations found: {len(audit['violations'])}")
screenshot("/mnt/data/app.png")
```
