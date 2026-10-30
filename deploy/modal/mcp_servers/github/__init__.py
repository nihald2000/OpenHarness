"""Typed GitHub wrappers for code mode.

``@modelcontextprotocol/server-github`` is deprecated and archived, so this
module wraps the ``gh`` CLI plus the REST API directly. Reads against public
repositories work unauthenticated (60 requests/hour). Writes and code search
require a token.

Security note: the production harness must **not** put a long-lived PAT in the
sandbox environment, because agent-written code can read every environment
variable. Phase 3 routes write calls through a host-side broker that mints a
short-lived, repo-scoped token per session. Until then, ``create_issue`` and
``search_code`` fail closed with ``GithubAuthError``.

    from github import get_pr_diff, list_prs, search_code

    prs = list_prs("microsoft/playwright-mcp", limit=5)
    diff = get_pr_diff("microsoft/playwright-mcp", prs[0]["number"])
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

API_ROOT = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
RAW_ROOT = os.environ.get("GITHUB_RAW_URL", "https://raw.githubusercontent.com").rstrip("/")
USER_AGENT = "openharness-code-mode/0.1"
DEFAULT_TIMEOUT = float(os.environ.get("OH_GITHUB_TIMEOUT", "30"))
MAX_CHARS = int(os.environ.get("OH_GITHUB_MAX_CHARS", "40000"))


class GithubError(RuntimeError):
    pass


class GithubAuthError(GithubError):
    """Raised when an operation needs a token that is not available."""


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _gh() -> str | None:
    return shutil.which("gh")


def _token() -> str | None:
    for key in ("GITHUB_TOKEN", "GH_TOKEN"):
        value = os.environ.get(key)
        if value:
            return value
    binary = _gh()
    if not binary:
        return None
    try:
        proc = subprocess.run(
            [binary, "auth", "token"],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    token = proc.stdout.strip()
    return token or None


def auth_status() -> dict[str, Any]:
    """Report whether writes are possible, without leaking the token."""

    token = _token()
    return {
        "gh_installed": _gh() is not None,
        "authenticated": bool(token),
        "source": "env" if os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") else (
            "gh" if token else "none"
        ),
        "writes_enabled": bool(token),
        "unauthenticated_reads": True,
    }


def _request(
    url: str,
    *,
    accept: str = "application/vnd.github+json",
    method: str = "GET",
    payload: dict[str, Any] | None = None,
    timeout: float | None = None,
) -> str:
    headers = {
        "Accept": accept,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = _token()
    if token:
        headers["Authorization"] = f"Bearer {token}"

    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout or DEFAULT_TIMEOUT) as response:
            return response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:2000]
        hint = ""
        if exc.code in (401, 403):
            hint = " (this endpoint may require authentication)"
        raise GithubError(f"GitHub API {exc.code} for {url}{hint}: {body}") from exc
    except urllib.error.URLError as exc:
        raise GithubError(f"GitHub API unreachable ({url}): {exc.reason}") from exc


def _api(path: str, **kwargs: Any) -> Any:
    return json.loads(_request(f"{API_ROOT}{path}", **kwargs))


def _gh_run(args: list[str], *, timeout: float | None = None) -> str:
    binary = _gh()
    if not binary:
        raise GithubAuthError("gh is not installed in this sandbox")
    proc = subprocess.run(
        [binary, *args],
        capture_output=True,
        text=True,
        timeout=timeout or DEFAULT_TIMEOUT * 2,
        check=False,
    )
    if proc.returncode != 0:
        raise GithubError(f"gh {' '.join(args)} failed: {proc.stderr.strip()[:1500]}")
    return proc.stdout


def _require_auth(operation: str) -> None:
    if _token():
        return
    raise GithubAuthError(
        f"{operation} needs a GitHub token. The sandbox intentionally has none: "
        "route this call through the host-side GitHub broker (Phase 3) instead of "
        "placing a PAT in the sandbox environment."
    )


def _clip(text: str, limit: int = MAX_CHARS) -> tuple[str, bool]:
    text = text or ""
    if len(text) <= limit:
        return text, False
    return text[:limit], True


# --------------------------------------------------------------------------- #
# Reads (work unauthenticated for public repositories)
# --------------------------------------------------------------------------- #


def repo_info(repo: str) -> dict[str, Any]:
    """Return a compact summary of ``owner/name``."""

    data = _api(f"/repos/{repo}")
    return {
        "full_name": data.get("full_name"),
        "description": data.get("description"),
        "stars": data.get("stargazers_count"),
        "language": data.get("language"),
        "default_branch": data.get("default_branch"),
        "open_issues": data.get("open_issues_count"),
        "private": data.get("private"),
        "url": data.get("html_url"),
    }


def list_prs(repo: str, *, state: str = "open", limit: int = 10) -> list[dict[str, Any]]:
    """List pull requests, newest first."""

    limit = max(1, min(int(limit), 50))
    if _token() and _gh():
        raw = _gh_run(
            [
                "pr",
                "list",
                "--repo",
                repo,
                "--state",
                state,
                "--limit",
                str(limit),
                "--json",
                "number,title,state,author,url,isDraft",
            ]
        )
        items = json.loads(raw or "[]")
        return [
            {
                "number": item["number"],
                "title": item["title"],
                "state": item["state"],
                "author": (item.get("author") or {}).get("login"),
                "draft": item.get("isDraft"),
                "url": item["url"],
            }
            for item in items
        ]

    data = _api(f"/repos/{repo}/pulls?state={urllib.parse.quote(state)}&per_page={limit}")
    return [
        {
            "number": item["number"],
            "title": item["title"],
            "state": item["state"],
            "author": (item.get("user") or {}).get("login"),
            "draft": item.get("draft"),
            "url": item.get("html_url"),
        }
        for item in data
    ]


def get_pr(repo: str, number: int) -> dict[str, Any]:
    """Return a compact pull request summary."""

    data = _api(f"/repos/{repo}/pulls/{int(number)}")
    return {
        "number": data.get("number"),
        "title": data.get("title"),
        "state": data.get("state"),
        "merged": data.get("merged"),
        "author": (data.get("user") or {}).get("login"),
        "base": (data.get("base") or {}).get("ref"),
        "head": (data.get("head") or {}).get("ref"),
        "additions": data.get("additions"),
        "deletions": data.get("deletions"),
        "changed_files": data.get("changed_files"),
        "body": _clip(data.get("body") or "", 4000)[0],
        "url": data.get("html_url"),
    }


def get_pr_diff(repo: str, number: int, *, max_chars: int = MAX_CHARS) -> dict[str, Any]:
    """Return a pull request diff as unified text (truncated)."""

    diff = _request(
        f"{API_ROOT}/repos/{repo}/pulls/{int(number)}",
        accept="application/vnd.github.v3.diff",
        timeout=60,
    )
    text, truncated = _clip(diff, max_chars)
    return {
        "repo": repo,
        "number": int(number),
        "diff": text,
        "chars": len(diff),
        "truncated": truncated,
    }


def get_pr_files(repo: str, number: int, *, limit: int = 50) -> list[dict[str, Any]]:
    """List changed files with patch sizes, without the full diff."""

    limit = max(1, min(int(limit), 100))
    data = _api(f"/repos/{repo}/pulls/{int(number)}/files?per_page={limit}")
    return [
        {
            "filename": item.get("filename"),
            "status": item.get("status"),
            "additions": item.get("additions"),
            "deletions": item.get("deletions"),
            "changes": item.get("changes"),
        }
        for item in data
    ]


def get_file(
    repo: str,
    path: str,
    *,
    ref: str = "HEAD",
    max_chars: int = MAX_CHARS,
) -> dict[str, Any]:
    """Fetch a file's text from a public repository."""

    url = f"{RAW_ROOT}/{repo}/{ref}/{path.lstrip('/')}"
    text = _request(url, accept="text/plain", timeout=60)
    clipped, truncated = _clip(text, max_chars)
    return {"repo": repo, "path": path, "ref": ref, "text": clipped, "truncated": truncated}


def search_issues(query: str, *, limit: int = 10) -> list[dict[str, Any]]:
    """Search issues and pull requests (works unauthenticated, rate limited)."""

    limit = max(1, min(int(limit), 50))
    data = _api(f"/search/issues?q={urllib.parse.quote(query)}&per_page={limit}")
    return [
        {
            "number": item.get("number"),
            "title": item.get("title"),
            "state": item.get("state"),
            "repo": (item.get("repository_url") or "").split("/repos/")[-1],
            "url": item.get("html_url"),
        }
        for item in data.get("items", [])
    ]


# --------------------------------------------------------------------------- #
# Writes (require auth)
# --------------------------------------------------------------------------- #


def search_code(
    query: str,
    *,
    repo: str | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Search code. GitHub requires authentication for this endpoint."""

    _require_auth("search_code")
    limit = max(1, min(int(limit), 50))
    q = f"{query} repo:{repo}" if repo else query
    data = _api(f"/search/code?q={urllib.parse.quote(q)}&per_page={limit}")
    return [
        {
            "path": item.get("path"),
            "repo": (item.get("repository") or {}).get("full_name"),
            "url": item.get("html_url"),
        }
        for item in data.get("items", [])
    ]


def create_issue(
    repo: str,
    title: str,
    body: str = "",
    *,
    labels: list[str] | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Open an issue. Pass ``dry_run=True`` to inspect the command only."""

    command = ["issue", "create", "--repo", repo, "--title", title, "--body", body]
    for label in labels or []:
        command.extend(["--label", label])

    if dry_run:
        return {"dry_run": True, "command": ["gh", *command]}

    _require_auth("create_issue")
    output = _gh_run(command, timeout=60)
    return {"ok": True, "url": output.strip().splitlines()[-1] if output.strip() else None}


def comment_issue(
    repo: str,
    number: int,
    body: str,
    *,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Comment on an issue or pull request."""

    command = ["issue", "comment", str(int(number)), "--repo", repo, "--body", body]
    if dry_run:
        return {"dry_run": True, "command": ["gh", *command]}

    _require_auth("comment_issue")
    output = _gh_run(command, timeout=60)
    return {"ok": True, "url": output.strip().splitlines()[-1] if output.strip() else None}


def create_pr(
    repo: str,
    *,
    title: str,
    head: str,
    base: str = "main",
    body: str = "",
    draft: bool = False,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Open a pull request from an existing branch."""

    command = [
        "pr",
        "create",
        "--repo",
        repo,
        "--title",
        title,
        "--head",
        head,
        "--base",
        base,
        "--body",
        body,
    ]
    if draft:
        command.append("--draft")

    if dry_run:
        return {"dry_run": True, "command": ["gh", *command]}

    _require_auth("create_pr")
    output = _gh_run(command, timeout=90)
    return {"ok": True, "url": output.strip().splitlines()[-1] if output.strip() else None}


__all__ = [
    "GithubError",
    "GithubAuthError",
    "auth_status",
    "repo_info",
    "list_prs",
    "get_pr",
    "get_pr_diff",
    "get_pr_files",
    "get_file",
    "search_issues",
    "search_code",
    "create_issue",
    "comment_issue",
    "create_pr",
]
