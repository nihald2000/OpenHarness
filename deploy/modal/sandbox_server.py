"""Deploy the always-on Modal sandbox hub used by pinned Modal sessions."""

from __future__ import annotations

import json
import os
import pathlib
import subprocess

import modal


def find_repo_root() -> pathlib.Path:
    source = pathlib.Path(__file__).resolve()
    candidates = [source.parent, *source.parents, pathlib.Path.cwd()]
    for candidate in candidates:
        if (candidate / "packages").is_dir() and (candidate / "package.json").is_file():
            return candidate
    # Modal imports the uploaded module from /root at runtime. The repository
    # sources are already present at /opt/oh in the image at that point.
    image_root = pathlib.Path("/opt/oh")
    if (image_root / "packages").is_dir() and (image_root / "package.json").is_file():
        return image_root
    raise RuntimeError("Could not locate the OpenHarness repository root")


ROOT = find_repo_root()
APP_NAME = "openharness-sandboxd"
PLAYWRIGHT = "1.48.2"

app = modal.App(APP_NAME)
workspaces_vol = modal.Volume.from_name("openharness-workspaces", create_if_missing=True)

smoke_test = """bash -lc 'set -e -o pipefail; setpriv --version >/dev/null; OH_MODAL_SANDBOX_KEY=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa OH_VM_ISOLATED=1 OH_DISABLE_SRT=1 node /opt/oh/oh-sandboxd-hub.mjs --host 127.0.0.1 --port 18080 --root /tmp/oh-smoke & PID=$!; trap "kill $PID 2>/dev/null || true" EXIT; curl --retry 20 --retry-connrefused --retry-delay 1 -fsS http://127.0.0.1:18080/health | jq -e ".ok == true and .mode == \\\"pinned-hub\\\"" >/dev/null; curl -fsS -X POST http://127.0.0.1:18080/sessions/init -H "x-session-key: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" -H "x-oh-sandbox-id: smoke_session" -H "content-type: application/json" -d "{}" | jq -e ".ok == true" >/dev/null; curl -fsS -X POST http://127.0.0.1:18080/shell/main/exec -H "x-session-key: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" -H "x-oh-sandbox-id: smoke_session" -H "content-type: application/json" -d "{\\\"command\\\":\\\"python3 -c \\\\\\\"print(42)\\\\\\\"\\\",\\\"timeoutSec\\\":10}" | jq -e ".exitCode == 0 and (.output | contains(\\\"42\\\"))" >/dev/null; rm -rf /tmp/oh-smoke /tmp/oh/smoke_session'"""
sandbox_image = (
    modal.Image.from_registry("node:22-bookworm-slim", add_python="3.11")
    .apt_install(
        "ca-certificates", "curl", "git", "jq", "ripgrep", "tar", "gzip", "unzip",
        "build-essential", "procps", "util-linux", "findutils", "sqlite3", "postgresql", "redis-server", "chromium",
        "fonts-liberation", "fonts-dejavu-core", "fonts-noto-core", "fonts-noto-color-emoji", "fontconfig",
        "libreoffice-writer", "libreoffice-calc", "libreoffice-impress", "poppler-utils", "pandoc", "qpdf",
        "libpango-1.0-0", "libpangoft2-1.0-0", "libcairo2", "libgdk-pixbuf-2.0-0", "libffi-dev", "shared-mime-info",
    )
    .env({"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright", "NODE_PATH": "/opt/oh/node_modules"})
    .add_local_dir(str(ROOT / "packages"), remote_path="/opt/oh/packages", copy=True)
    .add_local_file(str(ROOT / "package.json"), remote_path="/opt/oh/package.json", copy=True)
    .run_commands(
        f"cd /opt/oh && npm install --no-audit --no-fund --no-save esbuild tsx playwright@{PLAYWRIGHT} @playwright/test@{PLAYWRIGHT} docx pptxgenjs @mermaid-js/mermaid-cli",
        "python3 -m pip install --no-cache-dir --break-system-packages python-docx openpyxl XlsxWriter python-pptx weasyprint reportlab pypdf pdfplumber pdf2image pypdfium2 matplotlib seaborn pillow pandas numpy tabulate markdown beautifulsoup4 lxml markitdown",
        "printf '%s\\n' '{\"executablePath\":\"/usr/bin/chromium\",\"args\":[\"--no-sandbox\",\"--disable-setuid-sandbox\",\"--disable-dev-shm-usage\"]}' > /opt/oh/mermaid-puppeteer.json",
        "fc-cache -f",
        "chmod -R a+rX /opt/oh",
        "find /opt/oh/packages -type f \\( -name '*.ts' -o -name '*.mjs' -o -name '*.js' -o -name '*.json' \\) -exec sed -i 's/\\r$//' {} +",
        "chromium --version && chmod -R a+rX /opt/oh",
        "python3 -c 'import docx, openpyxl, xlsxwriter, pptx, weasyprint, reportlab, pypdf, pdfplumber, matplotlib, seaborn, PIL, pandas; print(\"doc_stack_ok\")' && soffice --version && pdftoppm -v 2>&1 | head -n 1 && pandoc --version | head -n 1",
        "cd /opt/oh && npx esbuild packages/sandboxd/src/hub.ts --bundle --platform=node --target=node22 --format=esm --external:ws --external:playwright --external:playwright-core --outfile=/opt/oh/oh-sandboxd-hub.mjs",
        f"{smoke_test}",
        "node -e 'const fs=require(\"fs\"),path=require(\"path\"); for (const p of [\"playwright\",\"@playwright/test\"]) { const entry=require.resolve(p); const v=JSON.parse(fs.readFileSync(path.join(path.dirname(entry),\"package.json\"),\"utf8\")).version; if(v!==\"1.48.2\") throw new Error(p+\" version mismatch: \"+v) }' && sqlite3 --version && redis-server --version && pg_lsclusters",
        "cd /opt/oh && node -e 'const {chromium}=require(\"playwright\"); (async()=>{const b=await chromium.launch({executablePath:\"/usr/bin/chromium\",headless:true,args:[\"--no-sandbox\",\"--disable-setuid-sandbox\",\"--disable-dev-shm-usage\"]}); const p=await b.newPage(); await p.goto(\"about:blank\"); await b.close()})().catch(e=>{console.error(e);process.exit(1)})'",
    )
)


@app.function(
    image=sandbox_image,
    volumes={"/workspaces": workspaces_vol},
    secrets=[modal.Secret.from_name("openharness-sandbox-key")],
    cpu=1.0,
    memory=3072,
    timeout=3600,
    max_containers=1,
    min_containers=int(os.environ.get("OH_SANDBOX_MIN_CONTAINERS", "1")),
    scaledown_window=600,
)
@modal.concurrent(max_inputs=100)
@modal.web_server(8080, startup_timeout=60)
def sandboxd():
    shared_key = os.environ.get("OH_MODAL_SANDBOX_KEY", "").strip()
    if len(shared_key) < 32:
        raise RuntimeError("Secret openharness-sandbox-key must define OH_MODAL_SANDBOX_KEY (>= 32 chars)")
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
        "HOME": "/root",
        "LANG": "C.UTF-8",
        "OH_MODAL_SANDBOX_KEY": shared_key,
        "OH_WORKSPACES_ROOT": "/workspaces",
        "OH_VM_ISOLATED": "1",
        "OH_DISABLE_SRT": "1",
        "OH_HUB_PER_SESSION_UID": "1",
        "NODE_PATH": "/opt/oh/node_modules",
        "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
        "CHROMIUM_EXECUTABLE_PATH": "/usr/bin/chromium",
        "OH_LIVE_ALLOWED_ORIGINS": os.environ.get("OH_LIVE_ALLOWED_ORIGINS", "https://openharness-web-six.vercel.app"),
    }
    subprocess.Popen(
        ["node", "/opt/oh/oh-sandboxd-hub.mjs", "--host", "0.0.0.0", "--port", "8080", "--root", "/workspaces"],
        cwd="/tmp",
        env=env,
    )
