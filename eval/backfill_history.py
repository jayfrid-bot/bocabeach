#!/usr/bin/env python3
"""
Backfill the cam_seaweed.json rolling `history` from the archived eval stills, so
the busyness/seaweed by-hour & by-day charts start populated instead of empty.

No vision API calls: we reuse the model reads already in eval/predictions.csv,
joined to capture times in eval/manifest.csv. Readings are aggregated per local
(date, hour) into one history entry — the busiest crowd + worst seaweed across the
cams in that hour — matching how the live job records one entry per capture run.

The result is MERGED into the currently-published feed (preserving morning/latest
and any live history buckets we don't already cover), then written to OUT for
publishing to the sargassum-data branch. Pure stdlib.
"""
import csv
import datetime as dt
import json
import os
import urllib.request
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "manifest.csv")
PREDICTIONS = os.path.join(HERE, os.environ.get("BACKFILL_PREDICTIONS", "predictions.csv"))
OUT = os.environ.get("CAM_SEAWEED_OUT", "/tmp/cam_seaweed.json")
TZ = ZoneInfo(os.environ.get("CAM_TZ", "America/New_York"))
PREV_URL = os.environ.get(
    "CAM_SEAWEED_PREV_URL",
    "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/cam_seaweed.json",
)
MAX_HISTORY = 480

SEAWEED_RANK = {"none": 0, "low": 1, "moderate": 2, "high": 3}
CROWD_RANK = {"empty": 0, "quiet": 1, "moderate": 2, "busy": 3, "packed": 4}


def load_csv(path):
    with open(path, newline="") as fh:
        return list(csv.DictReader(fh))


def fetch_prev():
    try:
        req = urllib.request.Request(PREV_URL, headers={"User-Agent": "boca-beach-rats"})
        return json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        print(f"warn: could not fetch prev feed ({e}); starting from empty")
        return {}


def main() -> int:
    times = {r["image"]: r["capturedAtUTC"] for r in load_csv(MANIFEST)}
    preds = {r["image"]: r for r in load_csv(PREDICTIONS)}

    # Bucket readings by local (date, hour); keep the busiest crowd & worst seaweed.
    buckets: dict[tuple[str, int], dict] = {}
    for img, ts in times.items():
        p = preds.get(img)
        if not p:
            continue
        local = dt.datetime.fromisoformat(ts).astimezone(TZ)
        key = (local.date().isoformat(), local.hour)
        b = buckets.setdefault(key, {"crowd": None, "people": None, "seaweed": None,
                                      "local": local.replace(minute=0, second=0, microsecond=0)})
        sw = (p.get("seaweed") or "").lower()
        if sw in SEAWEED_RANK and (b["seaweed"] is None
                                   or SEAWEED_RANK[sw] > SEAWEED_RANK[b["seaweed"]]):
            b["seaweed"] = sw
        cr = (p.get("crowd") or "").lower()
        if cr in CROWD_RANK and (b["crowd"] is None
                                 or CROWD_RANK[cr] > CROWD_RANK[b["crowd"]]):
            b["crowd"] = cr
            try:
                b["people"] = int(float(p["people"]))
            except (TypeError, ValueError):
                b["people"] = None

    backfill = {}
    for (date, hour), b in buckets.items():
        backfill[(date, hour)] = {
            "t": b["local"].isoformat(timespec="minutes"),
            "hour": hour,
            "level": b["crowd"],
            "people": b["people"],
            "seaweed": b["seaweed"],
        }

    # Merge into the live feed: backfill wins per (date, hour); keep live-only buckets.
    prev = fetch_prev()
    merged = dict(backfill)
    for e in (prev.get("history") or []):
        if not isinstance(e, dict):
            continue
        t, hour = e.get("t"), e.get("hour")
        if not isinstance(t, str) or not isinstance(hour, int):
            continue
        key = (t[:10], hour)
        if key not in merged:
            merged[key] = e  # live-only bucket (crowd-only, pre-backfill)

    history = sorted(merged.values(), key=lambda e: (e.get("t") or ""))[-MAX_HISTORY:]

    out = dict(prev) if isinstance(prev, dict) else {}
    out.pop("seaweedHistory", None)  # superseded by the unified history
    out["history"] = history
    if not out.get("tz"):
        out["tz"] = str(TZ)

    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))

    days = sorted({e["t"][:10] for e in history if e.get("seaweed")})
    print(f"wrote {OUT}: {len(history)} history entries "
          f"({len(backfill)} backfilled, {len(history) - len(backfill)} kept from live)")
    print(f"seaweed days covered: {days}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
