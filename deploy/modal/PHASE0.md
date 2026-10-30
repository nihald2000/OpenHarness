# Phase 0 & Phase 1 Architecture: Modal Sandbox Harness with Anthropic Code-Mode MCP

## 1. Executive Summary

OpenHarness employs a hybrid execution architecture:
1. **Local fast-path**: In-process execution and local file operations for low-latency iteration.
2. **Production Modal Sandbox (`modal.Sandbox`)**: Secure, isolated cloud execution environment providing Linux VM sandboxes (`runtime="vm"`), multi-compiler runtimes, headless browser automation via Playwright, office document generation, and network policy enforcement.

Instead of passing 100+ raw JSON tool definitions into the LLM context window (which wastes tokens and introduces tool hallucination risks), we implement Anthropic's **"Code Execution with MCP"** architecture. The LLM interacts with tools by writing Python code that imports pre-built MCP client modules located inside `/mnt/mcp_servers/`. High-volume data (DOM trees, massive repository search results, entire datasets) stays inside sandbox memory/disk, returning only distilled results or exported artifacts to the LLM.

---

## 2. Security & Isolation Model

### 2.1 Hardware-Assisted VM Sandboxing
- Sandboxes are instantiated with `runtime="vm"`.
- Enables true Linux kernel namespaces, full unprivileged container capabilities, and Chromium sandboxing without requiring `privileged=True` or `no-sandbox` flags.
- Complete filesystem isolation with temporary overlay scratch space mounted at `/mnt/data`.

### 2.2 Cost & Resource Protection
- **Hard Timeout**: `timeout=1800` (30 minutes max lifetime per sandbox).
- **Idle Inactivity Kill**: `idle_timeout=180` (auto-terminates after 3 minutes without execution).
- **Context Output Truncation**: Process standard output and standard error streams are capped at 12,000 characters to prevent LLM context exhaustion.

### 2.3 Dynamic Network Enforcement
The harness uses Modal's official network allowlist parameters (`outbound_domain_allowlist`, `outbound_cidr_allowlist`, `inbound_cidr_allowlist`):

| Network Mode | Policy & Allowlist | Primary Use Case |
|---|---|---|
| `connected` | Outbound HTTP/HTTPS allowed; wraps in `srt` to block RFC 1918 LAN & AWS/GCP metadata (`169.254.169.254`). | Playwright testing of public web apps, external documentation search. |
| `github_only` | `github.com`, `*.github.com`, `*.githubusercontent.com`. All other egress blocked. | Cloning, pushing, creating issues, inspecting pull requests. |
| `airgapped` | Empty allowlist (`outbound_domain_allowlist=[]`, `outbound_cidr_allowlist=[]`). | Running untrusted code, compiling binaries, heavy data processing. |

---

## 3. In-Sandbox `/mnt/mcp_servers` Architecture

Inside the sandbox, `/mnt/mcp_servers` provides:
- **`client.py`**: Async and synchronous JSON-RPC 2.0 stdio MCP client bridge.
- **`playwright/`**: Headless Chromium automation, accessibility scans (Axe), and visual screenshots.
- **`github/`**: Repository queries, issue tracking, and commit inspection with credential masking.
- **`filesystem/`**: Safe workspace containment, search (`rg`, `fd`), and file manipulation.
- **`skills/`**: High-fidelity document generation (`.xlsx`, `.docx`, `.pptx`, `.pdf`, matplotlib charts).

---

## 4. Zero-Cost Hibernation & Resumption

When a user turn finishes or an approval is awaited:
1. `sb.snapshot_filesystem(timeout=55, ttl=7 * 24 * 3600)` captures the exact state of `/mnt/data` and workspace modifications.
2. The sandbox terminates, incurring **zero compute cost** while idle.
3. Upon the next user turn or approved permission, `modal.Sandbox.create(image=modal.Image.from_id(snapshot_id))` resumes the exact execution environment in seconds.
