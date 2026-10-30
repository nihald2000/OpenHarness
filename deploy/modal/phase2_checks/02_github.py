"""Check 2: GitHub wrappers, unauthenticated reads, fail-closed writes."""

from __future__ import annotations

import json
import sys

sys.path.insert(0, "/mnt/mcp_servers")

from github import (  # noqa: E402
    GithubAuthError,
    auth_status,
    create_issue,
    get_pr_diff,
    list_prs,
    repo_info,
)

REPO = "microsoft/playwright-mcp"


def main() -> int:
    out: dict = {"auth": auth_status()}

    try:
        out["repo"] = repo_info(REPO)
    except Exception as exc:  # noqa: BLE001 - reported, not raised
        out["repo_error"] = f"{type(exc).__name__}: {exc}"[:400]

    try:
        prs = list_prs(REPO, limit=3)
        out["prs"] = prs
        if prs:
            diff = get_pr_diff(REPO, prs[0]["number"], max_chars=600)
            out["diff"] = {
                "number": diff["number"],
                "chars": diff["chars"],
                "truncated": diff["truncated"],
                "head": diff["diff"][:200],
            }
    except Exception as exc:  # noqa: BLE001
        out["prs_error"] = f"{type(exc).__name__}: {exc}"[:400]

    out["create_issue_dry_run"] = create_issue(
        REPO, "phase2 probe", "body", labels=["bug"], dry_run=True
    )

    try:
        from github import search_code

        search_code("playwright", repo=REPO)
        out["search_code"] = "UNEXPECTED SUCCESS"
    except GithubAuthError as exc:
        out["search_code"] = "fail-closed: " + str(exc)[:160]
    except Exception as exc:  # noqa: BLE001
        out["search_code"] = f"{type(exc).__name__}: {exc}"[:200]

    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
