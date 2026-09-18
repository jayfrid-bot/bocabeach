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

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

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
# Radius (mi) within which a served beach's strikes are always retained by
# apply_cap, even when the global cap would otherwise evict them for being
# older than strikes elsewhere in CONUS. Keeps the app's 30-minute
# near-beach lightning hold (lib/hazards/assess.ts) intact under saturation.
NEAR_BEACH_MI = float(os.environ.get("GLM_NEAR_BEACH_MI", "50"))
MAX_FILES = int(os.environ.get("GLM_MAX_FILES", "200"))  # runtime safety bound
OUT = os.environ.get("GLM_OUT", "lightning.json")
S3_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}


def load_beaches() -> list[dict]:
    """Merge the hand-curated TS locations with the admin-added generated JSON,
    exactly like config/locations.ts's allLocations() does (curated first,
    generated entries deduped by slug). We only need slug/lat/lon here, so the
    TS file is parsed with a small targeted regex rather than a JS toolchain —
    every LOCATIONS entry is `slug: "...", ... lat: N, lon: N, ... cams:`, and
    that shape is stable/simple enough to lift without executing TypeScript.
    Identical approach to goes_cloud.py's / mrms_precip.py's load_beaches().
    Fail-soft: any parse error yields fewer/no beaches rather than raising."""
    beaches: list[dict] = []
    seen: set[str] = set()

    ts_path = os.path.join(REPO_ROOT, "config", "locations.ts")
    try:
        with open(ts_path, "r") as fh:
            text = fh.read()
        m = re.search(r"export const LOCATIONS:.*?=\s*\[(.*?)\n\];", text, re.S)
        body = m.group(1) if m else text
        for em in re.finditer(r'slug:\s*"([^"]+)"(.*?)cams:', body, re.S):
            slug = em.group(1)
            chunk = em.group(2)
            lat_m = re.search(r"\blat:\s*(-?\d+(?:\.\d+)?)", chunk)
            lon_m = re.search(r"\blon:\s*(-?\d+(?:\.\d+)?)", chunk)
            if lat_m and lon_m and slug not in seen:
                beaches.append({"slug": slug, "lat": float(lat_m.group(1)), "lon": float(lon_m.group(1))})
                seen.add(slug)
    except Exception as e:  # noqa: BLE001
        print(f"warn: could not parse config/locations.ts: {e}", file=sys.stderr)

    gen_path = os.path.join(REPO_ROOT, "config", "locations.generated.json")
    try:
        with open(gen_path, "r") as fh:
            generated = json.load(fh)
        for loc in generated:
            slug = loc.get("slug")
            lat, lon = loc.get("lat"), loc.get("lon")
            if slug and slug not in seen and isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
                beaches.append({"slug": slug, "lat": float(lat), "lon": float(lon)})
                seen.add(slug)
    except Exception as e:  # noqa: BLE001
        print(f"warn: could not read config/locations.generated.json: {e}", file=sys.stderr)

    return beaches


def _haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r_mi = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r_mi * math.asin(math.sqrt(a))


def apply_cap(
    strikes: list[tuple[float, float, float]],
    beaches: list[dict],
    cap: int,
    near_mi: float = 50,
) -> tuple[list[tuple[float, float, float]], dict]:
    """Apply the global CAP to `strikes` (each (epoch, lat, lon), any order)
    while always retaining every strike within `near_mi` of any beach in
    `beaches`, so a near-beach strike is never evicted by newer strikes
    elsewhere in CONUS (the app's 30-minute near-beach lightning hold in
    lib/hazards/assess.ts depends on that strike staying in the feed for its
    full window). With no beaches (empty list / load failure), this reduces
    to the previous behavior: keep the `cap` most-recent strikes.

    Returns (kept_strikes, retention_note) where kept_strikes is sorted
    most-recent-first and retention_note is
    {cap, total, kept, nearBeachKept} for visibility into feed JSON.

    >>> beaches = [{"slug": "x", "lat": 26.0, "lon": -80.0}]
    >>> # one old strike 4 mi from the beach, three newer strikes far away
    >>> old_close = (1000.0, 26.05, -80.0)  # ~3.5 mi north
    >>> far1 = (4000.0, 40.0, -100.0)
    >>> far2 = (3000.0, 41.0, -101.0)
    >>> far3 = (2000.0, 42.0, -102.0)
    >>> kept, note = apply_cap([old_close, far1, far2, far3], beaches, cap=3)
    >>> old_close in kept
    True
    >>> note["nearBeachKept"]
    1
    >>> len(kept)
    3
    >>> kept2, note2 = apply_cap([old_close, far1, far2, far3], [], cap=3)
    >>> old_close in kept2
    False
    >>> [s[0] for s in kept2] == [4000.0, 3000.0, 2000.0]
    True
    """
    total = len(strikes)
    strikes_sorted = sorted(strikes, key=lambda s: s[0], reverse=True)

    if not beaches or cap <= 0:
        kept = strikes_sorted[:cap] if cap > 0 else []
        note = {"cap": cap, "total": total, "kept": len(kept), "nearBeachKept": 0}
        return kept, note

    def is_near_beach(la: float, lo: float) -> bool:
        for b in beaches:
            if _haversine_mi(la, lo, b["lat"], b["lon"]) <= near_mi:
                return True
        return False

    near: list[tuple[float, float, float]] = []
    far: list[tuple[float, float, float]] = []
    for s in strikes_sorted:
        (near if is_near_beach(s[1], s[2]) else far).append(s)

    remainder_cap = max(cap - len(near), 0)
    kept = near + far[:remainder_cap]
    kept.sort(key=lambda s: s[0], reverse=True)

    note = {"cap": cap, "total": total, "kept": len(kept), "nearBeachKept": len(near)}
    return kept, note


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

    beaches = load_beaches()
    strikes, retention = apply_cap(strikes, beaches, CAP, near_mi=NEAR_BEACH_MI)

    out = {
        "generatedAt": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": "NOAA GOES-19 GLM (GLM-L2-LCFA)",
        "windowMinutes": WINDOW_MIN,
        "bbox": [MIN_LAT, MIN_LON, MAX_LAT, MAX_LON],
        "count": len(strikes),
        # [epochSec, lat, lon] — epoch rounded to whole seconds to keep it tiny.
        "strikes": [[round(e), la, lo] for (e, la, lo) in strikes],
        # Cap saturation visibility: nearBeachKept strikes are always
        # retained regardless of the cap (see apply_cap docstring).
        "retention": retention,
    }
    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {OUT}: {len(strikes)} strikes from {len(candidates)} granules "
          f"(window {WINDOW_MIN}m, bbox {MIN_LAT},{MIN_LON},{MAX_LAT},{MAX_LON}, "
          f"retention {retention})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
