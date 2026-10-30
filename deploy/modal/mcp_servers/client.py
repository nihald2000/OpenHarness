"""Async MCP stdio bridge with a persistent, per-server daemon.

Code-mode agents do not load MCP tool schemas into their context. They import a
small typed Python module (``playwright``, ``github``, ``filesystem``) that calls
into this bridge. The bridge keeps one MCP server subprocess alive per server
name and exposes it over a Unix socket, so browser state survives across
separate ``sb.exec`` calls inside the sandbox.

Layout::

    /mnt/mcp_servers/client.py          <- this file
    /tmp/oh-mcp/<server>.sock           <- daemon socket
    /tmp/oh-mcp/<server>.ready.json     <- readiness + tool list
    /tmp/oh-mcp/<server>.log            <- daemon + MCP server stderr

CLI::

    python client.py serve  --name playwright --spec '<json>'
    python client.py list   --name playwright
    python client.py call   --name playwright --tool browser_navigate --args '{"url": "..."}'
    python client.py status --name playwright
    python client.py stop   --name playwright
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SOCKET_DIR = Path(os.environ.get("OH_MCP_SOCKET_DIR", "/tmp/oh-mcp"))
READY_TIMEOUT = float(os.environ.get("OH_MCP_READY_TIMEOUT", "120"))
CALL_TIMEOUT = float(os.environ.get("OH_MCP_CALL_TIMEOUT", "120"))

# Safety cap on a single MCP payload. Wrappers filter large trees in sandbox
# memory, so this is a backstop, not the normal path.
MAX_PAYLOAD_CHARS = int(os.environ.get("OH_MCP_MAX_PAYLOAD_CHARS", "2000000"))


# --------------------------------------------------------------------------- #
# Server specs
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ServerSpec:
    """How to launch one MCP server."""

    name: str
    command: str
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    cwd: str | None = None
    timeout: float = CALL_TIMEOUT

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "command": self.command,
            "args": list(self.args),
            "env": dict(self.env),
            "cwd": self.cwd,
            "timeout": self.timeout,
        }

    @classmethod
    def from_json(cls, raw: dict[str, Any]) -> "ServerSpec":
        return cls(
            name=raw["name"],
            command=raw["command"],
            args=tuple(raw.get("args") or ()),
            env=dict(raw.get("env") or {}),
            cwd=raw.get("cwd"),
            timeout=float(raw.get("timeout") or CALL_TIMEOUT),
        )


def _first_on_path(*candidates: str) -> str | None:
    for candidate in candidates:
        found = shutil.which(candidate)
        if found:
            return found
    return None


def default_specs() -> dict[str, ServerSpec]:
    """Servers available in the production image.

    ``playwright`` is the only one that must be an MCP server. GitHub access
    goes through the ``gh``/``git`` wrappers because
    ``@modelcontextprotocol/server-github`` is deprecated and archived.
    """

    specs: dict[str, ServerSpec] = {}

    pw_bin = _first_on_path(
        os.environ.get("OH_PLAYWRIGHT_MCP_BIN", ""),
        "playwright-mcp",
        "mcp-server-playwright",
    )
    if pw_bin:
        artifact_dir = os.environ.get("OH_ARTIFACT_DIR", "/mnt/data/artifacts")
        specs["playwright"] = ServerSpec(
            name="playwright",
            command=pw_bin,
            args=(
                "--headless",
                "--isolated",
                "--no-sandbox",
                # Without this, Playwright MCP defaults to the `chrome` channel
                # and fails with "Chromium distribution 'chrome' is not found
                # at /opt/google/chrome/chrome". `chromium` maps to the
                # chrome-for-testing channel that `playwright install chromium`
                # puts in PLAYWRIGHT_BROWSERS_PATH.
                "--browser",
                "chromium",
                "--viewport-size",
                "1280x720",
                # Screenshots are written to disk and read back by path, so
                # base64 image payloads would only bloat the context.
                "--image-responses",
                "omit",
                "--output-dir",
                artifact_dir,
            ),
            env={
                "PLAYWRIGHT_BROWSERS_PATH": os.environ.get(
                    "PLAYWRIGHT_BROWSERS_PATH", "/ms-playwright"
                )
            },
            timeout=180.0,
        )

    # Optional: the official filesystem MCP server. The ``filesystem`` wrapper
    # module uses direct Python I/O with path confinement instead, because the
    # agent already runs Python in the sandbox. Registered here so
    # ``discover_mcp_modules`` can still enumerate it when installed.
    fs_bin = _first_on_path("mcp-server-filesystem")
    if fs_bin:
        specs["filesystem_mcp"] = ServerSpec(
            name="filesystem_mcp",
            command=fs_bin,
            args=(os.environ.get("OH_WORKSPACE", "/mnt/data"),),
            timeout=60.0,
        )

    return specs


# --------------------------------------------------------------------------- #
# MCP session
# --------------------------------------------------------------------------- #


class MCPBridgeError(RuntimeError):
    """Raised when the bridge or the MCP server fails."""


def _content_payload(result: Any) -> dict[str, Any]:
    texts: list[str] = []
    images: list[dict[str, str]] = []
    resources: list[dict[str, Any]] = []

    for block in getattr(result, "content", None) or []:
        kind = getattr(block, "type", None)
        if kind == "text":
            texts.append(getattr(block, "text", "") or "")
        elif kind == "image":
            images.append(
                {
                    "mimeType": getattr(block, "mimeType", "application/octet-stream"),
                    "data": getattr(block, "data", "") or "",
                }
            )
        elif kind == "resource":
            resource = getattr(block, "resource", None)
            resources.append(
                {
                    "uri": getattr(resource, "uri", ""),
                    "text": getattr(resource, "text", None),
                    "mimeType": getattr(resource, "mimeType", None),
                }
            )
        else:
            texts.append(str(block))

    text = "\n".join(part for part in texts if part)
    truncated = False
    if len(text) > MAX_PAYLOAD_CHARS:
        text = text[:MAX_PAYLOAD_CHARS]
        truncated = True

    return {
        "text": text,
        "images": images,
        "resources": resources,
        "is_error": bool(getattr(result, "isError", False)),
        "truncated": truncated,
    }


class MCPSession:
    """One live MCP stdio session. Async context manager."""

    def __init__(self, spec: ServerSpec) -> None:
        self.spec = spec
        self.session: Any = None
        self._stack: contextlib.AsyncExitStack | None = None

    async def __aenter__(self) -> "MCPSession":
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        env = {**os.environ, **self.spec.env}
        params = StdioServerParameters(
            command=self.spec.command,
            args=list(self.spec.args),
            env=env,
            cwd=self.spec.cwd,
        )

        self._stack = contextlib.AsyncExitStack()
        try:
            read, write = await self._stack.enter_async_context(stdio_client(params))
            self.session = await self._stack.enter_async_context(
                ClientSession(read, write)
            )
            await self.session.initialize()
        except BaseException:
            await self._stack.aclose()
            self._stack = None
            raise
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self._stack is not None:
            await self._stack.aclose()
            self._stack = None

    async def list_tools(self) -> list[dict[str, Any]]:
        from code_mode import normalize_tools  # local import avoids a cycle

        result = await self.session.list_tools()
        return normalize_tools(result.tools)

    async def call_tool(
        self,
        name: str,
        arguments: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        from datetime import timedelta

        timeout = float(timeout or self.spec.timeout)
        result = await self.session.call_tool(
            name,
            arguments or {},
            read_timeout_seconds=timedelta(seconds=timeout),
        )
        return _content_payload(result)


# --------------------------------------------------------------------------- #
# Daemon
# --------------------------------------------------------------------------- #


def socket_path(name: str) -> Path:
    return SOCKET_DIR / f"{name}.sock"


def ready_path(name: str) -> Path:
    return SOCKET_DIR / f"{name}.ready.json"


def log_path(name: str) -> Path:
    return SOCKET_DIR / f"{name}.log"


def _error(exc: BaseException) -> dict[str, Any]:
    return {"ok": False, "error": {"type": type(exc).__name__, "message": str(exc)}}


async def serve(spec: ServerSpec) -> int:
    """Run one MCP server behind a Unix-socket JSON-lines daemon."""

    SOCKET_DIR.mkdir(parents=True, exist_ok=True)
    sock = socket_path(spec.name)
    ready = ready_path(spec.name)

    for stale in (sock, ready):
        with contextlib.suppress(FileNotFoundError):
            stale.unlink()

    loop = asyncio.get_running_loop()
    requests: asyncio.Queue[tuple[dict[str, Any], asyncio.Future[dict[str, Any]]]] = (
        asyncio.Queue()
    )
    stopping = asyncio.Event()

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            line = await reader.readline()
            if not line:
                return
            try:
                payload = json.loads(line.decode("utf-8"))
            except json.JSONDecodeError as exc:
                writer.write(json.dumps(_error(exc)).encode() + b"\n")
                await writer.drain()
                return

            future: asyncio.Future[dict[str, Any]] = loop.create_future()
            await requests.put((payload, future))
            try:
                response = await future
            except asyncio.CancelledError:
                response = _error(MCPBridgeError("request cancelled"))
            writer.write(json.dumps(response).encode() + b"\n")
            await writer.drain()
        except (ConnectionResetError, BrokenPipeError):
            pass
        except Exception as exc:  # noqa: BLE001 - never kill the daemon
            with contextlib.suppress(Exception):
                writer.write(json.dumps(_error(exc)).encode() + b"\n")
                await writer.drain()
        finally:
            with contextlib.suppress(Exception):
                writer.close()
                await writer.wait_closed()

    # Requests can carry large payloads (an inline axe-core bundle is ~560 KB),
    # which is well past asyncio's 64 KiB default line limit.
    server = await asyncio.start_unix_server(
        handle,
        path=str(sock),
        limit=int(os.environ.get("OH_MCP_STREAM_LIMIT", str(16 * 1024 * 1024))),
    )
    os.chmod(sock, 0o600)

    def _stop(*_: Any) -> None:
        stopping.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, _stop)

    async with MCPSession(spec) as session:
        tools = await session.list_tools()
        ready.write_text(
            json.dumps(
                {
                    "name": spec.name,
                    "pid": os.getpid(),
                    "socket": str(sock),
                    "command": spec.command,
                    "tools": [tool["name"] for tool in tools],
                    "started_at": time.time(),
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        async with server:
            while not stopping.is_set():
                get = asyncio.ensure_future(requests.get())
                stop = asyncio.ensure_future(stopping.wait())
                done, _ = await asyncio.wait(
                    {get, stop}, return_when=asyncio.FIRST_COMPLETED
                )
                if get not in done:
                    get.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await get
                    break
                stop.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await stop

                payload, future = get.result()
                op = payload.get("op", "call_tool")
                if op == "shutdown":
                    if not future.done():
                        future.set_result({"ok": True, "result": {"stopping": True}})
                    break

                try:
                    if op == "ping":
                        result: Any = {"pong": True, "pid": os.getpid()}
                    elif op == "list_tools":
                        result = await session.list_tools()
                    elif op == "call_tool":
                        result = await session.call_tool(
                            payload["tool"],
                            payload.get("arguments") or {},
                            payload.get("timeout"),
                        )
                    else:
                        raise MCPBridgeError(f"unknown op: {op!r}")
                    response = {"ok": True, "result": result}
                except Exception as exc:  # noqa: BLE001 - surfaced to the caller
                    response = _error(exc)

                if not future.done():
                    future.set_result(response)

    with contextlib.suppress(FileNotFoundError):
        sock.unlink()
    with contextlib.suppress(FileNotFoundError):
        ready.unlink()
    return 0


# --------------------------------------------------------------------------- #
# Client
# --------------------------------------------------------------------------- #


def _request(name: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    sock = socket_path(name)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
        conn.settimeout(timeout)
        conn.connect(str(sock))
        try:
            conn.sendall(json.dumps(payload).encode("utf-8") + b"\n")
        except BrokenPipeError as exc:
            raise MCPBridgeError(
                f"MCP daemon {name!r} closed the connection while receiving "
                f"a {len(payload.get('arguments', {}).get('function', '')) or 0}-byte payload"
            ) from exc
        chunks: list[bytes] = []
        while True:
            chunk = conn.recv(1 << 16)
            if not chunk:
                break
            chunks.append(chunk)
            if chunk.endswith(b"\n"):
                break
    raw = b"".join(chunks)
    if not raw:
        raise MCPBridgeError(f"MCP daemon {name!r} closed the connection")
    return json.loads(raw.decode("utf-8"))


def is_running(name: str) -> bool:
    if not socket_path(name).exists():
        return False
    try:
        response = _request(name, {"op": "ping"}, timeout=5.0)
    except (OSError, MCPBridgeError, json.JSONDecodeError):
        return False
    return bool(response.get("ok"))


def read_ready(name: str) -> dict[str, Any] | None:
    try:
        return json.loads(ready_path(name).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def ensure_daemon(spec: ServerSpec, *, timeout: float = READY_TIMEOUT) -> dict[str, Any]:
    """Return readiness info, starting the daemon if it is not already up."""

    if is_running(spec.name):
        ready = read_ready(spec.name) or {}
        if not ready.get("tools"):
            try:
                ready["tools"] = [t["name"] for t in list_tools(spec.name)]
            except MCPBridgeError:
                pass
        return ready

    SOCKET_DIR.mkdir(parents=True, exist_ok=True)
    lock = SOCKET_DIR / f"{spec.name}.lock"

    # Serialize concurrent starters. flock is released when the fd closes.
    with open(lock, "a+b") as lock_file:
        try:
            import fcntl

            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError):
            pass

        if is_running(spec.name):
            return read_ready(spec.name) or {}

        for stale in (socket_path(spec.name), ready_path(spec.name)):
            with contextlib.suppress(FileNotFoundError):
                stale.unlink()

        log = log_path(spec.name)
        with open(log, "ab") as log_file:
            log_file.write(
                f"\n=== starting {spec.name} at {time.strftime('%H:%M:%S')} ===\n".encode()
            )
            log_file.flush()
            subprocess.Popen(
                [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "serve",
                    "--name",
                    spec.name,
                    "--spec",
                    json.dumps(spec.to_json()),
                ],
                stdin=subprocess.DEVNULL,
                stdout=log_file,
                stderr=log_file,
                start_new_session=True,
                close_fds=True,
            )

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if is_running(spec.name):
            return read_ready(spec.name) or {}
        if socket_path(spec.name).exists() and ready_path(spec.name).exists():
            return read_ready(spec.name) or {}
        time.sleep(0.2)

    tail = ""
    with contextlib.suppress(OSError):
        tail = log_path(spec.name).read_text(encoding="utf-8", errors="replace")[-4000:]
    raise MCPBridgeError(
        f"MCP daemon {spec.name!r} did not become ready in {timeout:.0f}s.\n{tail}"
    )


def list_tools(name: str, *, timeout: float = 60.0) -> list[dict[str, Any]]:
    response = _request(name, {"op": "list_tools"}, timeout=timeout)
    if not response.get("ok"):
        raise MCPBridgeError(_format_error(name, response))
    return response["result"]


def call(
    name: str,
    tool: str,
    arguments: dict[str, Any] | None = None,
    *,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Call an MCP tool and return ``{text, images, resources, is_error}``."""

    response = _request(
        name,
        {
            "op": "call_tool",
            "tool": tool,
            "arguments": arguments or {},
            "timeout": timeout,
        },
        timeout=float(timeout or CALL_TIMEOUT) + 30.0,
    )
    if not response.get("ok"):
        raise MCPBridgeError(_format_error(name, response))
    return response["result"]


def stop(name: str) -> bool:
    if not socket_path(name).exists():
        return False
    with contextlib.suppress(OSError, MCPBridgeError, json.JSONDecodeError):
        _request(name, {"op": "shutdown"}, timeout=10.0)
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        if not socket_path(name).exists():
            return True
        time.sleep(0.1)
    return False


def _format_error(name: str, response: dict[str, Any]) -> str:
    error = response.get("error") or {}
    return f"{name}: {error.get('type', 'Error')}: {error.get('message', 'unknown error')}"


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def _spec_from_args(args: argparse.Namespace) -> ServerSpec:
    if args.spec:
        return ServerSpec.from_json(json.loads(args.spec))
    specs = default_specs()
    if args.name not in specs:
        raise SystemExit(
            f"unknown server {args.name!r}; known: {', '.join(sorted(specs)) or 'none'}"
        )
    return specs[args.name]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="client.py", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    serve_p = sub.add_parser("serve", help="run the daemon in the foreground")
    serve_p.add_argument("--name", required=True)
    serve_p.add_argument("--spec", help="JSON ServerSpec; defaults to the built-in spec")

    list_p = sub.add_parser("list", help="list tools for a server")
    list_p.add_argument("--name", default="playwright")
    list_p.add_argument("--spec")
    list_p.add_argument("--json", action="store_true")

    call_p = sub.add_parser("call", help="call one tool")
    call_p.add_argument("--name", default="playwright")
    call_p.add_argument("--spec")
    call_p.add_argument("--tool", required=True)
    call_p.add_argument("--args", default="{}")
    call_p.add_argument("--timeout", type=float, default=None)

    status_p = sub.add_parser("status", help="show daemon status")
    status_p.add_argument("--name", default="playwright")

    stop_p = sub.add_parser("stop", help="stop a daemon")
    stop_p.add_argument("--name", default="playwright")

    args = parser.parse_args(argv)

    if args.command == "serve":
        return asyncio.run(serve(_spec_from_args(args)))

    if args.command == "list":
        spec = _spec_from_args(args)
        ensure_daemon(spec)
        tools = list_tools(spec.name)
        if args.json:
            print(json.dumps(tools, indent=2))
        else:
            for tool in tools:
                print(f"{tool['name']}\t{tool.get('title') or ''}")
        return 0

    if args.command == "call":
        spec = _spec_from_args(args)
        ensure_daemon(spec)
        result = call(
            spec.name,
            args.tool,
            json.loads(args.args),
            timeout=args.timeout,
        )
        print(json.dumps(result, indent=2)[:12000])
        return 1 if result.get("is_error") else 0

    if args.command == "status":
        running = is_running(args.name)
        print(
            json.dumps(
                {
                    "name": args.name,
                    "running": running,
                    "ready": read_ready(args.name),
                    "socket": str(socket_path(args.name)),
                    "log": str(log_path(args.name)),
                },
                indent=2,
            )
        )
        return 0 if running else 1

    if args.command == "stop":
        stopped = stop(args.name)
        print(json.dumps({"name": args.name, "stopped": stopped}))
        return 0 if stopped else 1

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
