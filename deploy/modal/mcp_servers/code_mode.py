"""Code-mode wrapper generation for the MCP bridge.

The point of code execution with MCP is to keep tool schemas *out* of the model
context. This module turns ``tools/list`` output into:

* ``index.json`` - a compact, human/agent readable catalogue of servers,
  tools, parameters, and local wrapper modules.
* ``_generated_<server>.py`` - importable Python functions, one per MCP tool,
  so the agent writes ``browser_navigate(url="...")`` instead of hand-rolling
  JSON-RPC.

Usage::

    python code_mode.py build  --server playwright
    python code_mode.py index  --print
"""

from __future__ import annotations

import argparse
import json
import keyword
import re
import time
from pathlib import Path
from typing import Any, Iterable

JSON_TYPES = {
    "string": "str",
    "number": "float",
    "integer": "int",
    "boolean": "bool",
    "array": "list",
    "object": "dict",
    "null": "None",
}


def normalize_tools(tools: Iterable[Any]) -> list[dict[str, Any]]:
    """Convert MCP ``Tool`` objects (or dicts) into plain dictionaries."""

    normalized: list[dict[str, Any]] = []
    for tool in tools:
        if isinstance(tool, dict):
            raw = tool
        else:
            raw = {
                "name": getattr(tool, "name", ""),
                "description": getattr(tool, "description", "") or "",
                "inputSchema": getattr(tool, "inputSchema", None) or {},
            }
        schema = raw.get("inputSchema") or {}
        properties = schema.get("properties") or {}
        required = set(schema.get("required") or [])

        params = []
        for name, spec in properties.items():
            spec = spec or {}
            params.append(
                {
                    "name": name,
                    "type": spec.get("type", "any"),
                    "required": name in required,
                    "description": _one_line(spec.get("description", "")),
                }
            )
        params.sort(key=lambda item: (not item["required"], item["name"]))

        normalized.append(
            {
                "name": raw.get("name", ""),
                "title": raw.get("title") or "",
                "description": _one_line(raw.get("description", "")),
                "params": params,
            }
        )

    normalized.sort(key=lambda item: item["name"])
    return normalized


def _one_line(text: str, limit: int = 200) -> str:
    flat = " ".join((text or "").split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def _identifier(name: str) -> str:
    cleaned = re.sub(r"\W", "_", name).strip("_") or "tool"
    if cleaned[0].isdigit():
        cleaned = f"tool_{cleaned}"
    if keyword.iskeyword(cleaned):
        cleaned = f"{cleaned}_"
    return cleaned


def _doc_line(text: str) -> str:
    """Escape a line so it is safe inside a generated docstring."""

    return (text or "").replace("\\", "\\\\").replace('"""', "'''")


def emit_wrappers(
    server: str,
    tools: list[dict[str, Any]],
    out_dir: str | Path,
    *,
    bridge_module: str = "client",
) -> Path:
    """Write one importable function per tool and return the module path."""

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"_generated_{_identifier(server)}.py"

    lines = [
        f'"""Generated wrappers for the {server!r} MCP server.',
        "",
        "Do not edit by hand: regenerate with ``python code_mode.py build``.",
        '"""',
        "",
        "from __future__ import annotations",
        "",
        "from typing import Any",
        "",
        f"from {bridge_module} import call as _call",
        "",
        "",
        "def _invoke(tool: str, arguments: dict[str, Any]) -> dict[str, Any]:",
        f"    return _call({server!r}, tool, {{k: v for k, v in arguments.items() if v is not None}})",
        "",
        "",
        f"SERVER = {server!r}",
        f"TOOLS = {json.dumps([tool['name'] for tool in tools])}",
        "",
        "",
    ]

    for tool in tools:
        func = _identifier(tool["name"])
        required = [p for p in tool["params"] if p["required"]]
        optional = [p for p in tool["params"] if not p["required"]]

        signature = [f"{_identifier(p['name'])}: {JSON_TYPES.get(p['type'], 'Any')}" for p in required]
        for param in optional:
            signature.append(
                f"{_identifier(param['name'])}: {JSON_TYPES.get(param['type'], 'Any')} | None = None"
            )
        signature.append("**extra: Any")

        doc = [tool["description"] or tool["name"]]
        if tool["params"]:
            doc.append("")
            doc.append("Args:")
            for param in tool["params"]:
                marker = "" if param["required"] else ", optional"
                doc.append(
                    f"    {_identifier(param['name'])} ({param['type']}{marker}): {param['description']}"
                )

        lines.append(f"def {func}({', '.join(signature)}) -> dict[str, Any]:")
        lines.append(f'    """{_doc_line(doc[0])}')
        for doc_line in doc[1:]:
            lines.append(f"    {_doc_line(doc_line)}".rstrip())
        lines.append('    """')
        lines.append("    arguments: dict[str, Any] = {")
        for param in tool["params"]:
            ident = _identifier(param["name"])
            lines.append(f"        {param['name']!r}: {ident},")
        lines.append("    }")
        lines.append("    arguments.update(extra)")
        lines.append(f"    return _invoke({tool['name']!r}, arguments)")
        lines.append("")
        lines.append("")

    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return path


def build_index(
    servers: dict[str, dict[str, Any]],
    *,
    out_path: str | Path,
    modules: dict[str, str] | None = None,
    pythonpath: str = "/mnt/mcp_servers",
) -> dict[str, Any]:
    """Write ``index.json`` describing servers, tools, and wrapper modules."""

    index = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "pythonpath": pythonpath,
        "servers": servers,
        "modules": modules or {},
        "usage": (
            "Import a module and call typed functions. Filter large results "
            "in sandbox memory; never print a full DOM or a full API payload."
        ),
    }
    path = Path(out_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(index, indent=2), encoding="utf-8")
    return index


def render_summary(index: dict[str, Any], *, max_tools: int = 12) -> str:
    """Compact text form for the model's context window."""

    lines: list[str] = []
    modules = index.get("modules") or {}
    if modules:
        lines.append("Python modules (import these, do not call MCP directly):")
        for name, description in sorted(modules.items()):
            lines.append(f"  - {name}: {description}")

    for server, info in sorted((index.get("servers") or {}).items()):
        tools = info.get("tools") or []
        lines.append("")
        lines.append(f"MCP server {server!r}: {len(tools)} tools")
        for tool in tools[:max_tools]:
            params = ", ".join(
                f"{p['name']}:{p['type']}" + ("" if p["required"] else "?")
                for p in tool.get("params") or []
            )
            lines.append(f"  - {tool['name']}({params})")
        if len(tools) > max_tools:
            lines.append(f"  … {len(tools) - max_tools} more in index.json")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="code_mode.py", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    build_p = sub.add_parser("build", help="generate wrappers + index.json")
    build_p.add_argument("--server", action="append", default=None)
    build_p.add_argument("--out-dir", default="/mnt/mcp_servers")
    build_p.add_argument("--index", default=None)

    index_p = sub.add_parser("index", help="print index.json")
    index_p.add_argument("--path", default="/mnt/mcp_servers/index.json")

    args = parser.parse_args(argv)

    if args.command == "index":
        index = json.loads(Path(args.path).read_text(encoding="utf-8"))
        print(render_summary(index))
        return 0

    if args.command == "build":
        from client import default_specs, ensure_daemon, list_tools

        specs = default_specs()
        names = args.server or ["playwright"]
        servers: dict[str, dict[str, Any]] = {}
        modules: dict[str, str] = {}

        for name in names:
            if name not in specs:
                raise SystemExit(f"unknown server {name!r}; known: {', '.join(sorted(specs))}")
            spec = specs[name]
            ensure_daemon(spec)
            tools = list_tools(spec.name)
            servers[name] = {
                "transport": "stdio",
                "command": [spec.command, *spec.args],
                "tools": tools,
            }
            module = emit_wrappers(name, tools, args.out_dir)
            modules[name] = f"generated from {name}; {len(tools)} functions ({module.name})"

        out = args.index or str(Path(args.out_dir) / "index.json")
        index = build_index(servers, out_path=out, modules=modules, pythonpath=args.out_dir)
        print(render_summary(index))
        print(f"\nwrote {out}")
        return 0

    return 2


if __name__ == "__main__":
    raise SystemExit(main())
