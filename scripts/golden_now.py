#!/usr/bin/env python3
"""Is it golden hour right now at the courier's beaches?

    python3 scripts/golden_now.py [slug ...]        # default: the courier beaches
    python3 scripts/golden_now.py --now 2026-10-12T22:30:00Z deerfield-beach

Exit status (what scripts/cam_courier_local.sh --golden-only relies on):
    0   inside a golden window at one of the named beaches (a line says which)
    1   outside every window
    2   could not tell (bad arguments, no manifest, no coordinates, sun maths failed)

The windows are the archive's own golden windows, the same ones
lib/camFrames/golden.ts computes on the server:

    sunrise window   sunrise - 20 min  to  sunrise + 40 min
    sunset window    sunset  - 40 min  to  sunset  + 20 min

Each is half-open: [start, end). Sunrise and sunset come from the NOAA solver in
scripts/sun_cam_check.py (a port of lib/sources/sun.ts), called with the beach's
own LOCAL calendar date, as the app does. Coordinates and time zones come from
config/archive-cams.json. No new dependencies; standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None  # type: ignore

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
MANIFEST_PATH = Path(os.environ.get("ARCHIVE_CAMS", str(ROOT / "config" / "archive-cams.json")))

# Keep in step with lib/camFrames/golden.ts (SUNRISE_BEFORE_MIN, ...).
SUNRISE_BEFORE_MIN = 20
SUNRISE_AFTER_MIN = 40
SUNSET_BEFORE_MIN = 40
SUNSET_AFTER_MIN = 20

# The beaches the Mac courier feeds (scripts/cam_courier_local.sh CAMS array).
COURIER_SLUGS = ("deerfield-beach", "fort-lauderdale", "fort-myers-beach", "pensacola-beach")

Window = Tuple[str, datetime, datetime]  # (kind, start, end), UTC, half-open


def _sun_times(lat: float, lon: float, day: date) -> Dict[str, Optional[datetime]]:
    """sun_cam_check.sun_times(), imported on demand (it sits next to this file)."""
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    import sun_cam_check  # noqa: PLC0415

    return sun_cam_check.sun_times(lat, lon, day)


def load_beaches(path: Path = MANIFEST_PATH) -> Dict[str, dict]:
    """{slug: {lat, lon, timezone}} — the first manifest cam of each beach."""
    with open(path) as fh:
        doc = json.load(fh)
    out: Dict[str, dict] = {}
    for cam in doc.get("cams", []):
        slug = cam.get("slug")
        if slug and slug not in out:
            out[slug] = {"lat": cam.get("lat"), "lon": cam.get("lon"), "timezone": cam.get("timezone")}
    return out


def windows_for(beach: dict, now: datetime) -> List[Window]:
    """Today's golden windows (beach-local date) as UTC instants. Empty on a
    polar day/night. Raises on missing coordinates or an unusable time zone."""
    lat, lon = float(beach["lat"]), float(beach["lon"])
    if ZoneInfo is None:
        raise RuntimeError("zoneinfo unavailable")
    local_day = now.astimezone(ZoneInfo(beach.get("timezone") or "America/New_York")).date()
    t = _sun_times(lat, lon, local_day)
    out: List[Window] = []
    if t.get("sunrise"):
        out.append(("sunrise", t["sunrise"] - timedelta(minutes=SUNRISE_BEFORE_MIN),
                    t["sunrise"] + timedelta(minutes=SUNRISE_AFTER_MIN)))
    if t.get("sunset"):
        out.append(("sunset", t["sunset"] - timedelta(minutes=SUNSET_BEFORE_MIN),
                    t["sunset"] + timedelta(minutes=SUNSET_AFTER_MIN)))
    return out


def golden_hit(slugs, now: datetime, beaches: Dict[str, dict]) -> Optional[Tuple[str, str, datetime, datetime]]:
    """(slug, kind, start, end) of the first window containing `now`, else None.
    Raises KeyError for an unknown slug."""
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    for slug in slugs:
        for kind, start, end in windows_for(beaches[slug], now):
            if start <= now < end:
                return slug, kind, start, end
    return None


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Exit 0 when now is inside a golden-hour window.")
    ap.add_argument("slugs", nargs="*", help="beach slugs (default: the courier beaches)")
    ap.add_argument("--now", help="ISO-8601 instant to test instead of the clock (tests, dry runs)")
    args = ap.parse_args(argv)
    try:
        now = (datetime.fromisoformat(args.now.replace("Z", "+00:00")) if args.now
               else datetime.now(timezone.utc))
        if now.tzinfo is None:
            now = now.replace(tzinfo=timezone.utc)
        beaches = load_beaches()
        hit = golden_hit(args.slugs or COURIER_SLUGS, now, beaches)
    except Exception as e:  # noqa: BLE001 — "can't tell" must be distinguishable from "no"
        print(f"golden_now: {e}", file=sys.stderr)
        return 2
    if hit is None:
        print("outside every golden window")
        return 1
    slug, kind, start, end = hit
    print(f"inside {slug} {kind} window {start.strftime('%H:%MZ')}-{end.strftime('%H:%MZ')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
