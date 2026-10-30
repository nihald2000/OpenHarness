"""Playwright Headless Browser & Accessibility Automation Module."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional


_GLOBAL_BROWSER = None
_GLOBAL_PAGE = None


def _ensure_browser():
    global _GLOBAL_BROWSER, _GLOBAL_PAGE
    if _GLOBAL_PAGE is not None:
        return _GLOBAL_PAGE
    from playwright.sync_api import sync_playwright
    p = sync_playwright().start()
    _GLOBAL_BROWSER = p.chromium.launch(
        headless=True,
        args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    )
    _GLOBAL_PAGE = _GLOBAL_BROWSER.new_page()
    return _GLOBAL_PAGE


def navigate(url: str, wait_until: str = "load", timeout_ms: int = 30000) -> Dict[str, Any]:
    """Navigates browser to target URL and returns page title and status code."""
    page = _ensure_browser()
    response = page.goto(url, wait_until=wait_until, timeout=timeout_ms)
    return {
        "url": page.url,
        "title": page.title(),
        "status": response.status if response else 200,
        "ok": True,
    }


def screenshot(output_path: str = "/mnt/data/screenshot.png", full_page: bool = True) -> Dict[str, Any]:
    """Captures a screenshot of the current viewport or full document."""
    page = _ensure_browser()
    target = Path(output_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(target), full_page=full_page)
    return {
        "path": str(target),
        "size_bytes": target.stat().st_size,
        "ok": True,
    }


def evaluate_js(expression: str) -> Any:
    """Evaluates JavaScript inside page context and returns JSON-compatible result."""
    page = _ensure_browser()
    return page.evaluate(expression)


def click(selector: str, timeout_ms: int = 5000) -> Dict[str, Any]:
    """Clicks an element matching the selector."""
    page = _ensure_browser()
    page.click(selector, timeout=timeout_ms)
    return {"clicked": selector, "ok": True}


def fill(selector: str, value: str, timeout_ms: int = 5000) -> Dict[str, Any]:
    """Types a value into an input matching the selector."""
    page = _ensure_browser()
    page.fill(selector, value, timeout=timeout_ms)
    return {"filled": selector, "ok": True}


def get_text(selector: str = "body") -> str:
    """Extracts text content of matching element."""
    page = _ensure_browser()
    element = page.query_selector(selector)
    return element.inner_text() if element else ""


def axe_audit() -> Dict[str, Any]:
    """Runs an automated Axe WCAG accessibility audit against the current page."""
    page = _ensure_browser()
    # Inject Axe-core if available via node/cli or CDN
    inject_script = """
    async () => {
        if (!window.axe) {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.9.1/axe.min.js';
            document.head.appendChild(script);
            await new Promise(r => script.onload = r);
        }
        return await window.axe.run();
    }
    """
    try:
        results = page.evaluate(inject_script)
        violations = [
            {
                "id": v.get("id"),
                "impact": v.get("impact"),
                "description": v.get("description"),
                "nodes": len(v.get("nodes", [])),
            }
            for v in results.get("violations", [])
        ]
        return {
            "violations": violations,
            "passes_count": len(results.get("passes", [])),
            "incomplete_count": len(results.get("incomplete", [])),
            "score": round(len(results.get("passes", [])) / (len(results.get("passes", [])) + len(violations) + 1e-6) * 100, 1),
        }
    except Exception as exc:
        return {"error": str(exc), "violations": []}
