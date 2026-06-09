#!/usr/bin/env python3
"""Run the PRODUCTION vision call over eval/images/ and write predictions.csv.

Imports `assess` from scripts/cam_seaweed.py so the eval exercises the exact same
prompt, model and parsing that runs in production. Needs GEMINI_API_KEY; calls are
throttled (EVAL_DELAY seconds) to stay under the free-tier rate limit.
"""
import csv
import glob
import os
import sys
import time

DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(DIR, "..", "scripts"))

from cam_seaweed import assess  # noqa: E402  -- the production vision call

DELAY = float(os.environ.get("EVAL_DELAY", "6"))
# EVAL_RESCORE=1 forces every image to be re-scored (ignores prior predictions) —
# used for the one-time backfill after the prompt gains new fields (e.g. pct).
RESCORE = os.environ.get("EVAL_RESCORE") == "1"


def main() -> int:
    if not os.environ.get("GEMINI_API_KEY"):
        print("set GEMINI_API_KEY first", file=sys.stderr)
        return 1
    images = sorted(glob.glob(os.path.join(DIR, "images", "*.jpg")))
    if not images:
        print("no images — run archive_stills.py first", file=sys.stderr)
        return 1

    # Only predict photos we haven't scored yet (cheap + keeps the free tier happy).
    # Errored/blank rows are dropped so they're retried on the next run.
    out = os.path.join(DIR, "predictions.csv")
    done = {}
    if os.path.exists(out) and not RESCORE:
        with open(out) as fh:
            done = {
                r["image"]: r
                for r in csv.DictReader(fh)
                if r.get("seaweed") not in ("", "ERROR")
            }
    todo = [p for p in images if os.path.basename(p) not in done]
    print(f"{len(todo)} new image(s) to score ({len(done)} already done)")

    for i, path in enumerate(todo):
        name = os.path.basename(path)
        try:
            with open(path, "rb") as fh:
                r = assess(fh.read())
            done[name] = {
                "image": name,
                "seaweed": r["level"],
                "seaweed_pct": r.get("coveragePct") if r.get("coveragePct") is not None else "",
                "crowd": r.get("crowd") or "",
                "crowd_pct": r.get("crowdPct") if r.get("crowdPct") is not None else "",
                "people": r.get("people") if r.get("people") is not None else "",
            }
            print(f"  {name}: seaweed={r['level']}({r.get('coveragePct')}%) "
                  f"crowd={r.get('crowd')}({r.get('crowdPct')}%) people={r.get('people')}")
        except Exception as e:  # noqa: BLE001
            done[name] = {"image": name, "seaweed": "ERROR", "crowd": "", "people": ""}
            print(f"  {name}: ERROR {e}", file=sys.stderr)
        if i < len(todo) - 1:
            time.sleep(DELAY)

    fields = ["image", "seaweed", "seaweed_pct", "crowd", "crowd_pct", "people"]
    with open(out, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        for name in sorted(done):
            w.writerow({k: done[name].get(k, "") for k in fields})
    print(f"wrote {out} ({len(done)} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
