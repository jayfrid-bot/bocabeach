#!/usr/bin/env python3
"""'Is anything broken?' in one command:  npm run ci

Replaces GitHub's failure emails. Three states show up in the run list and only
one of them is a problem:

  failure    a real fault. Printed with a link straight to the log.
  cancelled  NOT a fault. The lightning, GOES, MRMS and cam-vision feeds each
             run a long loop, and every scheduled start deliberately cancels the
             loop already running. Cancelled is the design working.
  (running)  in flight, reported separately so it is never mistaken for a fault.

What matters is the NEWEST finished run of each workflow. An older failure that
has since gone green is history, not an open problem.
"""

import json
import subprocess
import sys

REPO = "jayfrid-bot/bocabeach"
LOOKBACK = int(sys.argv[1]) if len(sys.argv) > 1 else 40


def main() -> int:
    try:
        out = subprocess.run(
            [
                "gh", "run", "list", "--repo", REPO, "--limit", str(LOOKBACK),
                "--json", "workflowName,conclusion,status,createdAt,databaseId,headSha",
            ],
            capture_output=True, text=True, timeout=90,
        )
    except FileNotFoundError:
        print("gh CLI not installed — see cli.github.com")
        return 1
    except subprocess.TimeoutExpired:
        print("GitHub timed out.")
        return 1
    if out.returncode != 0:
        print("Could not reach GitHub (signed in? run: gh auth login)")
        print(out.stderr.strip()[:200])
        return 1

    runs = json.loads(out.stdout or "[]")
    if not runs:
        print("No runs found.")
        return 0

    running = [r for r in runs if r["conclusion"] is None]
    failures = [r for r in runs if r["conclusion"] == "failure"]

    newest: dict[str, dict] = {}
    for r in runs:
        if r["conclusion"] in ("success", "failure") and r["workflowName"] not in newest:
            newest[r["workflowName"]] = r
    broken = {k: v for k, v in newest.items() if v["conclusion"] == "failure"}

    print()
    if broken:
        print(f"  {len(broken)} workflow(s) BROKEN right now:")
        print()
        for name, r in sorted(broken.items()):
            when = r["createdAt"][5:16].replace("T", " ")
            print(f"   x  {name}   ({when} UTC, {r['headSha'][:7]})")
            print(f"      https://github.com/{REPO}/actions/runs/{r['databaseId']}")
    else:
        print("  All workflows green on their latest run.")

    if failures and not broken:
        print()
        print(f"  ({len(failures)} older failure(s) in the last {len(runs)} runs, since fixed.)")

    if running:
        names = sorted({r["workflowName"] for r in running})
        print()
        print("  In flight: " + ", ".join(names))

    print()
    print(f"  Latest finished run per workflow (scanned {len(runs)}):")
    for name, r in sorted(newest.items()):
        print(f"   {'ok  ' if r['conclusion'] == 'success' else 'FAIL'}  {name}")
    print()
    return 1 if broken else 0


if __name__ == "__main__":
    sys.exit(main())
