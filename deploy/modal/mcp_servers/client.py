"""Async & Synchronous MCP Stdio Client Bridge for Modal Sandboxes."""

from __future__ import annotations

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
            payload = {
                "jsonrpc": "2.0",
                "id": self._request_id,
                "method": method,
                "params": params or {},
            }
            body = json.dumps(payload).encode("utf-8") + b"\n"
            self.process.stdin.write(body)
            await self.process.stdin.drain()

            # Read response line
            raw_line = await self.process.stdout.readline()
            if not raw_line:
                stderr_output = ""
                if self.process.stderr:
                    err_bytes = await self.process.stderr.read()
                    stderr_output = err_bytes.decode("utf-8", errors="replace")
                raise RuntimeError(f"MCP server closed stream unexpectedly. Stderr: {stderr_output}")

            try:
                res = json.loads(raw_line.decode("utf-8"))
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Invalid JSON from MCP server: {raw_line.decode('utf-8', errors='replace')}") from exc

            if "error" in res:
                err = res["error"]
                raise RuntimeError(f"MCP Error [{err.get('code')}]: {err.get('message')} - {err.get('data')}")

            return res.get("result")

    async def _send_notification(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        if self.process is None or self.process.stdin is None:
            return
        async with self._lock:
            payload = {
                "jsonrpc": "2.0",
                "method": method,
                "params": params or {},
            }
            body = json.dumps(payload).encode("utf-8") + b"\n"
            self.process.stdin.write(body)
            await self.process.stdin.drain()

    async def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        """Invokes a tool on the MCP server and returns the parsed result."""
        result = await self._send_request("tools/call", {"name": name, "arguments": arguments or {}})
        return result

    async def list_tools(self) -> List[Dict[str, Any]]:
        """Lists tools available from this MCP server."""
        res = await self._send_request("tools/list", {})
        return (res or {}).get("tools", [])

    async def close(self) -> None:
        """Terminates the MCP server process gracefully."""
        if self.process is not None:
            try:
                if self.process.stdin:
                    self.process.stdin.close()
                self.process.terminate()
                await asyncio.wait_for(self.process.wait(), timeout=3.0)
            except Exception:
                if self.process:
                    self.process.kill()
            finally:
                self.process = None

    def call_tool_sync(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        """Synchronous wrapper for tool execution."""
        return asyncio.run(self.call_tool(name, arguments))


def get_sync_client(command: List[str], env: Optional[Dict[str, str]] = None) -> SyncMCPClientWrapper:
    """Creates a synchronous client wrapper for simple script usage."""
    return SyncMCPClientWrapper(command, env)


class SyncMCPClientWrapper:
    """Synchronous lifecycle wrapper around MCPClient."""

    def __init__(self, command: List[str], env: Optional[Dict[str, str]] = None):
        self._client = MCPClient(command, env)
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def _get_loop(self) -> asyncio.AbstractEventLoop:
        try:
            return asyncio.get_running_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            return loop

    def __enter__(self) -> SyncMCPClientWrapper:
        loop = self._get_loop()
        loop.run_until_complete(self._client.start())
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        loop = self._get_loop()
        loop.run_until_complete(self._client.close())

    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        loop = self._get_loop()
        return loop.run_until_complete(self._client.call_tool(name, arguments))

    def list_tools(self) -> List[Dict[str, Any]]:
        loop = self._get_loop()
        return loop.run_until_complete(self._client.list_tools())
