#!/usr/bin/env python3
"""
Build a small sargassum.json from NOAA's Sargassum Inundation Risk (SIR) daily
KMZ (cwcgom.aoml.noaa.gov/SIR), covering the East Florida coast.

Runs OFF Netlify (a daily GitHub Action). The KMZ is ~1.5 MB zipped / ~12 MB of
KML with ~11k colored coastline segments, each carrying an integer `risk` 0-3
(0 none, 1 low, 2 moderate, 3 high). We keep the East/SE-Florida segments and
emit each as [lat, lon, risk]; the web app then reads this tiny file and finds
the segment nearest each beach. Free, public-domain (NOAA/NASA/USF).
"""
import datetime as dt
import io
import json
import os
import re
import sys
import urllib.request
import zipfile

BASE = "https://cwcgom.aoml.noaa.gov/SIR/KMZ"
# East-Florida bounding box (Keys up through the Space Coast); widen if needed.
MIN_LAT = float(os.environ.get("SARG_MIN_LAT", "24.0"))
MAX_LAT = float(os.environ.get("SARG_MAX_LAT", "31.0"))
MIN_LON = float(os.environ.get("SARG_MIN_LON", "-82.5"))
MAX_LON = float(os.environ.get("SARG_MAX_LON", "-79.0"))
OUT = os.environ.get("SARG_OUT", "sargassum.json")


def fetch_kmz() -> tuple[str, bytes] | None:
    """Return (yyyymmdd, kmz bytes) for the most recent available day."""
    local = os.environ.get("SARG_KMZ")  # for local testing
    if local:
        return (re.search(r"(\d{8})", local).group(1), open(local, "rb").read())
    today = dt.datetime.now(dt.timezone.utc).date()
    for back in range(0, 6):
        d = (today - dt.timedelta(days=back)).strftime("%Y%m%d")
        url = f"{BASE}/sargassum_risk_{d}.kmz"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "boca-beach-rats"})
            data = urllib.request.urlopen(req, timeout=60).read()
            if data[:2] == b"PK":
                return (d, data)
        except Exception as e:  # noqa: BLE001
            print(f"warn: {d}: {e}", file=sys.stderr)
    return None


def midpoint(coords: str) -> tuple[float, float] | None:
    pts = [p.split(",") for p in coords.split()]
    if not pts:
        return None
    mid = pts[len(pts) // 2]
    return (float(mid[1]), float(mid[0]))  # (lat, lon) from "lon,lat"


def main() -> int:
    got = fetch_kmz()
    if not got:
        print("error: no SIR KMZ available", file=sys.stderr)
        return 1
    date, blob = got

    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = next((n for n in z.namelist() if n.lower().endswith(".kml")), None)
        if not name:
            print("error: no KML in KMZ", file=sys.stderr)
            return 1
        kml = z.read(name).decode("utf-8", "replace")

    segments: list[list[float]] = []
    for pm in re.findall(r"<Placemark\b.*?</Placemark>", kml, re.S):
        rm = re.search(r'name="risk">(-?\d+)', pm)
        cm = re.search(r"<coordinates>([^<]+)</coordinates>", pm)
        if not rm or not cm:
            continue
        mid = midpoint(cm.group(1))
        if not mid:
            continue
        lat, lon = mid
        if MIN_LAT <= lat <= MAX_LAT and MIN_LON <= lon <= MAX_LON:
            segments.append([round(lat, 3), round(lon, 3), int(rm.group(1))])

    out = {
        "generatedAt": dt.datetime.now(dt.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "source": "NOAA Sargassum Inundation Risk (SIR)",
        "sourceDate": date,  # yyyymmdd of the SIR product
        "riskScale": {"0": "none", "1": "low", "2": "moderate", "3": "high"},
        "count": len(segments),
        "segments": segments,  # [lat, lon, risk]
    }
    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {OUT}: {len(segments)} E-FL coastline segments (SIR {date})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
