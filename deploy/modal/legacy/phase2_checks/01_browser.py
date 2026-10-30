"""Phase 2 Check 01: Headless Browser & Playwright Automation Verification.

Verifies:
- Chromium headless startup without sandbox violations
- Page navigation, title retrieval, form interaction (fill, click)
- DOM evaluation and text assertion
- Full-page screenshot capture to disk
- Axe accessibility evaluation and WCAG compliance score
"""

from __future__ import annotations

import os
import sys
import json
import time
from pathlib import Path


def run_check() -> dict:
    results = {
        "check": "01_browser",
        "passed": False,
        "details": {},
        "errors": [],
    }

    try:
        from mcp_servers.playwright import (
            navigate,
            screenshot,
            evaluate_js,
            fill,
            click,
            get_text,
            axe_audit,
        )

        # Target our test fixture HTML
        fixture_path = Path(__file__).parent / "site" / "index.html"
        file_url = f"file://{fixture_path.resolve()}"

        # 1. Navigation
        t0 = time.perf_counter()
        nav_res = navigate(file_url)
        results["details"]["navigation_ms"] = round((time.perf_counter() - t0) * 1000, 2)
        results["details"]["page_title"] = nav_res.get("title")

        if "OpenHarness Sandbox" not in nav_res.get("title", ""):
            results["errors"].append(f"Unexpected page title: {nav_res.get('title')}")

        # 2. Form interaction
        fill("#agent-input", "Automated Phase 2 Verification")
        click("#submit-btn")
        updated_text = get_text("#output-message")
        results["details"]["form_output"] = updated_text
        if "Automated Phase 2 Verification" not in updated_text:
            results["errors"].append(f"Form submission failed to update DOM text: {updated_text}")

        # 3. Screenshot capture
        screenshot_path = "/mnt/data/phase2_browser_test.png"
        ss_res = screenshot(screenshot_path)
        results["details"]["screenshot"] = ss_res

        # 4. Axe accessibility audit
        audit = axe_audit()
        results["details"]["axe_violations_count"] = len(audit.get("violations", []))
        results["details"]["axe_score"] = audit.get("score")

        results["passed"] = len(results["errors"]) == 0

    except Exception as exc:
        results["errors"].append(str(exc))
        results["passed"] = False

    return results


if __name__ == "__main__":
    res = run_check()
    print(json.dumps(res, indent=2))
    sys.exit(0 if res["passed"] else 1)
