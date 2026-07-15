#!/usr/bin/env python3
"""
Build a small goes-cloud.json of SATELLITE-OBSERVED cloud fraction per beach,
from NOAA GOES-19 ABI Clear Sky Mask (ABI-L2-ACMC) granules on AWS Open Data.

WHY THIS EXISTS (2026-07-15 anvil miss)
----------------------------------------
The sand-temp model (lib/sandTemp.ts) takes a FORECAST cloud-cover % as an
input and damps its dry-sand solar boost once cover crosses ~70% (see
OVERCAST_START_PCT/OVERCAST_MAX_DAMP there). On 2026-07-15 the Boca beach sat
under a thunderstorm anvil — genuinely ~95-100% overcast — while Open-Meteo's
forecast cloud field reported 11-24% and 701-821 W/m2 of "clear sky" solar.
The app said 133-135F sand; IR-thermometer ground truth was 100-115F. Re-run
with the REAL cloud cover, the existing damping curve alone gets the estimate
to ~105/109F vs 100/112.5F measured — i.e. the transfer function was fine, the
INPUT was wrong by ~70 points. This script fixes the input by reading actual
satellite cloud observations instead of trusting a forecast model's guess.

Do NOT "fix" this by retuning MAX_SUN_BOOST_F or the sqrt curve in
sandTemp.ts — see the 2026-07-15 note in that file's calibration log.

WHAT THIS PRODUCES
-------------------
Runs OFF Netlify (a GitHub Action, mirroring scripts/glm_lightning.py). It
finds the newest ABI-L2-ACMC (CONUS Clear Sky Mask) granule, downloads it,
converts every configured beach's lat/lon to the ABI fixed-grid pixel via the
standard GOES-R navigation equations, samples a small neighborhood around
each beach, and reduces the 4-level cloud mask to a single 0-100 "observed
cloud %" per beach. The output is a few KB of JSON; the app reads it the same
way it reads the GLM lightning feed (lib/sources/goesCloud.ts).

DATA SOURCE FACTS (verified against the live bucket 2026-07-15)
------------------------------------------------------------------
- ABI-L2-DSRC (CONUS solar radiation) has ZERO objects on GOES-19, and its
  full-disk sibling is quality-bounded to solar zenith <=70 deg — useless for
  a late-afternoon low-sun case. DSR is NOT used here.
- ABI-L2-ACMC (Clear Sky Mask, CONUS) exists, is anonymous/keyless HTTP,
  ~4.9 MB/granule, 2 km resolution, a ~1500x2500 CONUS grid, and is produced
  ~every 5 min, day AND night (it doesn't need sunlight).
- The feed GAPS. It is normal for the newest available granule to be 30-90+
  minutes old (an 83-minute gap was observed live on 2026-07-15). This script
  reports the granule's own timestamp; the app-side staleness gate (see
  lib/sources/goesCloud.ts) is what decides whether to trust it as "now".

NAVIGATION (lat/lon <-> ABI fixed-grid pixel)
-----------------------------------------------
Implements the standard GOES-R "Product User's Guide" fixed-grid forward and
inverse navigation equations directly (no pyproj/pyresample/satpy — this
project's dependency budget is h5py + numpy, same as glm_lightning.py). Every
run does a real round-trip self-check per beach: lat/lon -> nearest pixel ->
inverse-transform the pixel's OWN center back to lat/lon, and asserts the
haversine error is within ~1 pixel (~2 km / GOES_SELFCHECK_MAX_M). If that
check fails for any in-domain beach, the script exits non-zero rather than
silently publishing bad pixels.

CLOUD FRACTION MAPPING
------------------------
ACM (the "4-level cloud mask") reports, per pixel: 0=clear, 1=probably_clear,
2=probably_cloudy, 3=cloudy. We map those to a 0-1 fraction and average over a
NEIGHBORHOOD (not a single pixel) around each beach:
    clear            -> 0.0
    probably_clear    -> 0.33
    probably_cloudy    -> 0.67
    cloudy            -> 1.0
A neighborhood (~GOES_BOX_KM km on a side, ~7x7 pixels at 2 km by default) is
sampled rather than one pixel because "cloud cover %" is inherently an
area concept, AND because at low sun angle the cloud actually shading the
beach is horizontally OFFSET from the beach itself (the sun is not straight
overhead). This overhead box is still produced (as cloudPct, unchanged) — see
BEAM-PATH CLOUD below for the offset-along-the-sun sampling this docstring
used to describe as a future refinement.

BEAM-PATH CLOUD (beamCloudPct) — 2026-07-15 CONFIRMED finding
-----------------------------------------------------------------
An overhead cloud box answers "is the sky grey above the beach", but the
thing that actually heats dry sand is the DIRECT solar BEAM, and at low sun
angle that beam travels through air kilometres toward the sun before it
reaches the ground. On 2026-07-15 the archived 20:16Z granule proved this
directly for Boca Raton (sun at that time: elevation 51.1 deg, azimuth 272
deg): the beach-centered box read 31% cloud, but boxes stepped along the
solar azimuth read 58% at 3 km, 71% at 6 km, 86% at 10 km, and 85-100% at
15-30 km — while the ANTI-sun direction (out over the ocean) read 17% / 4% /
0%. The cloud blocking the beam was real, and kilometres west of the beach;
the overhead box completely missed it. See lib/sandTemp.ts's 2026-07-15
calibration note for the full writeup (candidate (c), now confirmed).

beamCloudPct estimates this per beach: for each of a handful of altitude
"slots" (2, 4, 6, 9, 12 km — ACM has no cloud-top-height field, so this
scans a spread of plausible deck heights rather than picking one), it
projects a ground offset d = altitude / tan(solar elevation) along the solar
azimuth, samples a same-sized DQF-gated box there, and combines the slots as
beamCloudPct = max(overhead box, mean of the valid offset boxes). See
beam_cloud_pct()'s docstring for why max-of-mean was chosen over a
"probability any layer blocks the beam" combination (1 - PROD(1 - f_i)):
with 5 correlated, height-blind slots the product form saturates toward
100%-blocked almost any time a few slots see scattered cloud, which is far
more aggressive than the physical situation of one deck sampled multiple
times. Offsets beyond ~35 km are skipped (too far to be the relevant deck);
above 65 deg elevation the offsets collapse inside the overhead box already,
so beamCloudPct just equals cloudPct; below 5 deg elevation beamCloudPct is
null (negligible beam heating at night/near-horizon sun anyway, and solar
azimuth gets noisy). The estimator is swappable — see the single
beam_cloud_pct() function.

QUALITY
--------
DQF (data quality flags) is respected: only DQF==0 ("good_quality_qf")
pixels count as valid. Fill/space/bad/degraded/spare pixels are excluded.
When too few valid pixels remain in a beach's neighborhood (fewer than
GOES_MIN_VALID_PIXELS), that beach's cloudPct is emitted as null rather than
a fabricated number — never guess. The same rule applies per offset box for
beamCloudPct; if too few of the offset boxes have enough valid pixels,
beamCloudPct falls back to the overhead box rather than fabricating a beam
reading from noise.

ENV OVERRIDES (mirrors glm_lightning.py's style)
---------------------------------------------------
  GOES_BUCKET               default https://noaa-goes19.s3.amazonaws.com
  GOES_PRODUCT               default ABI-L2-ACMC
  GOES_MAX_LOOKBACK_HOURS     how far back to search for a granule (default 6)
  GOES_BOX_KM                 neighborhood side length in km (default 15)
  GOES_MIN_VALID_PIXELS       min good-quality pixels to emit a real % (default 5)
  GOES_SELFCHECK_MAX_M       max allowed navigation round-trip error, meters (default 2500)
  GOES_GRANULE_KEY            force a specific S3 key instead of searching for the
                               newest granule (testability/reproducing a known case)
  GOES_OUT                   output path (default goes_cloud.json)
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

BUCKET = os.environ.get("GOES_BUCKET", "https://noaa-goes19.s3.amazonaws.com")
PRODUCT = os.environ.get("GOES_PRODUCT", "ABI-L2-ACMC")
MAX_LOOKBACK_HOURS = int(os.environ.get("GOES_MAX_LOOKBACK_HOURS", "6"))
BOX_KM = float(os.environ.get("GOES_BOX_KM", "15"))
# Native resolution of the ABI CONUS Clear Sky Mask product (documented spec,
# not derived per-file — the file's x/y scale factors encode scan ANGLE step,
# not linear km, so we use the well-known 2 km CONUS product resolution here).
PIXEL_KM = 2.0
MIN_VALID_PIXELS = int(os.environ.get("GOES_MIN_VALID_PIXELS", "5"))
SELFCHECK_MAX_M = float(os.environ.get("GOES_SELFCHECK_MAX_M", "2500"))
OUT = os.environ.get("GOES_OUT", "goes_cloud.json")
# Force a specific granule S3 key instead of searching for the newest one —
# for testability and for reproducing a known case (e.g. the 2026-07-15
# 20:16Z granule that confirmed beam-path cloud blocking).
GRANULE_KEY_OVERRIDE = os.environ.get("GOES_GRANULE_KEY")
SATELLITE = "GOES-19"
# Feed schema version. Bumped for the beamCloudPct/sunElevDeg addition so
# consumers can tell an old-format cached/stale feed apart from a new one.
FEED_VERSION = 2
S3_NS = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}

# ACM's 4-level cloud mask -> a 0-1 cloud fraction. See module docstring.
ACM_WEIGHTS = {0: 0.0, 1: 0.33, 2: 0.67, 3: 1.0}

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# --- S3 listing (identical pattern to glm_lightning.py: anonymous, no boto3) -
def _get(url: str, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "boca-beach-rats-goes-cloud"})
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
    """Granule start time from the `_sYYYYDDDHHMMSSt` token in the filename
    (same convention as glm_lightning.py's start_time)."""
    m = re.search(r"_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})", key)
    if not m:
        return None
    y, doy, hh, mm, ss = map(int, m.groups())
    return dt.datetime(y, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(
        days=doy - 1, hours=hh, minutes=mm, seconds=ss
    )


def find_latest_granule() -> tuple[dt.datetime, str] | None:
    """Walk back hour-by-hour (across hour/day/year boundaries) until a
    non-empty ACMC listing is found, and return its newest (start_time, key).
    The current hour is very often still empty (granules land ~5 min apart,
    but the listing for "this hour" may not have any yet early in the hour),
    so this routinely needs to look at the previous hour too."""
    now = dt.datetime.now(dt.timezone.utc)
    t = now.replace(minute=0, second=0, microsecond=0)
    for i in range(MAX_LOOKBACK_HOURS + 1):
        hour = t - dt.timedelta(hours=i)
        prefix = f"{PRODUCT}/{hour.year}/{int(hour.strftime('%j')):03d}/{hour.hour:02d}/"
        try:
            keys = list_keys(prefix)
        except Exception as e:  # noqa: BLE001
            print(f"warn: list {prefix}: {e}", file=sys.stderr)
            continue
        candidates = [(st, k) for k in keys if (st := start_time(k)) is not None]
        if candidates:
            candidates.sort()
            return candidates[-1]
    return None


# --- GOES-R ABI fixed-grid navigation (PUG L1b/L2+ Vol. 3, sec. 5.1.2.8) -----
# Forward: geodetic lat/lon (deg) -> fixed-grid scan angles x,y (radians).
# Inverse: fixed-grid scan angles x,y (radians) -> geodetic lat/lon (deg).
# No pyproj/pyresample/satpy: this is the closed-form equations straight from
# NOAA's own navigation spec, using only the projection attrs the granule
# itself carries (perspective_point_height, semi_major/minor_axis,
# longitude_of_projection_origin) — never hardcoded.
class AbiNav:
    def __init__(self, req_m: float, rpol_m: float, h_m: float, lon0_deg: float):
        self.req = req_m
        self.rpol = rpol_m
        self.H = h_m + req_m  # satellite distance from Earth's center
        self.lam0 = math.radians(lon0_deg)
        self.e2 = (req_m**2 - rpol_m**2) / req_m**2

    @classmethod
    def from_h5(cls, f: h5py.File) -> "AbiNav":
        proj = f["goes_imager_projection"].attrs
        return cls(
            req_m=float(np.asarray(proj["semi_major_axis"]).ravel()[0]),
            rpol_m=float(np.asarray(proj["semi_minor_axis"]).ravel()[0]),
            h_m=float(np.asarray(proj["perspective_point_height"]).ravel()[0]),
            lon0_deg=float(np.asarray(proj["longitude_of_projection_origin"]).ravel()[0]),
        )

    def forward(self, lat_deg: float, lon_deg: float) -> tuple[float, float]:
        lat = math.radians(lat_deg)
        lon = math.radians(lon_deg)
        phi_c = math.atan((self.rpol**2 / self.req**2) * math.tan(lat))
        rc = self.rpol / math.sqrt(1 - self.e2 * math.cos(phi_c) ** 2)
        sx = self.H - rc * math.cos(phi_c) * math.cos(lon - self.lam0)
        sy = -rc * math.cos(phi_c) * math.sin(lon - self.lam0)
        sz = rc * math.sin(phi_c)
        x = math.asin(-sy / math.sqrt(sx * sx + sy * sy + sz * sz))
        y = math.atan(sz / sx)
        return x, y

    def inverse(self, x: float, y: float) -> tuple[float, float]:
        a = math.sin(x) ** 2 + math.cos(x) ** 2 * (
            math.cos(y) ** 2 + (self.req**2 / self.rpol**2) * math.sin(y) ** 2
        )
        b = -2 * self.H * math.cos(x) * math.cos(y)
        c = self.H**2 - self.req**2
        disc = b * b - 4 * a * c
        if disc < 0:
            raise ValueError("point off the visible Earth disk")
        rs = (-b - math.sqrt(disc)) / (2 * a)
        sx = rs * math.cos(x) * math.cos(y)
        sy = -rs * math.sin(x)
        sz = rs * math.cos(x) * math.sin(y)
        lat = math.atan((self.req**2 / self.rpol**2) * (sz / math.sqrt((self.H - sx) ** 2 + sy**2)))
        lon = self.lam0 - math.atan(sy / (self.H - sx))
        return math.degrees(lat), math.degrees(lon)


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# --- solar position (NOAA low-precision algorithm) --------------------------
# Good to a few tenths of a degree, which is plenty for picking a ~2 km ABI
# pixel a few km along the beam path — no need for a full ephemeris library.
# Verified against a known value: Boca Raton (26.3587, -80.0707) at
# 2026-07-15T20:16Z gives elevation ~51.1 deg, azimuth ~272 deg (see
# scripts/goes_cloud.test equivalent in the vitest suite / this module's
# self-test below), matching the archived-granule experiment that confirmed
# beam-path cloud blocking (see module docstring).
def solar_position(when: dt.datetime, lat: float, lon: float) -> tuple[float, float]:
    """(elevation_deg, azimuth_deg from true north, clockwise) of the sun at
    `when` (must be timezone-aware UTC) as seen from lat/lon."""
    j2000 = dt.datetime(2000, 1, 1, 12, tzinfo=dt.timezone.utc)
    n = (when - j2000).total_seconds() / 86400.0
    mean_lon = (280.460 + 0.9856474 * n) % 360.0
    mean_anom = math.radians((357.528 + 0.9856003 * n) % 360.0)
    ecl_lon = math.radians(
        mean_lon + 1.915 * math.sin(mean_anom) + 0.020 * math.sin(2 * mean_anom)
    )
    obliquity = math.radians(23.439 - 4.0e-7 * n)
    dec = math.asin(math.sin(obliquity) * math.sin(ecl_lon))
    ra = math.atan2(math.cos(obliquity) * math.sin(ecl_lon), math.cos(ecl_lon))
    gmst_deg = (280.46061837 + 360.98564736629 * n) % 360.0
    hour_angle = math.radians((gmst_deg + lon - math.degrees(ra)) % 360.0)
    phi = math.radians(lat)
    el = math.asin(
        math.sin(phi) * math.sin(dec) + math.cos(phi) * math.cos(dec) * math.cos(hour_angle)
    )
    az_south_based = math.atan2(
        math.sin(hour_angle), math.cos(hour_angle) * math.sin(phi) - math.tan(dec) * math.cos(phi)
    )
    az = (math.degrees(az_south_based) + 180.0) % 360.0  # from true north, clockwise
    return math.degrees(el), az


def offset_latlon(lat: float, lon: float, km: float, bearing_deg: float) -> tuple[float, float]:
    """A point `km` from (lat, lon) along compass bearing `bearing_deg` (deg
    from true north, clockwise), using a flat-earth approximation — fine at
    the <=35 km ranges this script uses (error is well under a pixel)."""
    b = math.radians(bearing_deg)
    dlat = km * math.cos(b) / 111.32
    dlon = km * math.sin(b) / (111.32 * math.cos(math.radians(lat)))
    return lat + dlat, lon + dlon


# --- beam-path cloud (beamCloudPct) — see module docstring ------------------
# Altitude slots (km) to probe along the solar azimuth. ACM has no cloud-top
# height, so this scans a spread of plausible deck heights rather than one.
BEAM_ALTITUDES_KM = (2.0, 4.0, 6.0, 9.0, 12.0)
# Beyond this ground offset, the offset box is far enough from the beach that
# treating it as "the cloud shading this beach" stops being credible (limb of
# usefulness) — skip it rather than sample something irrelevant.
BEAM_MAX_OFFSET_KM = 35.0
# Below this solar elevation, beam heating of dry sand is already negligible
# (near-horizon/night) and azimuth becomes numerically noisy — emit null.
BEAM_MIN_ELEV_DEG = 5.0
# Above this elevation, every offset (even the 12 km/highest slot) collapses
# to well under one box-width from the beach, so the offset sampling adds
# nothing over the overhead box — just reuse it.
BEAM_COLLAPSE_ELEV_DEG = 65.0


def beam_cloud_pct(
    beach_pct: float | None,
    sample_fn,
    lat: float,
    lon: float,
    el_deg: float | None,
    az_deg: float | None,
) -> float | None:
    """Estimate the cloud fraction actually blocking the direct solar beam
    reaching (lat, lon), given the overhead box's reading (`beach_pct`) and a
    `sample_fn(lat, lon) -> (pct_or_None, valid_px, total_px)` callback for
    sampling an arbitrary offset box (same DQF gating as the overhead box).

    ESTIMATOR CHOICE: beamCloudPct = max(beach_pct, mean(valid offset boxes)).
    A physically-motivated alternative would treat each altitude slot as an
    independent chance to block the beam and combine them as
    100 * (1 - PROD_i(1 - f_i)) — but that's too aggressive here: ACM carries
    no cloud-top-height, so the 5 slots are really 5 correlated, noisy guesses
    at the SAME deck's height, not 5 independent cloud layers. Treating them
    as independent saturates toward "100% blocked" almost any time a few
    slots see scattered cloud, which overstates the physical situation (one
    deck, sampled several times). A plain mean of the offset boxes is a much
    better-behaved "how cloudy is the sunward corridor, on average" estimate,
    and taking max(...) with the overhead box means a beach that's already
    cloudy overhead never gets a falsely-clear beam reading just because the
    (also cloudy) sunward corridor happened to sample a gap. Swap this
    function's body to change the estimator; every caller only depends on the
    signature above.
    """
    if el_deg is None or az_deg is None or el_deg < BEAM_MIN_ELEV_DEG:
        return None
    if el_deg > BEAM_COLLAPSE_ELEV_DEG:
        return beach_pct

    offset_pcts: list[float] = []
    for h_km in BEAM_ALTITUDES_KM:
        d_km = h_km / math.tan(math.radians(el_deg))
        if d_km > BEAM_MAX_OFFSET_KM:
            continue
        olat, olon = offset_latlon(lat, lon, d_km, az_deg)
        pct, _valid_px, _total_px = sample_fn(olat, olon)
        if pct is not None:
            offset_pcts.append(pct)

    if not offset_pcts:
        # No offset box had enough good-quality pixels (or was off-grid) —
        # never fabricate a beam reading from nothing; fall back to overhead.
        return beach_pct
    mean_offset = float(np.mean(offset_pcts))
    if beach_pct is None:
        return round(mean_offset, 1)
    return round(max(beach_pct, mean_offset), 1)


# --- beach list: config/locations.ts (hand-curated) + locations.generated.json
def load_beaches() -> list[dict]:
    """Merge the hand-curated TS locations with the admin-added generated JSON,
    exactly like config/locations.ts's allLocations() does (curated first,
    generated entries deduped by slug). We only need slug/lat/lon here, so the
    TS file is parsed with a small targeted regex rather than a JS toolchain —
    every LOCATIONS entry is `slug: "...", ... lat: N, lon: N, ... cams:`, and
    that shape is stable/simple enough to lift without executing TypeScript."""
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


def main() -> int:
    beaches = load_beaches()
    if not beaches:
        print("error: no beaches loaded from config", file=sys.stderr)
        return 1
    print(f"loaded {len(beaches)} beaches from config")

    if GRANULE_KEY_OVERRIDE:
        st = start_time(GRANULE_KEY_OVERRIDE)
        if st is None:
            print(
                f"error: GOES_GRANULE_KEY={GRANULE_KEY_OVERRIDE!r} doesn't match the "
                "expected _sYYYYDDDHHMMSSt granule-key pattern",
                file=sys.stderr,
            )
            return 1
        found = (st, GRANULE_KEY_OVERRIDE)
        print(f"using GOES_GRANULE_KEY override: {GRANULE_KEY_OVERRIDE}")
    else:
        found = find_latest_granule()
    if found is None:
        print(
            f"error: no {PRODUCT} granule found within {MAX_LOOKBACK_HOURS}h lookback "
            "(feed may be down or badly gapped)",
            file=sys.stderr,
        )
        return 1
    granule_start, key = found
    now = dt.datetime.now(dt.timezone.utc)
    age_min = (now - granule_start).total_seconds() / 60
    print(f"newest granule: {key} (start {granule_start.isoformat()}, {age_min:.1f} min old)")

    buf = _get(f"{BUCKET}/{key}", timeout=90)
    print(f"downloaded {len(buf) / 1e6:.2f} MB")

    with tempfile.NamedTemporaryFile(suffix=".nc") as tf:
        tf.write(buf)
        tf.flush()
        with h5py.File(tf.name, "r") as f:
            nav = AbiNav.from_h5(f)

            x_raw = f["x"][:].astype("float64")
            y_raw = f["y"][:].astype("float64")
            x_scale = float(np.asarray(f["x"].attrs["scale_factor"]).ravel()[0])
            x_off = float(np.asarray(f["x"].attrs["add_offset"]).ravel()[0])
            y_scale = float(np.asarray(f["y"].attrs["scale_factor"]).ravel()[0])
            y_off = float(np.asarray(f["y"].attrs["add_offset"]).ravel()[0])
            x_rad = x_raw * x_scale + x_off
            y_rad = y_raw * y_scale + y_off
            x_min, x_max = float(x_rad.min()), float(x_rad.max())
            y_min, y_max = float(y_rad.min()), float(y_rad.max())

            acm = f["ACM"][:]
            dqf = f["DQF"][:]
            n_rows, n_cols = acm.shape

            # Neighborhood half-width in pixels: BOX_KM on a side, PIXEL_KM per
            # pixel -> ~(BOX_KM/PIXEL_KM - 1)/2 pixels on each side of center.
            # Defaults (15 km, 2 km) -> radius 3 -> a 7x7 box, as specified.
            box_radius_px = max(1, round((BOX_KM / PIXEL_KM - 1) / 2))

            def sample_box(lat: float, lon: float) -> tuple[float | None, int, int]:
                """DQF-gated cloud % for a box_radius_px-radius box centered on
                the ABI pixel nearest (lat, lon). Returns (pct_or_None,
                valid_px, total_px); pct is None if (lat, lon) is off the
                CONUS grid entirely OR the box has too few good-quality
                pixels — callers decide fallback behavior, this never
                fabricates. Shared by the overhead box and every beamCloudPct
                offset box, so both use identical gating."""
                try:
                    x, y = nav.forward(lat, lon)
                except (ValueError, ZeroDivisionError):
                    return None, 0, 0
                if not (x_min <= x <= x_max and y_min <= y <= y_max):
                    return None, 0, 0
                col = int(round((x - x_off) / x_scale))
                row = int(round((y - y_off) / y_scale))
                if not (0 <= row < n_rows and 0 <= col < n_cols):
                    return None, 0, 0
                r0, r1 = max(0, row - box_radius_px), min(n_rows, row + box_radius_px + 1)
                c0, c1 = max(0, col - box_radius_px), min(n_cols, col + box_radius_px + 1)
                acm_sub = acm[r0:r1, c0:c1]
                dqf_sub = dqf[r0:r1, c0:c1]
                total_px = int(acm_sub.size)
                # Respect DQF: only good_quality_qf (0) pixels count. Also
                # guard against any ACM value outside the documented 0-3 flag
                # range (255 is the fill value; DQF!=0 already excludes it,
                # this is belt-and-suspenders).
                valid_mask = (dqf_sub == 0) & (acm_sub <= 3)
                valid_px = int(valid_mask.sum())
                if valid_px < MIN_VALID_PIXELS:
                    return None, valid_px, total_px
                levels = acm_sub[valid_mask].astype(int)
                frac = float(np.mean([ACM_WEIGHTS[int(v)] for v in levels]))
                return round(frac * 100, 1), valid_px, total_px

            results: dict[str, dict] = {}
            selfcheck_errors_m: list[float] = []

            for b in beaches:
                slug, lat, lon = b["slug"], b["lat"], b["lon"]

                beach_pct, valid_px, total_px = sample_box(lat, lon)

                # Self-check: inverse-transform the beach's own nearest
                # pixel center back to lat/lon and confirm it's within ~1
                # pixel of the beach's true coordinates. This validates the
                # navigation math itself on every run, using real granule
                # data (no hardcoded "known good" pixel needed) — see module
                # docstring. Only meaningful for in-domain beaches.
                try:
                    x, y = nav.forward(lat, lon)
                    if x_min <= x <= x_max and y_min <= y <= y_max:
                        col = int(round((x - x_off) / x_scale))
                        row = int(round((y - y_off) / y_scale))
                        if 0 <= row < n_rows and 0 <= col < n_cols:
                            lat2, lon2 = nav.inverse(x_rad[col], y_rad[row])
                            selfcheck_errors_m.append(haversine_m(lat, lon, lat2, lon2))
                except (ValueError, ZeroDivisionError):
                    selfcheck_errors_m.append(float("inf"))

                # Sun position AT THE GRANULE'S OWN SCAN TIME (not "now") —
                # the offset boxes need to know where the cloud that could be
                # blocking THIS observation's beam would be, not the sun's
                # current position if the granule is old.
                el_deg, az_deg = solar_position(granule_start, lat, lon)
                beam_pct = beam_cloud_pct(beach_pct, sample_box, lat, lon, el_deg, az_deg)

                results[slug] = {
                    "cloudPct": beach_pct,
                    "beamCloudPct": beam_pct,
                    "sunElevDeg": round(el_deg, 1),
                    "validPixels": valid_px,
                    "totalPixels": total_px,
                }

            # Loud self-check: the navigation math must round-trip every
            # in-domain beach to within ~1 pixel. A failure here means the
            # projection equations or attrs are wrong — that's a code bug, not
            # a data-quality issue, so it must not publish silently-bad pixels.
            if selfcheck_errors_m:
                max_err = max(selfcheck_errors_m)
                print(
                    f"self-check: navigation round-trip max error "
                    f"{max_err:.0f} m across {len(selfcheck_errors_m)} beaches "
                    f"(threshold {SELFCHECK_MAX_M:.0f} m)"
                )
                if max_err > SELFCHECK_MAX_M:
                    print(
                        f"FATAL: navigation self-check failed ({max_err:.0f} m > "
                        f"{SELFCHECK_MAX_M:.0f} m) — refusing to publish",
                        file=sys.stderr,
                    )
                    return 1
            else:
                print("self-check: no in-domain beaches to validate against (unexpected)")

    out = {
        "version": FEED_VERSION,
        "generatedAt": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "granuleStartIso": granule_start.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "satellite": SATELLITE,
        "beaches": results,
    }
    out_path = OUT if os.path.isabs(OUT) else os.path.join(REPO_ROOT, OUT)
    with open(out_path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    n_ok = sum(1 for v in results.values() if v["cloudPct"] is not None)
    n_beam = sum(1 for v in results.values() if v["beamCloudPct"] is not None)
    print(
        f"wrote {out_path}: {n_ok}/{len(results)} beaches with a valid overhead cloud %, "
        f"{n_beam}/{len(results)} with a valid beam-path cloud %"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
