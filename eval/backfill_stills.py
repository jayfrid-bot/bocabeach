#!/usr/bin/env python3
"""One-shot backfill: discover ALL live cam views from both feeds and download
each current frame into eval/images/.  Ignores EVAL_MAX_IMAGES — the point is
to grab everything at once to seed a large eval set quickly.

Usage:
    python eval/backfill_stills.py           # capture from all auto-discovered views
    python eval/backfill_stills.py --dry-run # list views without downloading
"""
import argparse
import csv
import datetime as dt
import json
import os
import sys
import urllib.request

DIR = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(DIR, "images")
os.makedirs(IMG, exist_ok=True)

# v13 is a parking/overhead cam — no beach content.
EXCLUDE_VIEWS = {"v13"}

FEEDS = [
    "http://video-monitoring.com/beachcams/boca",
    "http://video-monitoring.com/beachcams/bocainlet",
]


def get(url: str, timeout: int = 25) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "boca-eval"})
    return urllib.request.urlopen(req, timeout=timeout).read()


def discover(base: str) -> list[tuple[str, str, dict]]:
    """Return [(base, view, entry)] for every live view in this feed."""
    feed = json.loads(get(f"{base}/latest.json").decode("utf-8", "replace"))
    results = []
    for view, entry in feed.items():
        if not isinstance(entry, dict) or "mr" not in entry:
            continue
        if view in EXCLUDE_VIEWS:
            continue
        ts = entry.get("timestamp")
        age_h = None
        if isinstance(ts, (int, float)):
            age_h = (dt.datetime.now(dt.timezone.utc) - dt.datetime.fromtimestamp(ts, dt.timezone.utc)).total_seconds() / 3600
        if age_h is not None and age_h > 4:
            print(f"  skip {base.rsplit('/', 1)[-1]}/{view}: {age_h:.1f}h stale", file=sys.stderr)
            continue
        results.append((base, view, entry))
    return results


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    # Discover every fresh view across all feeds.
    all_views: list[tuple[str, str, dict]] = []
    for feed_url in FEEDS:
        try:
            all_views.extend(discover(feed_url))
        except Exception as e:
            print(f"warn {feed_url}: {e}", file=sys.stderr)

    print(f"Found {len(all_views)} live views")
    if args.dry_run:
        for base, view, entry in all_views:
            cam = base.rsplit("/", 1)[-1]
            ts = entry.get("timestamp")
            print(f"  {cam}/{view}  ts={ts}")
        return 0

    # Load existing manifest to avoid re-downloading.
    man = os.path.join(DIR, "manifest.csv")
    existing: dict[str, dict] = {}
    if os.path.exists(man):
        with open(man) as fh:
            existing = {r["image"]: r for r in csv.DictReader(fh)}

    rows = []
    for base, view, entry in all_views:
        cam = base.rsplit("/", 1)[-1]
        ts = entry.get("timestamp")
        name = f"{cam}_{view}_{ts}.jpg"

        if name in existing:
            print(f"already have {name} — skip")
            continue

        try:
            img = get(f"{base}/{entry['mr']}")
            with open(os.path.join(IMG, name), "wb") as fh:
                fh.write(img)
            cap = (
                dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat()
                if isinstance(ts, (int, float))
                else ""
            )
            rows.append({"image": name, "cam": cam, "view": view, "capturedAtUTC": cap})
            print(f"saved {name} ({len(img):,} bytes)")
        except Exception as e:
            print(f"warn {cam}/{view}: {e}", file=sys.stderr)

    if rows:
        for r in rows:
            existing[r["image"]] = r
        with open(man, "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=["image", "cam", "view", "capturedAtUTC"])
            w.writeheader()
            w.writerows(existing.values())

    print(f"{len(rows)} new images saved; manifest now {len(existing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
