#!/usr/bin/env python3
"""
Build a small lightning.json from NOAA GOES-19 GLM (Geostationary Lightning
Mapper) Level-2 LCFA granules on AWS Open Data.

Runs OFF Netlify (in a GitHub Action). It lists the last `GLM_WINDOW_MIN`
minutes of 20-second GLM granules, downloads them, extracts flash lat/lon/time,
filters to a Florida bounding box, and writes a compact JSON of recent strikes.
The web app then reads that tiny file and computes per-beach nearest-strike
distance + recency cheaply — so the heavy netCDF work never touches Netlify.

GLM data: free, no key, public domain. Bucket is anonymous (no AWS creds).
"""
import datetime as dt
import json
import math
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import h5py
import numpy as np

BUCKET = os.environ.get("GLM_BUCKET", "https://noaa-goes19.s3.amazonaws.com")
PREFIX = "GLM-L2-LCFA"
WINDOW_MIN = int(os.environ.get("GLM_WINDOW_MIN", "30"))
# CONUS bounding box (national coverage — every US coast). GOES-19 (East) sees
# all of CONUS; the Pacific coast sits near its limb (slightly lower GLM
# detection) — a GOES-18 (West) source is the planned follow-up for CA/OR/WA.
# Per-beach distance filtering happens in lib/sources/lightning.ts, so one
# national feed serves any beach. Override via GLM_* env to narrow.
MIN_LAT = float(os.environ.get("GLM_MIN_LAT", "24.0"))
MAX_LAT = float(os.environ.get("GLM_MAX_LAT", "49.5"))
MIN_LON = float(os.environ.get("GLM_MIN_LON", "-125.0"))
MAX_LON = float(os.environ.get("GLM_MAX_LON", "-66.0"))
# Cap keeps the most-recent strikes (so active, safety-critical lightning is
# never evicted by older strikes). Sized for CONUS volume; the feed is fetched
# server-side + cached, so size doesn't reach users directly.
CAP = int(os.environ.get("GLM_CAP", "20000"))         # max strikes in output
MAX_FILES = int(os.environ.get("GLM_MAX_FILES", "200"))  # runtime safety bound
OUT = os.environ.get("GLM_OUT", "lightning.json")
S3_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}


def _get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "boca-beach-rats-glm"})
    return urllib.request.urlopen(req, timeout=timeout).read()


def list_keys(prefix: str) -> list[str]:
    keys: list[str] = []
    token = None
    while True:
        url = f"{BUCKET}/?list-type=2&prefix={urllib.parse.quote(prefix)}&max-keys=1000"
        if token:
            url += "&continuation-token=" + urllib.parse.quote(token)
        root = ET.fromstring(_get(url, timeout=30))
        keys += [c.findtext("s3:Key", namespaces=S3_NS) for c in root.findall("s3:Contents", S3_NS)]
        if (root.findtext("s3:IsTruncated", namespaces=S3_NS) or "false") == "true":
            token = root.findtext("s3:NextContinuationToken", namespaces=S3_NS)
        else:
            return keys


def start_time(key: str) -> dt.datetime | None:
    """Granule start time from the `_sYYYYDDDHHMMSSt` token in the filename."""
    m = re.search(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})", key)
    if not m:
        return None
    y, doy, hh, mm, ss = map(int, m.groups())
    return dt.datetime(y, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(
        days=doy - 1, hours=hh, minutes=mm, seconds=ss
    )


def _attr(ds, name: str, default: float) -> float:
    if name not in ds.attrs:
        return default
    return float(np.asarray(ds.attrs[name]).ravel()[0])


def parse_granule(buf: bytes) -> list[tuple[float, float, float]]:
    """Return [(epoch_sec, lat, lon)] for good flashes inside the bbox."""
    out: list[tuple[float, float, float]] = []
    with tempfile.NamedTemporaryFile(suffix=".nc") as tf:
        tf.write(buf)
        tf.flush()
        with h5py.File(tf.name, "r") as f:
            if "flash_lat" not in f:
                return out
            lat = f["flash_lat"][:].astype("float64")
            lon = f["flash_lon"][:].astype("float64")
            tv = f["flash_time_offset_of_first_event"]
            secs = tv[:].astype("float64") * _attr(tv, "scale_factor", 1.0) + _attr(tv, "add_offset", 0.0)
            units = tv.attrs.get("units", b"")
            units = units.decode() if isinstance(units, bytes) else str(units)
            m = re.search(r"seconds since (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})", units)
            ref = dt.datetime(*map(int, m.groups()), tzinfo=dt.timezone.utc)
            ref_epoch = ref.timestamp()
            qf = f["flash_quality_flag"][:] if "flash_quality_flag" in f else None
            for i in range(len(lat)):
                la, lo = float(lat[i]), float(lon[i])
                if not (MIN_LAT <= la <= MAX_LAT and MIN_LON <= lo <= MAX_LON):
                    continue
                if qf is not None and int(qf[i]) != 0:  # 0 = good quality
                    continue
                out.append((ref_epoch + float(secs[i]), round(la, 3), round(lo, 3)))
    return out


def main() -> int:
    now = dt.datetime.now(dt.timezone.utc)
    start = now - dt.timedelta(minutes=WINDOW_MIN)

    # Hours that the window spans (handles hour/day rollover).
    hours: set[tuple[int, int, int]] = set()
    t = start.replace(minute=0, second=0, microsecond=0)
    while t <= now:
        hours.add((t.year, int(t.strftime("%j")), t.hour))
        t += dt.timedelta(hours=1)

    candidates: list[tuple[dt.datetime, str]] = []
    for y, doy, hh in sorted(hours):
        try:
            for k in list_keys(f"{PREFIX}/{y}/{doy:03d}/{hh:02d}/"):
                st = start_time(k)
                if st and start <= st <= now:
                    candidates.append((st, k))
        except Exception as e:  # noqa: BLE001
            print(f"warn: list {y}/{doy}/{hh}: {e}", file=sys.stderr)
    candidates.sort()
    candidates = candidates[-MAX_FILES:]  # keep the most recent within the bound

    strikes: list[tuple[float, float, float]] = []
    for _, k in candidates:
        try:
            strikes += parse_granule(_get(f"{BUCKET}/{k}"))
        except Exception as e:  # noqa: BLE001
            print(f"warn: parse {k}: {e}", file=sys.stderr)

    strikes.sort(key=lambda s: s[0], reverse=True)  # most recent first
    strikes = strikes[:CAP]

    out = {
        "generatedAt": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": "NOAA GOES-19 GLM (GLM-L2-LCFA)",
        "windowMinutes": WINDOW_MIN,
        "bbox": [MIN_LAT, MIN_LON, MAX_LAT, MAX_LON],
        "count": len(strikes),
        # [epochSec, lat, lon] — epoch rounded to whole seconds to keep it tiny.
        "strikes": [[round(e), la, lo] for (e, la, lo) in strikes],
    }
    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {OUT}: {len(strikes)} strikes from {len(candidates)} granules "
          f"(window {WINDOW_MIN}m, bbox {MIN_LAT},{MIN_LON},{MAX_LAT},{MAX_LON})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
