"""Production Modal.com Sandbox Image Definition.

Defines the hardened Ubuntu 24.04 sandbox image equipped with:
- Compilers & runtimes (Python 3.12, Node 22, Rust, Go, Clang, gcc/g++)
- Headless Chromium & Playwright with full OS dependencies
- Anthropic Sandbox Runtime (srt) with bubblewrap and network isolation profiles
- MCP servers (@playwright/mcp, @modelcontextprotocol/server-github, @modelcontextprotocol/server-filesystem)
- CLI productivity tools (git, gh, ripgrep, fd-find, jq, sqlite3, duckdb)
- Document processing engines (Pandoc, LibreOffice, Poppler, ReportLab, OpenPyXL, Docx, PPTX)
- In-sandbox MCP Python bridge layout (/mnt/mcp_servers)
"""

from __future__ import annotations

import os
from typing import Optional

try:
    import modal
    HAS_MODAL = True
except ImportError:
    modal = None  # type: ignore
    HAS_MODAL = False


APP_NAME = "agent-harness"
SANDBOX_WORKDIR = "/mnt/data"
MCP_SERVERS_DIR = "/mnt/mcp_servers"
ARTIFACTS_DIR = "/mnt/artifacts"


def get_modal_app(app_name: str = APP_NAME):
    """Retrieves or creates the Modal App using current SDK lookup semantics."""
    if not HAS_MODAL:
        raise RuntimeError("The 'modal' package is required. Install via 'pip install modal'.")
    return modal.App.lookup(app_name, create_if_missing=True)


def build_harness_image():
    """Builds the comprehensive multi-compiler, browser, and MCP sandbox image.

    Target OS: Ubuntu 24.04 LTS with Python 3.12.
    Configured for VM runtime to support unprivileged bubblewrap and Chromium sandboxing.
    """
    if not HAS_MODAL:
        raise RuntimeError("The 'modal' package is required to build the image.")

    image = (
        modal.Image.from_registry("ubuntu:24.04", add_python="3.12")
        .env({
            "DEBIAN_FRONTEND": "noninteractive",
            "PYTHONUNBUFFERED": "1",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": "/root/.cargo/bin:/usr/local/go/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
            "PYTHONPATH": f"{MCP_SERVERS_DIR}:{SANDBOX_WORKDIR}:$PYTHONPATH",
        })
        # 1. Base system dependencies & core compilers
        .run_commands(
            "apt-get update && apt-get install -y --no-install-recommends "
            "build-essential "
            "clang "
            "llvm "
            "gcc "
            "g++ "
            "gfortran "
            "make "
            "cmake "
            "curl "
            "wget "
            "ca-certificates "
            "gnupg "
            "lsb-release "
            "pkg-config "
            "libssl-dev "
            "zlib1g-dev "
            "libffi-dev "
            "git "
            "gh "
            "ripgrep "
            "fd-find "
            "jq "
            "sqlite3 "
            "libsqlite3-dev "
            "bubblewrap "
            "socat "
            "xvfb "
            "unzip "
            "tar "
            "nano "
            "tree "
            "&& rm -rf /var/lib/apt/lists/*"
        )
        # 2. Document & Office tools
        .run_commands(
            "apt-get update && apt-get install -y --no-install-recommends "
            "pandoc "
            "libreoffice "
            "libreoffice-writer "
            "libreoffice-calc "
            "libreoffice-impress "
            "poppler-utils "
            "fonts-dejavu "
            "fonts-liberation "
            "fonts-noto-color-emoji "
            "libimage-exiftool-perl "
            "&& rm -rf /var/lib/apt/lists/*"
        )
        # 3. Rust compiler & Cargo
        .run_commands(
            "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable && "
            "/root/.cargo/bin/rustc --version"
        )
        # 4. Go runtime
        .run_commands(
            "GO_VERSION=1.23.2 && "
            "wget -q https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz && "
            "tar -C /usr/local -xzf go${GO_VERSION}.linux-amd64.tar.gz && "
            "rm go${GO_VERSION}.linux-amd64.tar.gz && "
            "/usr/local/go/bin/go version"
        )
        # 5. Node.js LTS (22.x), npm, pnpm & MCP server packages
        .run_commands(
            "mkdir -p /etc/apt/keyrings && "
            "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && "
            "NODE_MAJOR=22 && "
            "echo \"deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main\" > /etc/apt/sources.list.d/nodesource.list && "
            "apt-get update && apt-get install -y nodejs && "
            "npm install -g npm@latest pnpm@latest && "
            "npm install -g "
            "@anthropic-ai/sandbox-runtime "
            "@playwright/mcp "
            "@modelcontextprotocol/server-github "
            "@modelcontextprotocol/server-filesystem "
            "@axe-core/cli "
            "lighthouse "
            "&& rm -rf /var/lib/apt/lists/*"
        )
        # 6. Python packages & modern CLI tools (uv, duckdb, office/document libs, playwright, pytest)
        .run_commands(
            "python3 -m pip install --no-cache-dir --upgrade pip uv setuptools wheel && "
            "uv pip install --system --no-cache "
            "playwright "
            "pytest "
            "pytest-asyncio "
            "duckdb "
            "pandas "
            "numpy "
            "matplotlib "
            "openpyxl "
            "python-docx "
            "python-pptx "
            "reportlab "
            "pypdf "
            "requests "
            "httpx "
            "aiohttp "
            "pydantic "
            "mcp"
        )
        # 7. Install Playwright browser dependencies and Chromium
        .run_commands(
            "playwright install --with-deps chromium"
        )
        # 8. Create standard directories and Anthropic Sandbox Runtime (srt) profile configs
        .run_commands(
            f"mkdir -p {SANDBOX_WORKDIR} {MCP_SERVERS_DIR} {ARTIFACTS_DIR} /etc/srt /tmp /var/log/harness && "
            "chmod 777 /mnt/data /mnt/artifacts /tmp && "
            # Set up srt connected profile (blocks link-local / cloud metadata endpoints)
            "cat << 'EOF' > /etc/srt/connected.json\n"
            "{\n"
            '  "deny_ips": ["169.254.169.254", "100.100.100.200", "127.0.0.0/8"],\n'
            '  "allow_dns": true,\n'
            '  "filesystem": "isolate_temp"\n'
            "}\n"
            "EOF\n"
            # Set up srt airgapped profile (complete network isolation)
            "cat << 'EOF' > /etc/srt/airgapped.json\n"
            "{\n"
            '  "deny_ips": ["0.0.0.0/0", "::/0"],\n'
            '  "allow_dns": false,\n'
            '  "filesystem": "isolate_temp"\n'
            "}\n"
            "EOF\n"
        )
    )

    return image


# Cached default harness image definition
if HAS_MODAL:
    harness_image = build_harness_image()
else:
    harness_image = None
