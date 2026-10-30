"""GitHub MCP & API Module for Anthropic Code-Mode Execution."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


def _get_github_token() -> Optional[str]:
    return os.environ.get("GITHUB_PERSONAL_ACCESS_TOKEN") or os.environ.get("GITHUB_TOKEN")


def _github_api_request(endpoint: str, method: str = "GET", data: Optional[Dict[str, Any]] = None) -> Any:
    token = _get_github_token()
    url = f"https://api.github.com/{endpoint.lstrip('/')}"
    headers = {
        "User-Agent": "modal-agent-harness",
        "Accept": "application/vnd.github.v3+json",
    }
    if token:
        headers["Authorization"] = f"token {token}"

    body_bytes = json.dumps(data).encode("utf-8") if data else None
    req = urllib.request.Request(url, data=body_bytes, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read().decode("utf-8")
            return json.loads(content) if content else {}
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GitHub API Error {exc.code} for {endpoint}: {err_body}") from exc
    except Exception as exc:
        raise RuntimeError(f"GitHub connection failed: {exc}") from exc


def search_repositories(query: str, limit: int = 10) -> List[Dict[str, Any]]:
    """Searches public repositories on GitHub and returns condensed metadata."""
    encoded_query = urllib.parse.quote(query)
    data = _github_api_request(f"search/repositories?q={encoded_query}&per_page={limit}")
    items = data.get("items", [])
    return [
        {
            "full_name": item.get("full_name"),
            "html_url": item.get("html_url"),
            "description": item.get("description"),
            "stars": item.get("stargazers_count"),
            "forks": item.get("forks_count"),
            "language": item.get("language"),
        }
        for item in items
    ]


def get_file_contents(owner: str, repo: str, path: str, ref: str = "main") -> str:
    """Retrieves file contents from a repository."""
    import base64
    endpoint = f"repos/{owner}/{repo}/contents/{path}?ref={ref}"
    data = _github_api_request(endpoint)
    if "content" in data and data.get("encoding") == "base64":
        return base64.b64decode(data["content"]).decode("utf-8", errors="replace")
    raise ValueError(f"Content for {path} not found or unsupported format")


def list_issues(owner: str, repo: str, state: str = "open", limit: int = 20) -> List[Dict[str, Any]]:
    """Lists repository issues with high-bandwidth fields stripped."""
    data = _github_api_request(f"repos/{owner}/{repo}/issues?state={state}&per_page={limit}")
    return [
        {
            "number": issue.get("number"),
            "title": issue.get("title"),
            "state": issue.get("state"),
            "author": (issue.get("user") or {}).get("login"),
            "comments_count": issue.get("comments"),
            "created_at": issue.get("created_at"),
            "html_url": issue.get("html_url"),
        }
        for issue in data
        if not issue.get("pull_request")
    ]


def create_issue(owner: str, repo: str, title: str, body: str, labels: Optional[List[str]] = None) -> Dict[str, Any]:
    """Creates a new issue on GitHub."""
    payload = {"title": title, "body": body}
    if labels:
        payload["labels"] = labels
    res = _github_api_request(f"repos/{owner}/{repo}/issues", method="POST", data=payload)
    return {
        "number": res.get("number"),
        "title": res.get("title"),
        "html_url": res.get("html_url"),
        "state": res.get("state"),
    }
