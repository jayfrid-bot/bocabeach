#!/usr/bin/env python3
"""Capture current beach-cam stills into eval/images/ for the vision accuracy eval.

Run this repeatedly over days to build a diverse set (different times, lighting,
seaweed/crowd levels). Each new image needs a row in labels.csv. Pure stdlib;
cams are http:// so no extra deps.
"""
import csv
import datetime as dt
import json
import os
import sys
import urllib.request

DIR = os.path.dirname(os.path.abspath(__file__))
IMG = os.path.join(DIR, "images")
os.makedirs(IMG, exist_ok=True)

# (cam base dir, view) pairs to sample — a spread of beach sections.
CAMS = (
    [("http://video-monitoring.com/beachcams/boca", v) for v in ("s4", "s11", "s22")]
    + [("http://video-monitoring.com/beachcams/bocainlet", v) for v in ("s8", "s12", "s16")]
)


def get(url: str, timeout: int = 25) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "boca-eval"})
    return urllib.request.urlopen(req, timeout=timeout).read()


def main() -> int:
    rows = []
    for base, view in CAMS:
        try:
            feed = json.loads(get(f"{base}/latest.json").decode("utf-8", "replace"))
            entry = feed.get(view)
            if not entry or "mr" not in entry:
                continue
            img = get(f"{base}/{entry['mr']}")
            cam = base.rsplit("/", 1)[-1]
            ts = entry.get("timestamp")
            name = f"{cam}_{view}_{ts}.jpg"
            with open(os.path.join(IMG, name), "wb") as fh:
                fh.write(img)
            cap = (
                dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat()
                if isinstance(ts, (int, float))
                else ""
            )
            rows.append({"image": name, "cam": cam, "view": view, "capturedAtUTC": cap})
            print(f"saved {name} ({len(img)} bytes)")
        except Exception as e:  # noqa: BLE001
            print(f"warn {base} {view}: {e}", file=sys.stderr)

    # Append to (or create) the manifest, de-duping by image name.
    man = os.path.join(DIR, "manifest.csv")
    existing = {}
    if os.path.exists(man):
        with open(man) as fh:
            existing = {r["image"]: r for r in csv.DictReader(fh)}
    for r in rows:
        existing[r["image"]] = r
    with open(man, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["image", "cam", "view", "capturedAtUTC"])
        w.writeheader()
        w.writerows(existing.values())
    print(f"{len(rows)} captured; manifest now {len(existing)} images")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
