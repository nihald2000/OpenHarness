#!/usr/bin/env python3
"""Sandbox Spike & Verification Runner.

Executes Phase 2 checks against local mock sandbox or live Modal VM sandbox,
benchmarks execution speed, tests dynamic network modes, and generates structured reports.

Usage:
    python3 deploy/modal/sandbox_spike.py --all
    python3 deploy/modal/sandbox_spike.py --browser
    python3 deploy/modal/sandbox_spike.py --workspace --json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

# Add directories to path
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
DEPLOY_DIR = Path(__file__).resolve().parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
if str(DEPLOY_DIR) not in sys.path:
    sys.path.insert(0, str(DEPLOY_DIR))

from phase2_bridge import Phase2SandboxBridge


def run_spike(
    checks: list[str],
    network_mode: str = "connected",
    test_snapshot: bool = False,
    output_json: bool = False,
) -> int:
    t_start = time.perf_counter()
    report = {
        "timestamp": time.time(),
        "network_mode": network_mode,
        "checks_executed": checks,
        "results": {},
        "snapshot_id": None,
        "overall_status": "PENDING",
        "total_duration_sec": 0.0,
    }

    if not output_json:
        print("=" * 65)
        print("  OPENHARNESS MODAL SANDBOX HARNESS — PHASE 2 SPIKE RUNNER")
        print("=" * 65)
        print(f"Network Mode: {network_mode}")
        print(f"Target Checks: {', '.join(checks)}")
        print("-" * 65)

    bridge = Phase2SandboxBridge(
        tenant_id="spike-tenant",
        session_id=f"spike-{int(time.time())}",
        network_mode=network_mode,  # type: ignore
    )

    try:
        if not output_json:
            print("[1/3] Initializing sandbox & syncing MCP bridge modules...")
        init_info = bridge.initialize()
        report["sandbox_id"] = init_info["sandbox_id"]
        if not output_json:
            print(f"      Sandbox ID: {init_info['sandbox_id']}")

        if not output_json:
            print("[2/3] Executing verification checks...")

        all_ok = True
        for c in checks:
            t0 = time.perf_counter()
            res = bridge.run_check(c)
            duration_ms = round((time.perf_counter() - t0) * 1000, 2)
            report["results"][c] = res

            status_str = "PASSED" if res["passed"] else "FAILED"
            if not res["passed"]:
                all_ok = False

            if not output_json:
                print(f"      -> {c:<15} [{status_str}] ({duration_ms} ms)")
                if not res["passed"] and res.get("errors"):
                    print(f"         Errors: {res['errors']}")

        if test_snapshot:
            if not output_json:
                print("[3/3] Testing zero-cost hibernation snapshot...")
            snap_id = bridge.hibernate()
            report["snapshot_id"] = snap_id
            if not output_json:
                print(f"      Snapshot created: {snap_id}")
        else:
            bridge.terminate()

        report["overall_status"] = "PASSED" if all_ok else "FAILED"
        report["total_duration_sec"] = round(time.perf_counter() - t_start, 3)

        if not output_json:
            print("-" * 65)
            print(f"Overall Result: {report['overall_status']} (Total time: {report['total_duration_sec']}s)")
            print("=" * 65)
        else:
            print(json.dumps(report, indent=2))

        return 0 if all_ok else 1

    except Exception as exc:
        report["overall_status"] = "ERROR"
        report["error"] = str(exc)
        report["total_duration_sec"] = round(time.perf_counter() - t_start, 3)
        if output_json:
            print(json.dumps(report, indent=2))
        else:
            print(f"\n[!] Spike runner encountered error: {exc}")
        return 2


def main():
    parser = argparse.ArgumentParser(description="Modal Sandbox Phase 2 Spike Runner")
    parser.add_argument("--all", action="store_true", help="Run all Phase 2 checks")
    parser.add_argument("--browser", action="store_true", help="Run 01_browser check")
    parser.add_argument("--github", action="store_true", help="Run 02_github check")
    parser.add_argument("--workspace", action="store_true", help="Run 03_workspace check")
    parser.add_argument("--generated", action="store_true", help="Run 04_generated check")
    parser.add_argument("--network-mode", choices=["connected", "github_only", "airgapped"], default="connected")
    parser.add_argument("--snapshot", action="store_true", help="Test filesystem hibernation snapshot")
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON report")

    args = parser.parse_args()

    checks = []
    if args.all or not (args.browser or args.github or args.workspace or args.generated):
        checks = ["01_browser", "02_github", "03_workspace", "04_generated"]
    else:
        if args.browser:
            checks.append("01_browser")
        if args.github:
            checks.append("02_github")
        if args.workspace:
            checks.append("03_workspace")
        if args.generated:
            checks.append("04_generated")

    exit_code = run_spike(
        checks=checks,
        network_mode=args.network_mode,
        test_snapshot=args.snapshot,
        output_json=args.json,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
