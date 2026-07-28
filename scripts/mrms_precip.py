#!/usr/bin/env python3
"""
Build a small mrms_precip.json of RADAR-OBSERVED rain near each beach, plus a
short-fuse "is rain coming" nowcast, from NOAA MRMS PrecipRate on AWS Open Data.

WHY THIS EXISTS
----------------
Every rain signal the app has today is a MODEL: Open-Meteo's hourly precip, its
minutely nowcast (lib/sources/nowcast.ts), the NWS forecast. Models routinely
disagree with the sky — the same class of failure as the 2026-07-15 anvil miss
that scripts/goes_cloud.py was written to fix, where a forecast cloud field said
11-24% while the beach sat under a genuinely overcast thunderstorm anvil. A
radar mosaic is an OBSERVATION: it does not predict that it might rain, it
reports where the rain physically is right now. That lets the app say "rain on
radar 18 mi NW, could reach the beach in ~25 min" instead of "40% chance".

SCOPE (v1): INFORMATIONAL ONLY. Nothing this script publishes feeds the Beach
Day score or its rain caps (lib/score.ts). It powers a rain-nowcast line and a
radar-observed term in the Storm Activity meter, both of which are display-only.
Wiring radar into the score is a separate, review-gated change.

DATA SOURCE FACTS (verified against the live bucket 2026-07-28)
-----------------------------------------------------------------
- s3://noaa-mrms-pds/CONUS/PrecipRate_00.00/YYYYMMDD/
  MRMS_PrecipRate_00.00_YYYYMMDD-HHMMSS.grib2.gz — anonymous/keyless HTTP,
  no-sign-request, us-east-1.
- 2-minute cadence, ~0.65 MB gzipped / ~0.70 MB raw per frame.
- One GRIB2 message per file: a regular lat/lon grid, Ni=7000 x Nj=3500 at
  0.01 deg, first grid point (54.995 N, 230.005 E) and last (20.005 N,
  299.995 E) — i.e. row 0 is the NORTH edge and lon is stored 0-360.
- Units are mm/hr. NEGATIVE values are flags, not rain: -3 = "no radar
  coverage", -1 = "missing". They are excluded from every statistic here
  rather than being read as zero rain (a beach outside radar coverage must
  report null, not "dry").

GRIB2 DECODER CHOICE: pygrib
-------------------------------
This project's Python jobs deliberately keep a tiny dependency budget
(glm_lightning.py and goes_cloud.py are h5py + numpy, no boto3, no satpy).
MRMS is GRIB2, which h5py cannot read, so exactly one new decoder is needed.
pygrib was chosen over cfgrib/xarray and wgrib2 because:
  - it installs from a binary wheel with ECMWF's eccodes bundled, so the
    workflow needs no apt-get step and no system library (verified locally:
    a bare `pip install pygrib` in a clean venv imports and decodes a real
    frame with no other setup);
  - cfgrib would drag in xarray + pandas + dask-adjacent machinery for what is
    a single 2-D array read — a much larger install for no added capability;
  - wgrib2 is a C program that has to be compiled or apt-installed and then
    shelled out to and re-parsed, which is strictly more moving parts.
The decoder is used for exactly two things (values + grid header), so swapping
it later means rewriting only read_frame().

GRID NAVIGATION
----------------
Derived from the GRIB message's OWN header every run (latitudeOfFirstGridPoint,
...OfLastGridPoint, Ni, Nj) — never hardcoded, so a grid change upstream is
followed rather than silently mis-sampled. Every run self-checks the derived
formula against pygrib's independently-computed latlons() for the corners and
for each beach's own pixel, and refuses to publish if the round-trip error
exceeds one pixel (SELFCHECK_MAX_DEG). This mirrors goes_cloud.py's navigation
self-check, and it is why the formula below can be trusted at all:
    row = (lat - lat1) / dlat        col = (lon360 - lon1) / dlon
(verified bit-for-bit against latlons() at 4 sample indices on the live
2026-07-28T19:26Z frame).

WHAT IS COMPUTED, PER BEACH
-----------------------------
From a BOX_KM-on-a-side box centered on the beach, out of the NEWEST frame:
  rainNowMmHr      3x3 max at the beach pixel (max, not mean: a convective
                   core is often 1-2 pixels wide, and "is it raining ON me"
                   should not be diluted by the dry pixel next door). null if
                   no valid pixel in the 3x3 (outside radar coverage).
  nearestRainKm    distance to the nearest valid pixel >= RAIN_MM_HR, and
  nearestBearingDeg  its compass bearing FROM the beach. null when the box is
                   dry (an honest "no rain in the box", not "0 km away").
  coveragePct      % of VALID pixels in the box at >= RAIN_MM_HR. Denominator
                   is valid pixels only, so partial radar coverage does not
                   dilute the number toward a falsely-dry reading.

ADVECTION (motion) — see estimate_motion()
--------------------------------------------
Storm motion is estimated by cross-correlating the rain field between the
OLDEST and NEWEST frames (the longest available baseline, ~20 min): the older
frame's center box is slid over the newer frame's larger box across a
+/-MAX_SHIFT_KM grid of integer-pixel shifts, and the shift with the highest
zero-mean normalized correlation wins. Sub-pixel refinement is deliberately
skipped — this is a nowcast, and over a 20-min baseline one 0.01 deg pixel is
already ~3 km/h of resolution.

Two deliberate choices worth knowing:
  - Intensities are clipped to CORR_CLIP_MM_HR before correlating. Raw
    PrecipRate is extremely heavy-tailed (a 181 mm/hr core was observed in the
    live 2026-07-28 frame while the surrounding rain ran 1-5 mm/hr); left
    unclipped, a single such cell dominates the correlation and the "motion"
    becomes the motion of that one pixel rather than of the rain field.
  - The longest baseline caps the fastest DETECTABLE motion at
    MAX_SHIFT_KM / baseline (~90 km/h at 30 km over 20 min). Faster than that
    and the true peak falls outside the search window; the result is reported
    as null rather than as a clipped-to-the-edge answer, since a peak pinned
    to the search boundary is not evidence of motion at that speed.
Motion is null when the template has too little rain to correlate
(MIN_CORR_PIXELS), when frames are too close together in time, or when the
best correlation is too weak (MIN_CORR_SCORE) — never a fabricated vector.

ETA — see estimate_eta()
--------------------------
Rather than projecting every rain cell forward and doing geometry, the beach is
marched BACKWARD along the motion vector: the rain that will be at the beach in
t minutes is the rain that is right now at (beach - v*t). So we step t from 1 to
ETA_MAX_MINUTES and return the first t at which there is rain (>= RAIN_MM_HR,
within ETA_PROBE_RADIUS_KM of the upstream point, to tolerate pixel noise and
the fact that a beach is not a mathematical point). This is exactly the nowcast
question, it costs a handful of array lookups, and it returns null for free in
all the cases that should be null: no motion, motion too slow to be meaningful
(MIN_MOTION_KMH — a stalled field has no meaningful ETA), the upstream track
leaving the box, or the upstream track simply being dry (rain nearby but
drifting AWAY gives no ETA, which is the correct answer).

FAIL-SOFT
----------
Nothing here is allowed to crash the job. A beach that cannot be sampled gets
nulls plus a per-beach note; a total frame-fetch failure still publishes a
well-formed file with null beaches and a top-level note, so the app's staleness
gate (lib/sources/precipRadar.ts) sees an honest "no data" instead of a stale
file frozen at the last good run. The ONLY non-zero exit is a failed navigation
self-check, which is a code bug rather than a data outage and must not publish
silently-wrong pixels.

ENV OVERRIDES (mirrors goes_cloud.py's style)
------------------------------------------------
  MRMS_BUCKET            default https://noaa-mrms-pds.s3.amazonaws.com
  MRMS_PRODUCT           default CONUS/PrecipRate_00.00
  MRMS_BOX_KM            analysis box side length, km (default 64)
  MRMS_FRAME_GAP_MIN     target spacing between the 3 frames (default 10)
  MRMS_FRAMES            how many frames to use (default 3, min 1)
  MRMS_MAX_SHIFT_KM      advection search half-width, km (default 30)
  MRMS_ETA_MAX_MINUTES   ETA cap (default 60)
  MRMS_BEACHES           JSON list of {slug,lat,lon} overriding BEACHES —
                         used by the local real-data proof to point the same
                         code at a coordinate that currently has active echoes
  MRMS_OUT               output path (default mrms_precip.json)
"""
import datetime as dt
import gzip
import json
import math
import os
import re
import sys
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np
import pygrib

BUCKET = os.environ.get("MRMS_BUCKET", "https://noaa-mrms-pds.s3.amazonaws.com")
PRODUCT = os.environ.get("MRMS_PRODUCT", "CONUS/PrecipRate_00.00")
OUT = os.environ.get("MRMS_OUT", "mrms_precip.json")

# Analysis box side length. 64 km at Boca's latitude is ~57 rows x ~64 cols of
# 0.01 deg pixels — big enough to see a shower ~30 km upstream (about 30 min of
# lead time at a typical 60 km/h storm motion), small enough that "rain in the
# box" still plausibly means "rain that could affect THIS beach".
BOX_KM = float(os.environ.get("MRMS_BOX_KM", "64"))
# Frames to composite, and their target spacing. MRMS's native cadence is 2 min;
# consecutive 2-min frames barely move, so we deliberately step ~10 min apart to
# get a motion baseline long enough to measure against a 1 km pixel.
N_FRAMES = max(1, int(os.environ.get("MRMS_FRAMES", "3")))
FRAME_GAP_MIN = float(os.environ.get("MRMS_FRAME_GAP_MIN", "10"))
# How far back to look for the newest frame before giving up (the feed is
# reliable, but a bucket hiccup shouldn't wedge the job on an empty listing).
MAX_LOOKBACK_MIN = float(os.environ.get("MRMS_MAX_LOOKBACK_MIN", "60"))

# The rain/no-rain threshold, mm/hr. 0.5 mm/hr is light drizzle; below it the
# mosaic is mostly ground clutter and virga that never reaches the sand.
RAIN_MM_HR = 0.5
# Advection search half-width. See estimate_motion().
MAX_SHIFT_KM = float(os.environ.get("MRMS_MAX_SHIFT_KM", "30"))
# Clip before correlating so one extreme convective core can't dominate — see
# the ADVECTION note in the module docstring.
CORR_CLIP_MM_HR = 50.0
# Minimum rainy pixels in the template before a correlation means anything.
MIN_CORR_PIXELS = 25
# Minimum normalized-correlation score to accept a motion vector. Below this the
# two frames don't share recognizable structure (rain grew/decayed rather than
# moved), so reporting a vector would be inventing one.
MIN_CORR_SCORE = 0.3
# Below this speed the field is effectively stalled: the upstream point sits
# within the beach's own pixel and "ETA" stops being a meaningful concept.
MIN_MOTION_KMH = 3.0

ETA_MAX_MINUTES = float(os.environ.get("MRMS_ETA_MAX_MINUTES", "60"))
ETA_STEP_MINUTES = 1.0
# Tolerance around the upstream probe point: pixel noise, an imperfect motion
# vector, and the fact that a beach is a stretch of sand rather than a point.
ETA_PROBE_RADIUS_KM = 4.0

# Max allowed navigation round-trip error, in degrees (one 0.01 deg pixel).
SELFCHECK_MAX_DEG = 0.01

# Feed schema version — lets lib/sources/precipRadar.ts tell an old cached feed
# apart from a new one, same convention as goes_cloud.py's FEED_VERSION.
FEED_VERSION = 1
S3_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}

KM_PER_DEG_LAT = 111.32

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Beaches to sample. Deliberately a short inline list rather than a parse of
# config/locations.ts (which goes_cloud.py does): each beach costs only a few
# array slices here, but this feed is new and unproven, so it starts with the
# flagship beach and grows once the signal is trusted. Add entries here — the
# rest of the script is already shaped for N beaches.
BEACHES: list[dict] = [
    {"slug": "boca-raton", "lat": 26.3587, "lon": -80.0686},
]


def _get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "boca-beach-rats-mrms"})
    return urllib.request.urlopen(req, timeout=timeout).read()


def list_keys(prefix: str) -> list[str]:
    """Anonymous S3 listing — identical pattern to goes_cloud.py/glm_lightning.py
    (plain HTTP + XML, no boto3, no credentials)."""
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


def frame_time(key: str) -> dt.datetime | None:
    """Frame time from the `_YYYYMMDD-HHMMSS` token in the filename."""
    m = re.search(r"_(\d{8})-(\d{2})(\d{2})(\d{2})\.grib2", key)
    if not m:
        return None
    day, hh, mm, ss = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
    try:
        d = dt.datetime.strptime(day, "%Y%m%d")
    except ValueError:
        return None
    return d.replace(hour=hh, minute=mm, second=ss, tzinfo=dt.timezone.utc)


def pick_frames() -> list[tuple[dt.datetime, str]]:
    """Newest frame, plus the frames nearest to (newest - k*FRAME_GAP_MIN).

    Lists TODAY's day-prefix and, when the run is close enough to UTC midnight
    that the lookback window crosses it, YESTERDAY's too — otherwise a run at
    00:05Z would find only a few minutes of frames and have no motion baseline.
    Returned oldest-first. Never raises: an unreachable/empty listing yields [].
    """
    now = dt.datetime.now(dt.timezone.utc)
    # How far back the frame set itself needs to reach, plus the lookback slack.
    span_min = MAX_LOOKBACK_MIN + FRAME_GAP_MIN * (N_FRAMES - 1)
    days = [now.strftime("%Y%m%d")]
    earliest = now - dt.timedelta(minutes=span_min)
    if earliest.strftime("%Y%m%d") != days[0]:
        days.append(earliest.strftime("%Y%m%d"))

    candidates: list[tuple[dt.datetime, str]] = []
    for day in days:
        try:
            for k in list_keys(f"{PRODUCT}/{day}/"):
                t = frame_time(k or "")
                if t is not None:
                    candidates.append((t, k))
        except Exception as e:  # noqa: BLE001
            print(f"warn: list {PRODUCT}/{day}/: {e}", file=sys.stderr)
    if not candidates:
        return []

    candidates.sort()
    # Ignore anything dated in the future (clock skew / a malformed key).
    candidates = [c for c in candidates if c[0] <= now + dt.timedelta(minutes=5)]
    if not candidates:
        return []
    newest_t, _ = candidates[-1]
    if (now - newest_t).total_seconds() / 60 > MAX_LOOKBACK_MIN:
        print(
            f"warn: newest frame {newest_t.isoformat()} is older than "
            f"{MAX_LOOKBACK_MIN:.0f} min lookback",
            file=sys.stderr,
        )
        return []

    picked: list[tuple[dt.datetime, str]] = []
    seen: set[str] = set()
    for i in range(N_FRAMES):
        target = newest_t - dt.timedelta(minutes=FRAME_GAP_MIN * i)
        # Nearest available frame to the target time (MRMS's 2-min cadence means
        # this is normally an exact hit, but frames do occasionally drop out).
        best = min(candidates, key=lambda c: abs((c[0] - target).total_seconds()))
        if best[1] not in seen:
            seen.add(best[1])
            picked.append(best)
    picked.sort()
    return picked


class LatLonGrid:
    """A regular lat/lon GRIB grid, navigated from the message's own header.

    `lon1` is kept in the file's own 0-360 convention; to_rowcol() normalizes
    incoming (negative, western-hemisphere) longitudes into it.
    """

    def __init__(self, lat1: float, lon1: float, dlat: float, dlon: float, n_rows: int, n_cols: int):
        self.lat1 = lat1
        self.lon1 = lon1
        self.dlat = dlat  # negative when row 0 is the north edge (MRMS's case)
        self.dlon = dlon
        self.n_rows = n_rows
        self.n_cols = n_cols

    @classmethod
    def from_message(cls, m) -> "LatLonGrid":
        n_cols, n_rows = int(m.Ni), int(m.Nj)
        lat1 = float(m.latitudeOfFirstGridPointInDegrees)
        lat2 = float(m.latitudeOfLastGridPointInDegrees)
        lon1 = float(m.longitudeOfFirstGridPointInDegrees)
        lon2 = float(m.longitudeOfLastGridPointInDegrees)
        # Derive the increments from the endpoints rather than reading
        # iDirectionIncrementInDegrees, so the SIGN (scan direction) is picked
        # up automatically instead of assumed.
        dlat = (lat2 - lat1) / (n_rows - 1) if n_rows > 1 else 0.0
        span_lon = (lon2 - lon1) % 360.0
        dlon = span_lon / (n_cols - 1) if n_cols > 1 else 0.0
        return cls(lat1, lon1, dlat, dlon, n_rows, n_cols)

    def to_rowcol(self, lat: float, lon: float) -> tuple[int, int] | None:
        """Nearest (row, col) for a lat/lon, or None if off-grid."""
        if self.dlat == 0 or self.dlon == 0:
            return None
        row = round((lat - self.lat1) / self.dlat)
        col = round(((lon - self.lon1) % 360.0) / self.dlon)
        if not (0 <= row < self.n_rows and 0 <= col < self.n_cols):
            return None
        return int(row), int(col)

    def to_latlon(self, row: int, col: int) -> tuple[float, float]:
        """Center lat/lon of a pixel; lon returned in -180..180."""
        lat = self.lat1 + row * self.dlat
        lon = (self.lon1 + col * self.dlon + 180.0) % 360.0 - 180.0
        return lat, lon

    def km_per_pixel(self, lat: float) -> tuple[float, float]:
        """(km per row, km per col) at a given latitude. The box is only tens of
        km across, so a local flat-earth scale is accurate to well under a pixel
        and avoids dragging a projection library in for 64 km of geometry."""
        km_row = abs(self.dlat) * KM_PER_DEG_LAT
        km_col = abs(self.dlon) * KM_PER_DEG_LAT * math.cos(math.radians(lat))
        return km_row, km_col


def read_frame(key: str) -> tuple[np.ndarray, LatLonGrid]:
    """Download + gunzip + GRIB2-decode one PrecipRate frame.

    Returns (values, grid) with values in mm/hr as a plain float32 array;
    negative entries are MRMS's no-coverage/missing flags and are preserved
    as-is so callers can exclude them (see valid-pixel handling in sample_box).
    """
    raw = _get(f"{BUCKET}/{key}", timeout=90)
    buf = gzip.decompress(raw) if key.endswith(".gz") else raw
    # pygrib needs a real file path (it wraps the eccodes C API).
    with tempfile.NamedTemporaryFile(suffix=".grib2") as tf:
        tf.write(buf)
        tf.flush()
        grbs = pygrib.open(tf.name)
        try:
            m = grbs[1]  # PrecipRate files carry exactly one message
            grid = LatLonGrid.from_message(m)
            vals = m.values
            # pygrib hands back a masked array when the message declares a
            # bitmap; fill the mask with MRMS's own "missing" flag so there is
            # exactly ONE representation of no-data downstream.
            if isinstance(vals, np.ma.MaskedArray):
                vals = vals.filled(-1.0)
            vals = np.asarray(vals, dtype="float32")
            _selfcheck_navigation(m, grid)
            return vals, grid
        finally:
            grbs.close()


class NavigationError(RuntimeError):
    """The derived grid formula disagrees with the decoder's own geolocation."""


def _selfcheck_navigation(m, grid: LatLonGrid) -> None:
    """Validate the derived row/col <-> lat/lon formula against pygrib's own
    independently-computed geolocation, at the four corners and at every
    configured beach's pixel.

    This is the MRMS analogue of goes_cloud.py's navigation round-trip check:
    it validates the math on real data every run, so a grid change upstream
    (or a sign/convention slip here) surfaces as a loud failure rather than as
    quietly mis-sampled pixels 40 km from the beach. Raises NavigationError.
    """
    lats, lons = m.latlons()
    checks = [(0, 0), (0, grid.n_cols - 1), (grid.n_rows - 1, 0), (grid.n_rows - 1, grid.n_cols - 1)]
    for b in load_beaches():
        rc = grid.to_rowcol(b["lat"], b["lon"])
        if rc:
            checks.append(rc)

    worst = 0.0
    for row, col in checks:
        want_lat = float(lats[row, col])
        want_lon = (float(lons[row, col]) + 180.0) % 360.0 - 180.0
        got_lat, got_lon = grid.to_latlon(row, col)
        # Compare longitudes on the circle so a +/-180 wrap isn't read as a
        # 360-degree error.
        dlon = abs((got_lon - want_lon + 180.0) % 360.0 - 180.0)
        worst = max(worst, abs(got_lat - want_lat), dlon)
    if worst > SELFCHECK_MAX_DEG:
        raise NavigationError(
            f"grid navigation self-check failed: worst error {worst:.5f} deg "
            f"> {SELFCHECK_MAX_DEG} deg (one pixel)"
        )
    print(f"self-check: navigation worst error {worst:.6f} deg over {len(checks)} points")


def box_bounds(
    grid: LatLonGrid, lat: float, lon: float, half_km: float
) -> tuple[int, int, int, int, int, int] | None:
    """Row/col slice bounds for a box of half-width `half_km` around (lat, lon),
    plus the beach's own (row, col). None when the beach is off-grid.

    Returns (r0, r1, c0, c1, row, col) with r1/c1 exclusive. The slice is
    CLIPPED to the grid, so a beach near the domain edge yields a smaller (but
    still correctly navigated) box rather than an error.
    """
    rc = grid.to_rowcol(lat, lon)
    if rc is None:
        return None
    row, col = rc
    km_row, km_col = grid.km_per_pixel(lat)
    if km_row <= 0 or km_col <= 0:
        return None
    half_r = max(1, int(round(half_km / km_row)))
    half_c = max(1, int(round(half_km / km_col)))
    r0, r1 = max(0, row - half_r), min(grid.n_rows, row + half_r + 1)
    c0, c1 = max(0, col - half_c), min(grid.n_cols, col + half_c + 1)
    if r1 <= r0 or c1 <= c0:
        return None
    return r0, r1, c0, c1, row, col


def sample_box(
    vals: np.ndarray, grid: LatLonGrid, lat: float, lon: float
) -> dict | None:
    """rainNowMmHr / nearestRainKm / nearestBearingDeg / coveragePct for one
    beach from one frame. None when the beach is off the grid entirely.

    Valid pixels are those >= 0 — MRMS's -3 (no radar coverage) and -1
    (missing) are NOT rain-free, they are unknown, and folding them in as zeros
    would report "dry" for a beach the radar simply cannot see.
    """
    b = box_bounds(grid, lat, lon, BOX_KM / 2)
    if b is None:
        return None
    r0, r1, c0, c1, row, col = b
    sub = vals[r0:r1, c0:c1]
    valid = sub >= 0
    n_valid = int(valid.sum())

    # rainNowMmHr: 3x3 max at the beach pixel (see module docstring for why max).
    rr0, rr1 = max(0, row - 1), min(grid.n_rows, row + 2)
    rc0, rc1 = max(0, col - 1), min(grid.n_cols, col + 2)
    here = vals[rr0:rr1, rc0:rc1]
    here_valid = here[here >= 0]
    rain_now = float(here_valid.max()) if here_valid.size else None

    if n_valid == 0:
        return {
            "rainNowMmHr": rain_now,
            "nearestRainKm": None,
            "nearestBearingDeg": None,
            "coveragePct": None,
            "note": "no radar coverage in box",
        }

    wet = valid & (sub >= RAIN_MM_HR)
    coverage_pct = round(float(wet.sum()) / n_valid * 100.0, 1)

    nearest_km: float | None = None
    nearest_bearing: float | None = None
    if bool(wet.any()):
        km_row, km_col = grid.km_per_pixel(lat)
        wr, wc = np.nonzero(wet)
        # Offsets from the beach pixel, in km: north-positive and east-positive.
        # Row index grows southward on this grid (dlat < 0), so the sign of
        # dlat carries the flip rather than it being assumed here.
        north_km = (wr + r0 - row) * km_row * (1.0 if grid.dlat > 0 else -1.0)
        east_km = (wc + c0 - col) * km_col
        d2 = north_km * north_km + east_km * east_km
        i = int(np.argmin(d2))
        nearest_km = round(float(math.sqrt(d2[i])), 1)
        # A bearing only means something when the rain is somewhere ELSE. When
        # the nearest wet pixel IS the beach's own pixel the offsets are zero,
        # and atan2 on a signed zero would report a confident-looking direction
        # (it yields 180 deg for atan2(0, -0.0), which is what the north-flip
        # multiply produces) for a distance of 0 km. Say null instead — "it is
        # raining here" has no direction, and the consumer reads rainNowMmHr.
        if nearest_km > 0:
            nearest_bearing = round(
                math.degrees(math.atan2(float(east_km[i]), float(north_km[i]))) % 360.0, 0
            )

    return {
        "rainNowMmHr": None if rain_now is None else round(rain_now, 2),
        "nearestRainKm": nearest_km,
        "nearestBearingDeg": None if nearest_bearing is None else int(nearest_bearing),
        "coveragePct": coverage_pct,
        "validPixels": n_valid,
        "totalPixels": int(sub.size),
    }


def _corr_field(vals: np.ndarray, r0: int, r1: int, c0: int, c1: int) -> np.ndarray:
    """A correlation-ready slice: no-data flags zeroed, intensities clipped."""
    sub = np.array(vals[r0:r1, c0:c1], dtype="float32")
    sub[sub < 0] = 0.0
    return np.clip(sub, 0.0, CORR_CLIP_MM_HR)


def estimate_motion(
    frames: list[tuple[dt.datetime, np.ndarray]], grid: LatLonGrid, lat: float, lon: float
) -> dict | None:
    """Storm motion by cross-correlating the OLDEST and NEWEST frames.

    Returns {"speedKmh", "dirDeg", "corr", "baselineMin"} where dirDeg is the
    compass direction the rain is moving TOWARD, or None when motion cannot be
    honestly determined (see the ADVECTION note in the module docstring for
    every null case and why each is a null rather than a guess).
    """
    if len(frames) < 2:
        return None
    (t_old, v_old), (t_new, v_new) = frames[0], frames[-1]
    dt_hours = (t_new - t_old).total_seconds() / 3600.0
    if dt_hours <= 0:
        return None

    km_row, km_col = grid.km_per_pixel(lat)
    max_dr = max(1, int(round(MAX_SHIFT_KM / km_row)))
    max_dc = max(1, int(round(MAX_SHIFT_KM / km_col)))

    # The template is the analysis box out of the OLD frame; the search area is
    # that box grown by the max shift in the NEW frame, so every candidate shift
    # compares equally-sized, fully-populated windows (no shrinking-overlap bias
    # that would otherwise favor large shifts).
    tb = box_bounds(grid, lat, lon, BOX_KM / 2)
    if tb is None:
        return None
    r0, r1, c0, c1, _row, _col = tb
    # The search window must exist at full size in the new frame, or shifts near
    # the edge would silently compare clipped arrays.
    if r0 - max_dr < 0 or r1 + max_dr > grid.n_rows or c0 - max_dc < 0 or c1 + max_dc > grid.n_cols:
        return None

    tpl = _corr_field(v_old, r0, r1, c0, c1)
    if int((tpl >= RAIN_MM_HR).sum()) < MIN_CORR_PIXELS:
        return None  # too little rain in the old frame to recognize anything
    tpl_c = tpl - tpl.mean()
    tpl_norm = float(np.sqrt((tpl_c * tpl_c).sum()))
    if tpl_norm <= 0:
        return None

    best_score = -2.0
    best: tuple[int, int] | None = None
    for dr in range(-max_dr, max_dr + 1):
        for dc in range(-max_dc, max_dc + 1):
            cand = _corr_field(v_new, r0 + dr, r1 + dr, c0 + dc, c1 + dc)
            cand_c = cand - cand.mean()
            cand_norm = float(np.sqrt((cand_c * cand_c).sum()))
            if cand_norm <= 0:
                continue
            score = float((tpl_c * cand_c).sum()) / (tpl_norm * cand_norm)
            if score > best_score:
                best_score = score
                best = (dr, dc)

    if best is None or best_score < MIN_CORR_SCORE:
        return None
    dr, dc = best
    # A peak pinned to the edge of the search window means the true peak is
    # probably OUTSIDE it — report nothing rather than a speed we know is a
    # lower bound masquerading as a measurement.
    if abs(dr) == max_dr or abs(dc) == max_dc:
        return None

    north_km = dr * km_row * (1.0 if grid.dlat > 0 else -1.0)
    east_km = dc * km_col
    speed = math.hypot(north_km, east_km) / dt_hours
    direction = math.degrees(math.atan2(east_km, north_km)) % 360.0
    return {
        "speedKmh": round(speed, 1),
        "dirDeg": int(round(direction)) % 360,
        "corr": round(best_score, 3),
        "baselineMin": round(dt_hours * 60, 1),
    }


def estimate_eta(
    vals: np.ndarray, grid: LatLonGrid, lat: float, lon: float, motion: dict | None
) -> int | None:
    """Minutes until rain reaches the beach, by marching the beach BACKWARD
    along the motion vector (see the ETA note in the module docstring).

    None whenever there is no honest answer: no motion, motion below
    MIN_MOTION_KMH, the upstream track running off-grid, or the track being dry
    out to ETA_MAX_MINUTES (rain that is nearby but drifting away).
    """
    if not motion:
        return None
    speed = float(motion["speedKmh"])
    if speed < MIN_MOTION_KMH:
        return None
    heading = math.radians(float(motion["dirDeg"]))
    # Velocity components of the RAIN (north/east positive).
    v_north = speed * math.cos(heading)
    v_east = speed * math.sin(heading)

    km_row, km_col = grid.km_per_pixel(lat)
    probe_r = max(1, int(round(ETA_PROBE_RADIUS_KM / km_row)))
    probe_c = max(1, int(round(ETA_PROBE_RADIUS_KM / km_col)))
    rc = grid.to_rowcol(lat, lon)
    if rc is None:
        return None
    row, col = rc
    row_sign = 1.0 if grid.dlat > 0 else -1.0

    t = ETA_STEP_MINUTES
    while t <= ETA_MAX_MINUTES:
        hours = t / 60.0
        # Where the rain that would arrive at t is RIGHT NOW: upstream of the
        # beach by the distance it will travel.
        up_north = -v_north * hours
        up_east = -v_east * hours
        pr = row + int(round(up_north / km_row * row_sign))
        pc = col + int(round(up_east / km_col))
        r0, r1 = pr - probe_r, pr + probe_r + 1
        c0, c1 = pc - probe_c, pc + probe_c + 1
        if r0 < 0 or c0 < 0 or r1 > grid.n_rows or c1 > grid.n_cols:
            return None  # upstream track has left the grid
        probe = vals[r0:r1, c0:c1]
        if bool(np.any((probe >= RAIN_MM_HR))):
            return int(round(t))
        t += ETA_STEP_MINUTES
    return None


def load_beaches() -> list[dict]:
    """BEACHES, or the MRMS_BEACHES JSON override (used by the local real-data
    proof to aim the identical code at a coordinate that currently has echoes)."""
    raw = os.environ.get("MRMS_BEACHES")
    if not raw:
        return BEACHES
    try:
        parsed = json.loads(raw)
        out = [
            {"slug": str(b["slug"]), "lat": float(b["lat"]), "lon": float(b["lon"])}
            for b in parsed
            if b.get("slug") is not None and b.get("lat") is not None and b.get("lon") is not None
        ]
        return out or BEACHES
    except Exception as e:  # noqa: BLE001
        print(f"warn: bad MRMS_BEACHES ({e}) — using built-in list", file=sys.stderr)
        return BEACHES


def iso(t: dt.datetime) -> str:
    return t.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_out(payload: dict) -> None:
    out_path = OUT if os.path.isabs(OUT) else os.path.join(REPO_ROOT, OUT)
    with open(out_path, "w") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    print(f"wrote {out_path}")


def empty_payload(note: str, beaches: list[dict]) -> dict:
    """A well-formed file with null readings. Publishing this (rather than
    leaving the last good file in place) is what lets the app distinguish
    "the radar job ran and found nothing" from "the job has been dead for
    hours" — the branch's own freshness is the app's staleness gate."""
    return {
        "version": FEED_VERSION,
        "generatedAt": iso(dt.datetime.now(dt.timezone.utc)),
        "product": PRODUCT,
        "frames": [],
        "note": note,
        "beaches": {
            b["slug"]: {
                "rainNowMmHr": None,
                "nearestRainKm": None,
                "nearestBearingDeg": None,
                "coveragePct": None,
                "motion": None,
                "etaMinutes": None,
                "frameIso": None,
                "framesUsed": 0,
                "note": note,
            }
            for b in beaches
        },
    }


def main() -> int:
    beaches = load_beaches()
    print(f"beaches: {[b['slug'] for b in beaches]}")

    picked = pick_frames()
    if not picked:
        print("warn: no MRMS frames available — publishing nulls", file=sys.stderr)
        write_out(empty_payload("no MRMS frames available", beaches))
        return 0
    print("frames: " + ", ".join(f"{iso(t)}" for t, _ in picked))

    frames: list[tuple[dt.datetime, np.ndarray]] = []
    grid: LatLonGrid | None = None
    for t, key in picked:
        try:
            vals, g = read_frame(key)
        except NavigationError as e:
            # A code bug, not a data outage — never publish mis-navigated pixels.
            print(f"FATAL: {e}", file=sys.stderr)
            return 1
        except Exception as e:  # noqa: BLE001
            print(f"warn: frame {key}: {e}", file=sys.stderr)
            continue
        if grid is not None and (g.n_rows, g.n_cols) != (grid.n_rows, grid.n_cols):
            # Mixed grids can't be correlated against each other; drop the odd one.
            print(f"warn: frame {key} has a different grid — skipping", file=sys.stderr)
            continue
        grid = g
        frames.append((t, vals))

    if not frames or grid is None:
        print("warn: no frame decoded — publishing nulls", file=sys.stderr)
        write_out(empty_payload("no MRMS frame could be decoded", beaches))
        return 0

    frames.sort(key=lambda f: f[0])
    newest_t, newest_v = frames[-1]

    results: dict[str, dict] = {}
    for b in beaches:
        slug, lat, lon = b["slug"], b["lat"], b["lon"]
        try:
            sampled = sample_box(newest_v, grid, lat, lon)
            if sampled is None:
                results[slug] = {
                    "rainNowMmHr": None,
                    "nearestRainKm": None,
                    "nearestBearingDeg": None,
                    "coveragePct": None,
                    "motion": None,
                    "etaMinutes": None,
                    "frameIso": iso(newest_t),
                    "framesUsed": len(frames),
                    "note": "beach outside the MRMS CONUS grid",
                }
                continue
            motion = estimate_motion(frames, grid, lat, lon)
            eta = estimate_eta(newest_v, grid, lat, lon, motion)
            entry = {
                "rainNowMmHr": sampled["rainNowMmHr"],
                "nearestRainKm": sampled["nearestRainKm"],
                "nearestBearingDeg": sampled["nearestBearingDeg"],
                "coveragePct": sampled["coveragePct"],
                "motion": motion,
                "etaMinutes": eta,
                "frameIso": iso(newest_t),
                "framesUsed": len(frames),
            }
            if sampled.get("note"):
                entry["note"] = sampled["note"]
            results[slug] = entry
        except Exception as e:  # noqa: BLE001
            # One bad beach must never sink the whole feed.
            print(f"warn: beach {slug}: {e}", file=sys.stderr)
            results[slug] = {
                "rainNowMmHr": None,
                "nearestRainKm": None,
                "nearestBearingDeg": None,
                "coveragePct": None,
                "motion": None,
                "etaMinutes": None,
                "frameIso": iso(newest_t),
                "framesUsed": len(frames),
                "note": f"sampling failed: {e}",
            }

    payload = {
        "version": FEED_VERSION,
        "generatedAt": iso(dt.datetime.now(dt.timezone.utc)),
        "product": PRODUCT,
        # Every frame that actually decoded, oldest-first. `frameIso` per beach
        # is the newest of these — the observation time the app displays.
        "frames": [iso(t) for t, _ in frames],
        "beaches": results,
    }
    if len(frames) < 2:
        payload["note"] = "only one frame available — no motion/ETA this run"
    write_out(payload)

    n_rain = sum(1 for v in results.values() if (v.get("rainNowMmHr") or 0) >= RAIN_MM_HR)
    n_eta = sum(1 for v in results.values() if v.get("etaMinutes") is not None)
    print(
        f"{len(results)} beaches: {n_rain} raining now, {n_eta} with an ETA, "
        f"{len(frames)} frames used"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
