"""Typed Playwright code-mode wrappers.

The agent imports this module and calls functions; it never sees the Playwright
MCP tool schemas. Large accessibility trees are parsed and pruned *inside the
sandbox* so only a compact node list reaches the model.

    from playwright import navigate, snapshot_dom, click, type_text

    page = navigate("https://example.com")
    print(page["title"], len(page["nodes"]))

    snap = snapshot_dom(max_nodes=40)
    click(snap["nodes"][0]["ref"])
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

_HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from client import MCPBridgeError, call as _call, ensure_daemon, default_specs  # noqa: E402

SERVER = "playwright"
ARTIFACT_DIR = Path(os.environ.get("OH_ARTIFACT_DIR", "/mnt/data/artifacts"))
DEFAULT_MAX_NODES = int(os.environ.get("OH_SNAPSHOT_MAX_NODES", "120"))
DEFAULT_MAX_DEPTH = int(os.environ.get("OH_SNAPSHOT_MAX_DEPTH", "8"))

# Roles that are worth keeping even without a ref: they carry meaning or text.
KEEP_ROLES = {
    "heading",
    "link",
    "button",
    "textbox",
    "searchbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "option",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "menuitem",
    "img",
    "image",
    "paragraph",
    "listitem",
    "cell",
    "columnheader",
    "rowheader",
    "alert",
    "status",
    "dialog",
    "text",
    "code",
    "strong",
    "emphasis",
    "blockquote",
}
# Structural wrappers: keep only when they have kept children.
DROP_IF_EMPTY = {"generic", "none", "presentation", "group", "region", "main", "contentinfo"}

_ROLE_RE = re.compile(r"^([A-Za-z_][\w-]*)")
_REF_RE = re.compile(r"\[ref=([^\]]+)\]")
_ATTR_RE = re.compile(r"\[([A-Za-z][\w-]*)(?:=([^\]]*))?\]")
_HEADER_RE = re.compile(r"^-\s*Page (URL|Title):\s*(.*)$")
_NODE_RE = re.compile(r"^(\s*)-\s?(.*)$")


def _ensure() -> None:
    ensure_daemon(default_specs()[SERVER])


def _call_tool(tool: str, arguments: dict[str, Any], *, timeout: float | None = None) -> dict[str, Any]:
    _ensure()
    return _call(SERVER, tool, arguments, timeout=timeout)


def _text(tool: str, arguments: dict[str, Any], *, timeout: float | None = None) -> str:
    result = _call_tool(tool, arguments, timeout=timeout)
    if result.get("is_error"):
        raise MCPBridgeError(f"{tool} failed: {_clip(result.get('text', ''), 800)}")
    return result.get("text", "")


def _clip(text: str, limit: int) -> str:
    text = text or ""
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _maybe_json(text: str) -> Any:
    stripped = (text or "").strip()
    if not stripped or stripped[0] not in "[{":
        return text
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return text


# --------------------------------------------------------------------------- #
# Snapshot parsing / filtering
# --------------------------------------------------------------------------- #


def _split_value(body: str) -> tuple[str, str]:
    """Split ``role "name" [attr]: value`` into (head, value), ignoring colons
    inside quoted names."""

    in_quote = False
    escaped = False
    for index, char in enumerate(body):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if char == '"':
            in_quote = not in_quote
            continue
        if char == ":" and not in_quote:
            rest = body[index + 1 :]
            if rest.startswith(" "):
                return body[:index], rest[1:]
            if rest == "":
                return body[:index], ""
    return body, ""


def _parse_line(body: str) -> dict[str, Any] | None:
    body = body.strip()
    if not body or body.startswith("```"):
        return None

    head, value = _split_value(body)
    role_match = _ROLE_RE.match(head.strip())
    if not role_match:
        return None

    role = role_match.group(1)
    rest = head.strip()[len(role) :]

    name = ""
    name_match = re.search(r'"((?:[^"\\]|\\.)*)"', rest)
    if name_match:
        name = name_match.group(1).replace('\\"', '"')

    ref_match = _REF_RE.search(head)
    ref = ref_match.group(1) if ref_match else ""

    attrs = [
        match.group(1) + (f"={match.group(2)}" if match.group(2) else "")
        for match in _ATTR_RE.finditer(head)
        if match.group(1) != "ref"
    ]

    return {
        "role": role,
        "name": name,
        "ref": ref,
        "value": value.strip(),
        "attrs": attrs,
    }


def parse_snapshot(text: str) -> dict[str, Any]:
    """Parse a Playwright MCP snapshot into a pruned node list."""

    url = ""
    title = ""
    roots: list[dict[str, Any]] = []
    stack: list[tuple[int, dict[str, Any]]] = []

    for raw_line in (text or "").splitlines():
        header = _HEADER_RE.match(raw_line.strip())
        if header:
            if header.group(1) == "URL":
                url = header.group(2).strip()
            else:
                title = header.group(2).strip()
            continue

        match = _NODE_RE.match(raw_line)
        if not match:
            continue

        indent = len(match.group(1).expandtabs(2)) // 2
        node = _parse_line(match.group(2))
        if node is None:
            continue
        node["depth"] = indent
        node["children"] = []

        while stack and stack[-1][0] >= indent:
            stack.pop()
        if stack:
            stack[-1][1]["children"].append(node)
        else:
            roots.append(node)
        stack.append((indent, node))

    total = 0
    kept = 0
    truncated = False
    max_nodes = DEFAULT_MAX_NODES
    max_depth = DEFAULT_MAX_DEPTH

    def prune(node: dict[str, Any], depth: int) -> dict[str, Any] | None:
        nonlocal total, kept, truncated
        total += 1
        if depth > max_depth:
            truncated = True
            return None

        children = []
        for child in node["children"]:
            pruned = prune(child, depth + 1)
            if pruned is not None:
                children.append(pruned)

        meaningful = (
            bool(node["ref"])
            or node["role"] in KEEP_ROLES
            or bool(node["name"])
            or bool(node["value"])
        )
        if not meaningful and not children:
            return None
        if node["role"] in DROP_IF_EMPTY and not children and not node["ref"] and not node["name"]:
            return None

        kept += 1
        if kept > max_nodes:
            truncated = True
            return None

        out = {
            "role": node["role"],
            "name": _clip(node["name"], 120),
            "ref": node["ref"],
            "depth": depth,
        }
        if node["value"]:
            out["value"] = _clip(node["value"], 200)
        if node["attrs"]:
            out["attrs"] = node["attrs"][:6]
        if children:
            out["children"] = children
        return out

    nodes = []
    for root in roots:
        pruned = prune(root, 0)
        if pruned is not None:
            nodes.append(pruned)

    return {
        "url": url,
        "title": title,
        "nodes": nodes,
        "count": kept,
        "total_nodes": total,
        "truncated": truncated,
    }


def _flatten(nodes: list[dict[str, Any]], out: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for node in nodes:
        out.append({k: v for k, v in node.items() if k != "children"})
        _flatten(node.get("children") or [], out)
    return out


def format_snapshot(snapshot: dict[str, Any]) -> str:
    """Render a snapshot as compact ``[ref] role "name"`` lines."""

    lines = []
    if snapshot.get("title"):
        lines.append(f"# {snapshot['title']}")
    for node in _flatten(snapshot.get("nodes") or [], []):
        ref = f"[{node['ref']}] " if node.get("ref") else ""
        name = f' "{node["name"]}"' if node.get("name") else ""
        value = f": {node['value']}" if node.get("value") else ""
        lines.append(f"{'  ' * node['depth']}{ref}{node['role']}{name}{value}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Navigation and interaction
# --------------------------------------------------------------------------- #


def navigate(
    url: str,
    *,
    snapshot: bool = True,
    max_nodes: int | None = None,
) -> dict[str, Any]:
    """Navigate to ``url`` and return a filtered snapshot of the landing page."""

    result = _call_tool("browser_navigate", {"url": url}, timeout=120)
    if result.get("is_error"):
        raise MCPBridgeError(f"navigate failed: {_clip(result.get('text', ''), 800)}")

    out: dict[str, Any] = {"ok": True, "message": _clip(result.get("text", ""), 600)}
    if snapshot:
        snap = snapshot_dom(max_nodes=max_nodes)
        out.update(
            {
                "url": snap["url"],
                "title": snap["title"],
                "nodes": snap["nodes"],
                "count": snap["count"],
                "truncated": snap["truncated"],
            }
        )
    return out


def snapshot_dom(
    *,
    target: str | None = None,
    max_nodes: int | None = None,
    max_depth: int | None = None,
) -> dict[str, Any]:
    """Capture the accessibility tree and prune it before returning.

    ``max_nodes`` / ``max_depth`` default to ``OH_SNAPSHOT_MAX_NODES`` and
    ``OH_SNAPSHOT_MAX_DEPTH``. Set them lower to save context.
    """

    global DEFAULT_MAX_NODES, DEFAULT_MAX_DEPTH
    saved = (DEFAULT_MAX_NODES, DEFAULT_MAX_DEPTH)
    if max_nodes is not None:
        DEFAULT_MAX_NODES = int(max_nodes)
    if max_depth is not None:
        DEFAULT_MAX_DEPTH = int(max_depth)
    try:
        arguments: dict[str, Any] = {}
        if target:
            arguments["target"] = target
        text = _text("browser_snapshot", arguments, timeout=120)
        return parse_snapshot(text)
    finally:
        DEFAULT_MAX_NODES, DEFAULT_MAX_DEPTH = saved


def click(target: str, element: str | None = None, *, double: bool = False) -> dict[str, Any]:
    """Click an element by snapshot ref (``e12``) or CSS selector."""

    arguments: dict[str, Any] = {"target": target}
    if element:
        arguments["element"] = element
    if double:
        arguments["doubleClick"] = True
    return {"ok": True, "message": _clip(_text("browser_click", arguments), 600)}


def type_text(
    target: str,
    text: str,
    *,
    submit: bool = False,
    slowly: bool = False,
    element: str | None = None,
) -> dict[str, Any]:
    """Fill an input by snapshot ref or CSS selector."""

    arguments: dict[str, Any] = {"target": target, "text": text}
    if element:
        arguments["element"] = element
    if submit:
        arguments["submit"] = True
    if slowly:
        arguments["slowly"] = True
    return {"ok": True, "message": _clip(_text("browser_type", arguments), 600)}


fill = type_text


def press_key(key: str) -> dict[str, Any]:
    return {"ok": True, "message": _clip(_text("browser_press_key", {"key": key}), 300)}


def find(*, text: str | None = None, regex: str | None = None) -> dict[str, Any]:
    """Search the snapshot for text without downloading the whole tree."""

    if bool(text) == bool(regex):
        raise ValueError("pass exactly one of text= or regex=")
    arguments = {"text": text} if text else {"regex": regex}
    return {"ok": True, "text": _text("browser_find", arguments)}


def wait_for(
    *,
    text: str | None = None,
    text_gone: str | None = None,
    time: float | None = None,
) -> dict[str, Any]:
    arguments: dict[str, Any] = {}
    if text:
        arguments["text"] = text
    if text_gone:
        arguments["textGone"] = text_gone
    if time is not None:
        arguments["time"] = min(float(time), 30.0)
    if not arguments:
        raise ValueError("pass text=, text_gone=, or time=")
    return {"ok": True, "message": _clip(_text("browser_wait_for", arguments), 300)}


def evaluate(function: str, *, target: str | None = None) -> Any:
    """Evaluate JavaScript in the page and return parsed JSON when possible."""

    arguments: dict[str, Any] = {"function": function}
    if target:
        arguments["target"] = target
    return _maybe_json(_text("browser_evaluate", arguments, timeout=120))


def page_url() -> str:
    value = evaluate("() => location.href")
    return value if isinstance(value, str) else str(value)


def console(*, level: str = "info", all: bool = False) -> str:
    return _text("browser_console_messages", {"level": level, "all": all})


def network_requests(*, static: bool = False, filter: str | None = None) -> str:
    arguments: dict[str, Any] = {"static": static}
    if filter:
        arguments["filter"] = filter
    return _text("browser_network_requests", arguments)


# --------------------------------------------------------------------------- #
# Screenshots and artifacts
# --------------------------------------------------------------------------- #


def screenshot(
    filename: str | None = None,
    *,
    full_page: bool = False,
    target: str | None = None,
    kind: str | None = None,
) -> dict[str, Any]:
    """Take a screenshot into ``OH_ARTIFACT_DIR`` and return its local path."""

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    if filename is None:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        filename = str(ARTIFACT_DIR / f"page-{stamp}.png")
    elif not os.path.isabs(filename):
        filename = str(ARTIFACT_DIR / filename)

    arguments: dict[str, Any] = {"filename": filename}
    if full_page:
        arguments["fullPage"] = True
    if target:
        arguments["target"] = target
    if kind:
        arguments["type"] = kind

    text = _text("browser_take_screenshot", arguments, timeout=120)
    path = Path(filename)
    return {
        "ok": path.exists(),
        "path": str(path),
        "bytes": path.stat().st_size if path.exists() else 0,
        "message": _clip(text, 300),
    }


# --------------------------------------------------------------------------- #
# Accessibility audit
# --------------------------------------------------------------------------- #

_AXE_CANDIDATES = (
    "/usr/lib/node_modules/axe-core/axe.min.js",
    "/usr/local/lib/node_modules/axe-core/axe.min.js",
    "/usr/lib/node_modules/axe-core/axe.js",
)


def _axe_source() -> str:
    explicit = os.environ.get("OH_AXE_PATH")
    candidates = ([explicit] if explicit else []) + list(_AXE_CANDIDATES)
    for candidate in candidates:
        path = Path(candidate)
        if path.is_file():
            return path.read_text(encoding="utf-8")
    raise FileNotFoundError(
        "axe-core not found; install it with `npm i -g axe-core` or set OH_AXE_PATH"
    )


def run_axe_audit(
    *,
    tags: list[str] | None = None,
    max_violations: int = 20,
    max_targets: int = 3,
) -> dict[str, Any]:
    """Run axe-core in the page and return a compact violation summary.

    The full axe result is megabytes; only ids, impact, node counts, and a few
    sample selectors come back to the model.
    """

    source = _axe_source()
    if len(source) > 2_000_000:
        raise ValueError(f"axe source is too large to inline ({len(source)} bytes)")

    options = {"runOnly": {"type": "tag", "values": tags}} if tags else {}
    function = f"""() => {{
{source}
const axe = window.axe || globalThis.axe;
return axe.run(document, {json.dumps(options)}).then((r) => ({{
  violations: r.violations.map((v) => ({{
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, {int(max_targets)}).map((n) => n.target.join(" ")),
  }})),
  passes: r.passes.length,
  incomplete: r.incomplete.length,
  inapplicable: r.inapplicable.length,
}}));
}}"""

    try:
        raw = _text("browser_evaluate", {"function": function}, timeout=180)
    except Exception as exc:  # noqa: BLE001 - an audit must not kill the session
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:600]}
    result = _maybe_json(raw)
    if not isinstance(result, dict):
        return {"ok": False, "raw": _clip(str(result), 2000)}
    violations = result.get("violations") or []
    return {
        "ok": True,
        "url": page_url(),
        "violations": violations[:max_violations],
        "violation_count": len(violations),
        "node_count": sum(v.get("nodes", 0) for v in violations),
        "passes": result.get("passes", 0),
        "incomplete": result.get("incomplete", 0),
        "inapplicable": result.get("inapplicable", 0),
    }


# --------------------------------------------------------------------------- #
# Lifecycle
# --------------------------------------------------------------------------- #


def close() -> dict[str, Any]:
    """Close the page. The MCP server stays up for the next call."""

    return {"ok": True, "message": _clip(_text("browser_close", {}), 300)}


def health() -> dict[str, Any]:
    spec = default_specs()[SERVER]
    ready = ensure_daemon(spec)
    return {"server": SERVER, "command": spec.command, "tools": ready.get("tools", [])}


__all__ = [
    "navigate",
    "snapshot_dom",
    "parse_snapshot",
    "format_snapshot",
    "click",
    "type_text",
    "fill",
    "press_key",
    "find",
    "wait_for",
    "evaluate",
    "page_url",
    "console",
    "network_requests",
    "screenshot",
    "run_axe_audit",
    "close",
    "health",
]
