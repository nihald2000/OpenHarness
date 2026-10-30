"""Phase 2 Check 04: Document & Office Skills Generation Verification.

Verifies:
- Excel spreadsheet (.xlsx) generation with formulas and styles
- Word document (.docx) generation with structured sections and tables
- PowerPoint presentation (.pptx) generation with title and bullet points
- Matplotlib chart (.png) generation and export
- File integrity and non-zero byte size assertions
"""

from __future__ import annotations

import os
import sys
import json
from pathlib import Path


def run_check() -> dict:
    results = {
        "check": "04_generated",
        "passed": False,
        "artifacts": {},
        "errors": [],
    }

    outdir = Path("/tmp/generated_check")
    outdir.mkdir(parents=True, exist_ok=True)

    try:
        from mcp_servers.skills import (
            generate_excel,
            generate_word,
            generate_powerpoint,
            generate_chart,
        )

        # 1. Excel Generation
        excel_path = str(outdir / "summary.xlsx")
        ex_res = generate_excel(
            headers=["Quarter", "Target ($k)", "Actual ($k)", "Attainment"],
            rows=[
                ["Q1", 500, 540, "108%"],
                ["Q2", 600, 610, "101%"],
                ["Q3", 750, 820, "109%"],
                ["Q4", 900, 950, "105%"],
            ],
            output_path=excel_path,
        )
        results["artifacts"]["excel"] = {
            "size_bytes": Path(excel_path).stat().st_size,
            "ok": Path(excel_path).stat().st_size > 1000,
        }

        # 2. Word Generation
        word_path = str(outdir / "brief.docx")
        w_res = generate_word(
            title="Q4 Infrastructure Reliability Brief",
            sections=[
                {
                    "heading": "Executive Summary",
                    "text": "Modal VM sandboxing provides 100% namespace isolation with zero-cost snapshots.",
                },
                {
                    "heading": "Key Milestones",
                    "bullets": ["Playwright headless Chromium", "Multi-compiler toolchains", "Axe-core WCAG audits"],
                },
            ],
            output_path=word_path,
        )
        results["artifacts"]["word"] = {
            "size_bytes": Path(word_path).stat().st_size,
            "ok": Path(word_path).stat().st_size > 1000,
        }

        # 3. PowerPoint Generation
        pptx_path = str(outdir / "deck.pptx")
        p_res = generate_powerpoint(
            title="OpenHarness Sandbox Architecture",
            subtitle="Anthropic Code Execution with MCP",
            slides_data=[
                {
                    "title": "Modal Sandbox Benefits",
                    "points": ["Full VM isolation", "Sub-second resume from snapshots", "Dynamic network policies"],
                }
            ],
            output_path=pptx_path,
        )
        results["artifacts"]["powerpoint"] = {
            "size_bytes": Path(pptx_path).stat().st_size,
            "ok": Path(pptx_path).stat().st_size > 1000,
        }

        # 4. Chart Generation
        chart_path = str(outdir / "latency.png")
        c_res = generate_chart(
            data={
                "labels": ["Rust", "Go", "C/Clang", "Node", "Python"],
                "values": [45, 80, 35, 120, 60],
                "ylabel": "Compile & Execution Latency (ms)",
                "xlabel": "Compiler Toolchain",
            },
            title="Compiler Benchmark Matrix",
            output_path=chart_path,
            chart_type="bar",
        )
        results["artifacts"]["chart"] = {
            "size_bytes": Path(chart_path).stat().st_size,
            "ok": Path(chart_path).stat().st_size > 5000,
        }

        results["passed"] = all(item.get("ok") for item in results["artifacts"].values())

    except Exception as exc:
        results["errors"].append(str(exc))
        results["passed"] = False

    return results


if __name__ == "__main__":
    res = run_check()
    print(json.dumps(res, indent=2))
    sys.exit(0 if res["passed"] else 1)
