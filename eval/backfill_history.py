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


def _pct(v):
    """A 0-100 int from a CSV cell, or None when blank/invalid (old CSVs lack pct)."""
    try:
        return max(0, min(100, int(round(float(v)))))
    except (TypeError, ValueError):
        return None


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
        b = buckets.setdefault(key, {"crowd": None, "people": None, "crowdPct": None,
                                      "seaweed": None, "cov": None,
                                      "local": local.replace(minute=0, second=0, microsecond=0)})
        # Worst seaweed by (category rank, coverage %); carry the winner's coverage.
        sw = (p.get("seaweed") or "").lower()
        if sw in SEAWEED_RANK:
            cov = _pct(p.get("seaweed_pct"))
            cand = (SEAWEED_RANK[sw], cov if cov is not None else -1)
            cur = (SEAWEED_RANK.get(b["seaweed"], -1),
                   b["cov"] if b["cov"] is not None else -1)
            if b["seaweed"] is None or cand > cur:
                b["seaweed"], b["cov"] = sw, cov
        # Busiest crowd by (category rank, fullness %); carry fullness + people.
        cr = (p.get("crowd") or "").lower()
        if cr in CROWD_RANK:
            cpct = _pct(p.get("crowd_pct"))
            cand = (CROWD_RANK[cr], cpct if cpct is not None else -1)
            cur = (CROWD_RANK.get(b["crowd"], -1),
                   b["crowdPct"] if b["crowdPct"] is not None else -1)
            if b["crowd"] is None or cand > cur:
                b["crowd"], b["crowdPct"] = cr, cpct
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
            "crowdPct": b["crowdPct"],
            "seaweed": b["seaweed"],
            "cov": b["cov"],
        }

    # Merge into the live feed: backfill wins per (date, hour) for the CATEGORY
    # (the morning pre-tractor eval stills are authoritative for seaweed), but we
    # never drop a numeric value (cov / crowdPct / people) the live feed already
    # has and the backfill lacks — otherwise republishing would regress live reads.
    prev = fetch_prev()
    merged = dict(backfill)
    for e in (prev.get("history") or []):
        if not isinstance(e, dict):
            continue
        t, hour = e.get("t"), e.get("hour")
        if not isinstance(t, str) or not isinstance(hour, int):
            continue
        key = (t[:10], hour)
        b = merged.get(key)
        if b is None:
            merged[key] = e  # live-only bucket (no eval coverage for this hour)
            continue
        # Same hour in both: keep the backfill category, but fill any numeric gaps
        # from the live reading so we don't lose real measurements.
        if b.get("cov") is None and e.get("cov") is not None:
            b["cov"] = e.get("cov")
            if not b.get("seaweed"):
                b["seaweed"] = e.get("seaweed")
        if b.get("crowdPct") is None and e.get("crowdPct") is not None:
            b["crowdPct"] = e.get("crowdPct")
            if not b.get("level"):
                b["level"] = e.get("level")
        if b.get("people") is None and e.get("people") is not None:
            b["people"] = e.get("people")

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
