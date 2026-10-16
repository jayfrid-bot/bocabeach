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

IR CLOUD-TOP READ (event-time sky, day AND night) — 2026-10-15
-----------------------------------------------------------------
WHY: docs/benchmarks/sun-leadtime-2026-10-15/REPORT.md. The sunrise/sunset
color model needs to know whether the cloud on the horizon is a LOW deck (kills
the show) or a MID/HIGH deck (the canvas that lights up). The Clear Sky Mask
cannot tell the two apart, and the forecast cloud layers missed real cloud on
2026-10-14 and 10-15. This block adds a satellite OBSERVATION of cloud-top
height that works through twilight and at night.

PRODUCT CHOSEN: ABI-L2-ACHA2KMC (GOES-R Enterprise "ACHA" Cloud Top Height,
2 km, CONUS, ~every 5 min). Why it, and not the alternatives:
  - It is a retrieval from the IR bands (11, 12, 13.3 um with 8.5 um), so it
    needs no sunlight: valid at sunrise, sunset and overnight.
  - It is ~4 MB/granule (the same order as the ACMC mask we already pull; the
    10 km ACHAC is 0.3 MB but a 15 km box would hold only ~2 pixels; the full
    disk/mesoscale variants are larger or cover the wrong area).
  - Band 13 (CMIPC C13, 10.3 um, 3.7 MB) only gives a brightness temperature.
    Turning that into a height needs a clear-sky surface temperature and a
    lapse-rate guess, and it mislabels thin cirrus (too warm -> "low") and
    anything over a warm ocean at the horizon. ACHA already does that
    retrieval with NWP profiles, so we use its answer. (Band 13 stays the
    documented fallback if ACHA ever disappears; not implemented.)
  - ACHA only retrieves where the clear-sky mask says cloud, so cloudy-vs-clear
    comes from the SAME-scan ACMC granule (ACM 2/3 = cloudy). The two files are
    paired by their scan-start token; the newest scan present in both is used.

LAYER THRESHOLDS (cloud TOP height, from the HT variable, metres):
    low   top <  2000 m   (below ~800 hPa)
    mid   2000 <= top < 6000 m
    high  top >= 6000 m   (above ~ 450 hPa)
These are Open-Meteo's own definitions (cloud_cover_low = up to 2 km, mid =
2-6 km, high = above 6 km), so the satellite mix drops straight into the same
`CloudMix` the forecast fallback fills. They sit close to the ISCCP/WMO
pressure bands (low >680 hPa, mid 680-440, high <440 hPa). Source for the
retrieval itself: GOES-R ABI L2+ Cloud Top Height ATBD (ACHA, Heidinger et
al.); product variable HT (m), DQF flags 0 good_quality, 1 marginal_quality,
2 retrieval_attempted, 3 bad_quality, 4 opaque_retrieval (NOAA GOES-R PUG
Vol. 5, ACHA section). Mask values: PUG Vol. 5, "Clear Sky Mask".
Known ACHA limits (why the fields are an observation, not a truth): it reports
ONE top per pixel, so thin cirrus over a low deck reads "high" and the low deck
underneath is unseen; low clouds under a temperature inversion can be placed up
to ~1 km too high (so a deck near 2 km can land in "mid").

DQF is respected twice: a pixel is counted at all only when the ACM DQF is 0
(good) and the ACM value is 0-3; a cloudy pixel is given a layer only when its
ACHA DQF is 0 or 1 (good/marginal) and HT is not the fill value. A cloudy
pixel without a usable height is "unclassified" (counted in irCloudPct and
unclassifiedPct, in none of low/mid/high), and `classifiedPct` says what share
of the cloudy pixels got a layer. A beach with fewer than GOES_MIN_VALID_PIXELS
good mask pixels gets no IR read (null), never a guess.

PER-BEACH OUTPUT (beaches[slug].ir; the old fields are unchanged):
  lowPct / midPct / highPct   0-100 share of the beach box (GOES_IR_BOX_KM,
                              default 31 km square) whose cloud TOP is in that
                              band. Layers do not overlap, so low+mid+high <=
                              irCloudPct.
  irCloudPct                  0-100 share that is cloudy (ACM 2 or 3) at all.
  unclassifiedPct, classifiedPct, validPixels, totalPixels   quality.
  events.{sunrise,sunset}     only for events within IR_EVENT_WINDOW_MIN of the
                              IR granule, each with eventIso, azDeg (the sun's
                              azimuth AT THE EVENT, from the app's own NOAA
                              solver, not "now"), and the path reads below.
Feed top level: irGranuleStartIso (scan start of the pair used), irProduct.

HORIZON PATH (at the EVENT, not "now"): boxes (GOES_IR_BEAM_BOX_KM, default 15
km) are stepped out along the sun's azimuth at IR_PATH_DISTANCES_KM = 10, 20,
35, 55, 80, 110, 150 km. This replaces beam_cloud_pct()'s altitude/tan(elev)
offsets, which are meaningless at 0 deg (they send every slot past 35 km, and
the function returns null below 5 deg). At the event the sun is on the horizon,
so the ray from the beach rises only with distance: height above ground
z(d) = d*tan(elev) + d^2/(2*R_eff), elev = 0, R_eff = 4/3 earth radius (standard
refraction). A LOW pixel (top < 2 km, base assumed near the ground) blocks the
sun when its top reaches the ray, top >= z(d). Mid/high pixels are not counted
as blockers: their bases are unknown and a sun under a lifted deck is exactly
the lit-canvas case.
  beamLowPct      mean over the valid distances of the blocking-low share.
  beamMidHighPct  mean over the valid distances of the mid+high share (the
                  sunward canvas).
  antiMidHighPct  the same mid+high share, but along the OPPOSITE azimuth (the
                  afterglow sky; what an east-facing cam sees at sunset).
  beamSamples     how many of the 7 distances had enough good pixels. Fewer
                  than IR_MIN_PATH_SAMPLES -> the path fields are null.
The mean (not a max, not a product) is the same corridor estimator as
beam_cloud_pct(); see its note on why. No calibration data exist yet, so these
are a documented first cut.

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
  GOES_IR                    set to 0 to skip the IR cloud-top read (default 1)
  GOES_IR_BOX_KM             IR beach box side, km (default 31)
  GOES_IR_BEAM_BOX_KM        IR path box side, km (default 15)
  GOES_IR_MAX_LOOKBACK_HOURS how far back to look for an ACMC+ACHA pair (default 3)
  GOES_IR_ACM_KEY / GOES_IR_HEIGHT_KEY   force a specific ACMC/ACHA2KMC pair
                              (both required; reproduce a known sunrise/sunset)

RUN WINDOW
----------
`python scripts/goes_cloud.py --window-state` prints one word for the workflow
loop (.github/workflows/goes-cloud.yml), like cam_seaweed.py --window-state:
  day      now is inside ANY beach's window: sunrise - 75 min .. sunset + 45
           min, computed per beach for its local yesterday, today and tomorrow
           (beaches in the CONUS sector only; the zones overlap, so the union is
           ~20 h on a June day and ~15-16 h in December): the loop reads;
  dusk     within 20 minutes after any window's end: a loop that STARTS then
           still owes the one carry-forward read for the night;
  night    otherwise: the loop idles;
  unknown  the window could not be computed: the workflow uses a fixed clock
           window instead.
Sunrise/sunset come from scripts/sun_cam_check.py (a port of lib/sources/sun.ts).

`--cadence` prints `fast` while any beach is within 90 min of its sunrise or
sunset, else `slow`; the loop sleeps to the next 5-minute boundary when fast and
the next 15-minute boundary when slow.

COST PER CYCLE (measured 2026-10-15): the newest mask (~5.4 MB) for the old
fields, plus the newest mask+height pair (the height lands ~4.5 min after the
scan, so the pair is usually the previous scan: a second mask ~5.4 MB and the
height ~4 MB) = about 13 MB and ~7 s of runtime on most cycles (~9 MB when the
newest scan already has its height). NOAA Open Data egress is free; the cost is
runner time inside a loop that is already running. With 39 beaches over four
time zones some beach is within 90 min of an event ~13-14 h a day, so 5-min
cadence runs ~160 cycles and 15-min cadence ~15-35 more (the window is ~15-21 h):
about 2.2-2.5 GB and ~20-25 min of fetch time a day.
"""
from __future__ import annotations

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
from dataclasses import dataclass
from zoneinfo import ZoneInfo

import numpy as np

# h5py is imported inside the functions that open a granule, so the pure helpers
# (and --window-state, and the unit tests) need only numpy.

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
# Feed schema version. 2 = beamCloudPct/sunElevDeg; 3 = the per-beach `ir`
# block + irGranuleStartIso/irProduct (IR cloud-top read). Consumers can tell an
# old-format cached/stale feed apart from a new one.
FEED_VERSION = 3
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
    def from_h5(cls, f) -> "AbiNav":
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


# --- IR cloud-top read (ACHA 2 km) — see the module docstring ----------------
IR_ENABLED = os.environ.get("GOES_IR", "1") != "0"
HEIGHT_PRODUCT = "ABI-L2-ACHA2KMC"
IR_MAX_LOOKBACK_HOURS = int(os.environ.get("GOES_IR_MAX_LOOKBACK_HOURS", "3"))
IR_BOX_KM = float(os.environ.get("GOES_IR_BOX_KM", "31"))
IR_BEAM_BOX_KM = float(os.environ.get("GOES_IR_BEAM_BOX_KM", "15"))
IR_ACM_KEY_OVERRIDE = os.environ.get("GOES_IR_ACM_KEY")
IR_HEIGHT_KEY_OVERRIDE = os.environ.get("GOES_IR_HEIGHT_KEY")
# Cloud-top layer bands, metres (Open-Meteo's own low/mid/high definitions).
LOW_TOP_M = 2000.0
MID_TOP_M = 6000.0
# ACHA DQF values whose height is used: 0 good_quality, 1 marginal_quality.
HT_USABLE_DQF = (0, 1)
HT_FILL = 65535  # HT valid_range is 0..65530; 65535 is the fill value
# Distances (km) stepped along the sun's (or anti-sun) azimuth at the event.
IR_PATH_DISTANCES_KM = (10.0, 20.0, 35.0, 55.0, 80.0, 110.0, 150.0)
IR_MIN_PATH_SAMPLES = 3
# The sun at the event: on the horizon (apparent). The ray rises only with
# distance (and earth curvature), see ray_height_m().
EVENT_SUN_ELEV_DEG = 0.0
# 4/3 of the earth radius: the standard-refraction "effective" radius.
EFFECTIVE_EARTH_RADIUS_KM = 8495.0
# Only events within this many minutes of the IR granule are published; the app
# uses an IR read only within 60 min of its event.
IR_EVENT_WINDOW_MIN = 120
DEFAULT_TZ_NAME = "America/New_York"


@dataclass
class BoxCounts:
    """Pixel counts for one box on the IR grid (all DQF-gated)."""

    total: int  # pixels in the box
    valid: int  # ACM DQF 0 and ACM 0-3
    cloudy: int  # valid and ACM 2 (probably cloudy) or 3 (cloudy)
    low: int  # cloudy, usable ACHA height, top < LOW_TOP_M
    mid: int
    high: int  # top >= MID_TOP_M
    unclassified: int  # cloudy, but no usable ACHA height
    blocking_low: int = 0  # low pixels whose top reaches the ray (path boxes only)


class IrGrid:
    """The ACMC mask + ACHA2KMC height of ONE scan, on the shared 2 km ABI
    fixed grid, with lat/lon -> pixel navigation. Plain arrays in, so the unit
    tests can build one from numpy without any granule file."""

    def __init__(self, nav, x_off, x_scale, y_off, y_scale, acm, acm_dqf, ht_raw, ht_dqf, ht_scale, ht_offset=0.0):
        self.nav = nav
        self.x_off, self.x_scale = x_off, x_scale
        self.y_off, self.y_scale = y_off, y_scale
        self.acm, self.acm_dqf = acm, acm_dqf
        self.ht_raw, self.ht_dqf = ht_raw, ht_dqf
        self.ht_scale, self.ht_offset = ht_scale, ht_offset
        self.n_rows, self.n_cols = acm.shape

    def pixel(self, lat: float, lon: float) -> tuple[int, int] | None:
        """(row, col) of the pixel nearest (lat, lon), or None when the point is
        off the CONUS grid or the visible disk."""
        try:
            x, y = self.nav.forward(lat, lon)
        except (ValueError, ZeroDivisionError):
            return None
        col_f = (x - self.x_off) / self.x_scale
        row_f = (y - self.y_off) / self.y_scale
        if not (-0.5 <= col_f < self.n_cols - 0.5 and -0.5 <= row_f < self.n_rows - 0.5):
            return None
        return int(round(row_f)), int(round(col_f))

    def box(self, lat: float, lon: float, radius_px: int, ray_height_m: float | None = None) -> BoxCounts | None:
        """Counts for the (2*radius_px+1)-pixel box around (lat, lon). With
        `ray_height_m` (path boxes), also counts the low pixels tall enough to
        reach the sun's ray there."""
        rc = self.pixel(lat, lon)
        if rc is None:
            return None
        row, col = rc
        r0, r1 = max(0, row - radius_px), min(self.n_rows, row + radius_px + 1)
        c0, c1 = max(0, col - radius_px), min(self.n_cols, col + radius_px + 1)
        acm = self.acm[r0:r1, c0:c1]
        valid = (self.acm_dqf[r0:r1, c0:c1] == 0) & (acm <= 3)
        cloudy = valid & (acm >= 2)
        ht_raw = self.ht_raw[r0:r1, c0:c1]
        ht_ok = np.isin(self.ht_dqf[r0:r1, c0:c1], HT_USABLE_DQF) & (ht_raw != HT_FILL)
        classified = cloudy & ht_ok
        ht_m = ht_raw.astype("float64") * self.ht_scale + self.ht_offset
        low = classified & (ht_m < LOW_TOP_M)
        mid = classified & (ht_m >= LOW_TOP_M) & (ht_m < MID_TOP_M)
        high = classified & (ht_m >= MID_TOP_M)
        blocking = int((low & (ht_m >= ray_height_m)).sum()) if ray_height_m is not None else 0
        return BoxCounts(
            total=int(acm.size),
            valid=int(valid.sum()),
            cloudy=int(cloudy.sum()),
            low=int(low.sum()),
            mid=int(mid.sum()),
            high=int(high.sum()),
            unclassified=int((cloudy & ~ht_ok).sum()),
            blocking_low=blocking,
        )


def _pct(n: int, d: int) -> float:
    return round(100.0 * n / d, 1)


def overhead_read(c: BoxCounts | None, min_valid: int) -> dict | None:
    """Layer shares for the beach box, or None with too few good pixels."""
    if c is None or c.valid < min_valid:
        return None
    return {
        "lowPct": _pct(c.low, c.valid),
        "midPct": _pct(c.mid, c.valid),
        "highPct": _pct(c.high, c.valid),
        "irCloudPct": _pct(c.cloudy, c.valid),
        "unclassifiedPct": _pct(c.unclassified, c.valid),
        # Share of the cloudy pixels that got a layer; null when there is no cloud.
        "classifiedPct": _pct(c.low + c.mid + c.high, c.cloudy) if c.cloudy else None,
        "validPixels": c.valid,
        "totalPixels": c.total,
    }


def ray_height_m(d_km: float, elev_deg: float = EVENT_SUN_ELEV_DEG) -> float:
    """Height (m) above the ground of a straight sun ray leaving the beach at
    apparent elevation `elev_deg`, at ground distance `d_km` toward the sun:
    d*tan(elev) + d^2/(2*R_eff). At elev 0 it is 0.1 km at 10 km, 0.7 km at
    110 km, 1.3 km at 150 km. Never below 0."""
    h_km = d_km * math.tan(math.radians(elev_deg)) + d_km**2 / (2.0 * EFFECTIVE_EARTH_RADIUS_KM)
    return max(0.0, h_km * 1000.0)


def path_read(
    grid: IrGrid,
    lat: float,
    lon: float,
    az_deg: float,
    radius_px: int,
    min_valid: int,
    elev_deg: float = EVENT_SUN_ELEV_DEG,
) -> dict:
    """Cloud along the azimuth `az_deg` from (lat, lon): the mean blocking-low
    share and the mean mid+high share over the distances that had enough good
    pixels. All three values are None when fewer than IR_MIN_PATH_SAMPLES
    distances had a read (off-grid, or masked)."""
    blocking: list[float] = []
    midhigh: list[float] = []
    for d_km in IR_PATH_DISTANCES_KM:
        olat, olon = offset_latlon(lat, lon, d_km, az_deg)
        c = grid.box(olat, olon, radius_px, ray_height_m=ray_height_m(d_km, elev_deg))
        if c is None or c.valid < min_valid:
            continue
        blocking.append(100.0 * c.blocking_low / c.valid)
        midhigh.append(100.0 * (c.mid + c.high) / c.valid)
    if len(blocking) < IR_MIN_PATH_SAMPLES:
        return {"beamLowPct": None, "beamMidHighPct": None, "beamSamples": len(blocking)}
    return {
        "beamLowPct": round(float(np.mean(blocking)), 1),
        "beamMidHighPct": round(float(np.mean(midhigh)), 1),
        "beamSamples": len(blocking),
    }


def _sun_times_for(lat: float, lon: float, day: dt.date) -> dict:
    """sun_cam_check.sun_times(), imported on demand (it sits next to this file)."""
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import sun_cam_check  # noqa: PLC0415 — lazy: only the IR and run-window code need it

    return sun_cam_check.sun_times(lat, lon, day)


def sun_events_near(
    lat: float, lon: float, tz_name: str, ref: dt.datetime, window_min: float = IR_EVENT_WINDOW_MIN
) -> dict[str, dict]:
    """{'sunrise'|'sunset': {eventIso, azDeg}} for the sunrise and sunset closest
    to `ref` (UTC), each kept only if within `window_min` minutes of it. Days are
    the beach-local calendar days around `ref`, as the app calls them. azDeg is
    the sun's azimuth AT THE EVENT."""
    try:
        zone = ZoneInfo(tz_name or DEFAULT_TZ_NAME)
    except Exception:  # noqa: BLE001 — unknown zone name: use the default
        zone = ZoneInfo(DEFAULT_TZ_NAME)
    local_day = ref.astimezone(zone).date()
    best: dict[str, tuple[float, dict]] = {}
    for offset in (-1, 0, 1):
        t = _sun_times_for(lat, lon, local_day + dt.timedelta(days=offset))
        for kind in ("sunrise", "sunset"):
            when, az = t.get(kind), t.get(f"{kind}_az")
            if when is None or az is None:
                continue
            gap_min = abs((when - ref).total_seconds()) / 60.0
            if gap_min <= window_min and (kind not in best or gap_min < best[kind][0]):
                best[kind] = (
                    gap_min,
                    {"eventIso": when.replace(microsecond=0).isoformat().replace("+00:00", "Z"), "azDeg": round(az, 1)},
                )
    return {k: v[1] for k, v in best.items()}


def ir_beach_read(
    grid: IrGrid, b: dict, granule_start: dt.datetime, min_valid: int, box_px: int, beam_px: int
) -> dict | None:
    """The `ir` block for one beach: overhead layer shares plus, for each sun
    event near the granule, the path reads toward and away from the sun."""
    lat, lon = b["lat"], b["lon"]
    read = overhead_read(grid.box(lat, lon, box_px), min_valid)
    if read is None:
        return None
    events: dict[str, dict] = {}
    for kind, ev in sun_events_near(lat, lon, b.get("timezone") or DEFAULT_TZ_NAME, granule_start).items():
        toward = path_read(grid, lat, lon, ev["azDeg"], beam_px, min_valid)
        away = path_read(grid, lat, lon, (ev["azDeg"] + 180.0) % 360.0, beam_px, min_valid)
        events[kind] = {
            **ev,
            "beamLowPct": toward["beamLowPct"],
            "beamMidHighPct": toward["beamMidHighPct"],
            "antiMidHighPct": away["beamMidHighPct"],
            "beamSamples": toward["beamSamples"],
        }
    read["events"] = events
    return read


def find_ir_pair() -> tuple[dt.datetime, str, str] | None:
    """The newest scan present in BOTH the ACMC mask and the ACHA2KMC height
    listings, as (scan_start, acm_key, height_key). Walks back hour by hour (the
    height product lands a few minutes after the mask, so the newest mask scan
    often has no height yet)."""
    now = dt.datetime.now(dt.timezone.utc)
    t = now.replace(minute=0, second=0, microsecond=0)
    for i in range(IR_MAX_LOOKBACK_HOURS + 1):
        hour = t - dt.timedelta(hours=i)
        found: dict[str, dict[dt.datetime, str]] = {}
        for product in (PRODUCT, HEIGHT_PRODUCT):
            prefix = f"{product}/{hour.year}/{int(hour.strftime('%j')):03d}/{hour.hour:02d}/"
            try:
                keys = list_keys(prefix)
            except Exception as e:  # noqa: BLE001
                print(f"warn: list {prefix}: {e}", file=sys.stderr)
                keys = []
            found[product] = {st: k for k in keys if (st := start_time(k)) is not None}
        pair = newest_common_scan(found[PRODUCT], found[HEIGHT_PRODUCT])
        if pair is not None:
            return pair
    return None


def newest_common_scan(
    masks: dict[dt.datetime, str], heights: dict[dt.datetime, str]
) -> tuple[dt.datetime, str, str] | None:
    """(scan_start, mask_key, height_key) for the newest scan start that both
    {scan_start: key} maps hold, or None."""
    common = sorted(set(masks) & set(heights))
    if not common:
        return None
    st = common[-1]
    return st, masks[st], heights[st]


def load_ir_grid(acm_buf: bytes, height_buf: bytes) -> IrGrid:
    """Open an ACMC and an ACHA2KMC granule and build the IrGrid. Raises if the
    two are not on the same grid."""
    import h5py  # noqa: PLC0415

    def _scalar(a) -> float:
        return float(np.asarray(a).ravel()[0])

    with tempfile.NamedTemporaryFile(suffix=".nc") as t_acm, tempfile.NamedTemporaryFile(suffix=".nc") as t_ht:
        t_acm.write(acm_buf)
        t_acm.flush()
        t_ht.write(height_buf)
        t_ht.flush()
        with h5py.File(t_acm.name, "r") as fa, h5py.File(t_ht.name, "r") as fh:
            nav = AbiNav.from_h5(fa)
            ax, ay = fa["x"].attrs, fa["y"].attrs
            hx, hy = fh["x"].attrs, fh["y"].attrs
            x_off, x_scale = _scalar(ax["add_offset"]), _scalar(ax["scale_factor"])
            y_off, y_scale = _scalar(ay["add_offset"]), _scalar(ay["scale_factor"])
            same_grid = (
                fa["ACM"].shape == fh["HT"].shape
                and abs(x_off - _scalar(hx["add_offset"])) < 1e-9
                and abs(x_scale - _scalar(hx["scale_factor"])) < 1e-12
                and abs(y_off - _scalar(hy["add_offset"])) < 1e-9
                and abs(y_scale - _scalar(hy["scale_factor"])) < 1e-12
            )
            if not same_grid:
                raise ValueError("ACMC and ACHA2KMC granules are not on the same grid")
            return IrGrid(
                nav,
                x_off,
                x_scale,
                y_off,
                y_scale,
                acm=fa["ACM"][:],
                acm_dqf=fa["DQF"][:],
                ht_raw=fh["HT"][:],
                ht_dqf=fh["DQF"][:],
                ht_scale=_scalar(fh["HT"].attrs["scale_factor"]),
                ht_offset=_scalar(fh["HT"].attrs["add_offset"]),
            )


# --- run window (which ticks the workflow loop spends) -----------------------
RUN_WINDOW_BEFORE_MIN = 75
RUN_WINDOW_AFTER_MIN = 45
RUN_DUSK_GRACE_MIN = 20
# The GOES-East CONUS sector, roughly. A beach outside it (Hawaii) never gets a
# read, so it must not stretch the run window.
CONUS_LAT = (24.0, 50.0)
CONUS_LON = (-126.0, -66.0)


def in_conus_sector(lat: float, lon: float) -> bool:
    return CONUS_LAT[0] <= lat <= CONUS_LAT[1] and CONUS_LON[0] <= lon <= CONUS_LON[1]


def beach_windows(b: dict, now: dt.datetime) -> list[tuple[dt.datetime, dt.datetime]]:
    """One beach's reading windows (sunrise - RUN_WINDOW_BEFORE_MIN to sunset +
    RUN_WINDOW_AFTER_MIN) for its local YESTERDAY, TODAY and TOMORROW. Three days
    because the window of one local date can straddle UTC midnight, and because
    beaches in different zones sit on different local dates at the same instant:
    pairing one beach's tomorrow sunset with another's today sunrise (the first
    version of this function) read "day" through most of the night. Empty for a
    beach outside the CONUS sector, without coordinates, or with no sunrise or
    sunset (polar)."""
    try:
        lat, lon = float(b["lat"]), float(b["lon"])
        if not in_conus_sector(lat, lon):
            return []
        try:
            zone = ZoneInfo(b.get("timezone") or DEFAULT_TZ_NAME)
        except Exception:  # noqa: BLE001
            zone = ZoneInfo(DEFAULT_TZ_NAME)
        local_day = now.astimezone(zone).date()
        out = []
        for offset in (-1, 0, 1):
            t = _sun_times_for(lat, lon, local_day + dt.timedelta(days=offset))
            if t.get("sunrise") and t.get("sunset"):
                out.append(
                    (
                        t["sunrise"] - dt.timedelta(minutes=RUN_WINDOW_BEFORE_MIN),
                        t["sunset"] + dt.timedelta(minutes=RUN_WINDOW_AFTER_MIN),
                    )
                )
        return out
    except Exception as e:  # noqa: BLE001 — one odd beach must not blank the window
        print(f"  warn run window [{b.get('slug')}]: {e}", file=sys.stderr)
        return []


def run_windows(beaches: list[dict], now: dt.datetime) -> list[tuple[dt.datetime, dt.datetime]]:
    """Every beach's windows around `now` (see beach_windows), merged where they
    overlap, sorted. The loop reads while `now` is inside ANY of them."""
    now_utc = now if now.tzinfo else now.replace(tzinfo=dt.timezone.utc)
    spans = sorted(w for b in beaches for w in beach_windows(b, now_utc))
    merged: list[tuple[dt.datetime, dt.datetime]] = []
    for start, end in spans:
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def window_state(now: dt.datetime | None = None, beaches: list[dict] | None = None) -> str:
    """'day' (now is inside any beach's window), 'dusk' (within RUN_DUSK_GRACE_MIN
    after any window's end), 'night', or 'unknown' (no beach gives a window)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    windows = run_windows(load_beaches() if beaches is None else beaches, now)
    if not windows:
        return "unknown"
    if any(start <= now < end for start, end in windows):
        return "day"
    if any(end <= now < end + dt.timedelta(minutes=RUN_DUSK_GRACE_MIN) for _start, end in windows):
        return "dusk"
    return "night"


# A beach "near a sun event" for cadence: its sunrise or sunset is within this
# many minutes either side of now. The read goes to FAST_CADENCE_S then.
EVENT_NEAR_MIN = 90
FAST_CADENCE_S = 300
SLOW_CADENCE_S = 900


def cadence_state(now: dt.datetime | None = None, beaches: list[dict] | None = None) -> str:
    """'fast' while any CONUS beach is within EVENT_NEAR_MIN minutes of its sunrise
    or sunset, else 'slow'. The height product lands ~4.5 min after a scan and the
    app accepts an IR read up to 35 min old, so reads every 5 min near an event
    keep the number the model sees from jumping between cycles."""
    now = now or dt.datetime.now(dt.timezone.utc)
    for b in load_beaches() if beaches is None else beaches:
        try:
            lat, lon = float(b["lat"]), float(b["lon"])
            if in_conus_sector(lat, lon) and sun_events_near(lat, lon, b.get("timezone") or DEFAULT_TZ_NAME, now, EVENT_NEAR_MIN):
                return "fast"
        except Exception as e:  # noqa: BLE001
            print(f"  warn cadence [{b.get('slug')}]: {e}", file=sys.stderr)
    return "slow"


def cadence_main() -> int:
    """`--cadence`: print 'fast' or 'slow' (the workflow's sleep step reads it).
    Always exits 0; the workflow treats anything but 'fast' as slow."""
    try:
        print(cadence_state())
    except Exception as e:  # noqa: BLE001
        print(f"  warn cadence: {e}", file=sys.stderr)
        print("slow")
    return 0


def window_state_main() -> int:
    """`--window-state`: the state on stdout (the workflow reads the last line),
    the window on stderr for the log. Always exits 0."""
    try:
        now = dt.datetime.now(dt.timezone.utc)
        beaches = load_beaches()
        windows = run_windows(beaches, now)
        state = window_state(now, beaches)
        span = ", ".join(f"{a.strftime('%d %H:%MZ')}-{b.strftime('%d %H:%MZ')}" for a, b in windows)
        print(f"run windows {span} -> {state}", file=sys.stderr)
        print(state)
    except Exception as e:  # noqa: BLE001
        print(f"  warn run window: {e}", file=sys.stderr)
        print("unknown")
    return 0


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
            tz_m = re.search(r'\btimezone:\s*"([^"]+)"', chunk)
            if lat_m and lon_m and slug not in seen:
                beaches.append(
                    {
                        "slug": slug,
                        "lat": float(lat_m.group(1)),
                        "lon": float(lon_m.group(1)),
                        "timezone": tz_m.group(1) if tz_m else DEFAULT_TZ_NAME,
                    }
                )
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
                beaches.append(
                    {"slug": slug, "lat": float(lat), "lon": float(lon), "timezone": loc.get("timezone") or DEFAULT_TZ_NAME}
                )
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

    import h5py  # noqa: PLC0415 — lazy, see the import note at the top

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

    # IR cloud-top read (ACHA height + same-scan mask). Never fails the cycle:
    # the old Clear Sky Mask fields above are published either way.
    ir_start = None
    if IR_ENABLED:
        try:
            ir_start = add_ir_reads(beaches, results, key, buf)
        except Exception as e:  # noqa: BLE001
            print(f"warn: IR cloud-top read failed, publishing without it: {e}", file=sys.stderr)
            ir_start = None
            for r in results.values():
                r.pop("ir", None)

    out = {
        "version": FEED_VERSION,
        "generatedAt": now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "granuleStartIso": granule_start.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "satellite": SATELLITE,
        "irGranuleStartIso": ir_start.replace(microsecond=0).isoformat().replace("+00:00", "Z") if ir_start else None,
        "irProduct": HEIGHT_PRODUCT if ir_start else None,
        "beaches": results,
    }
    out_path = OUT if os.path.isabs(OUT) else os.path.join(REPO_ROOT, OUT)
    with open(out_path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    n_ok = sum(1 for v in results.values() if v["cloudPct"] is not None)
    n_beam = sum(1 for v in results.values() if v["beamCloudPct"] is not None)
    n_ir = sum(1 for v in results.values() if v.get("ir"))
    print(
        f"wrote {out_path}: {n_ok}/{len(results)} beaches with a valid overhead cloud %, "
        f"{n_beam}/{len(results)} with a valid beam-path cloud %, "
        f"{n_ir}/{len(results)} with an IR cloud-top read"
    )
    return 0


def add_ir_reads(beaches: list[dict], results: dict[str, dict], acm_key: str, acm_buf: bytes) -> dt.datetime | None:
    """Attach `ir` to each beach in `results`. Finds the newest ACMC+ACHA2KMC
    scan pair (or the GOES_IR_*_KEY override), reuses the already-downloaded
    mask when it is the same granule, and returns the pair's scan start (None
    when no pair exists)."""
    if IR_ACM_KEY_OVERRIDE and IR_HEIGHT_KEY_OVERRIDE:
        st = start_time(IR_ACM_KEY_OVERRIDE)
        if st is None:
            print("warn: GOES_IR_ACM_KEY doesn't match the granule-key pattern; skipping IR", file=sys.stderr)
            return None
        pair: tuple[dt.datetime, str, str] | None = (st, IR_ACM_KEY_OVERRIDE, IR_HEIGHT_KEY_OVERRIDE)
        print("using GOES_IR_ACM_KEY / GOES_IR_HEIGHT_KEY override")
    else:
        pair = find_ir_pair()
    if pair is None:
        print(f"warn: no ACMC + {HEIGHT_PRODUCT} scan pair within {IR_MAX_LOOKBACK_HOURS}h; no IR read", file=sys.stderr)
        return None
    ir_start, ir_acm_key, ir_height_key = pair
    age_min = (dt.datetime.now(dt.timezone.utc) - ir_start).total_seconds() / 60
    print(f"IR scan: {ir_height_key} (start {ir_start.isoformat()}, {age_min:.1f} min old)")
    ir_acm_buf = acm_buf if ir_acm_key == acm_key else _get(f"{BUCKET}/{ir_acm_key}", timeout=90)
    height_buf = _get(f"{BUCKET}/{ir_height_key}", timeout=90)
    print(f"downloaded IR height {len(height_buf) / 1e6:.2f} MB" + ("" if ir_acm_key == acm_key else f" + mask {len(ir_acm_buf) / 1e6:.2f} MB"))
    grid = load_ir_grid(ir_acm_buf, height_buf)
    box_px = max(1, round((IR_BOX_KM / PIXEL_KM - 1) / 2))
    beam_px = max(1, round((IR_BEAM_BOX_KM / PIXEL_KM - 1) / 2))
    n = 0
    for b in beaches:
        read = ir_beach_read(grid, b, ir_start, MIN_VALID_PIXELS, box_px, beam_px)
        if read is not None and b["slug"] in results:
            results[b["slug"]]["ir"] = read
            n += 1
    print(f"IR read for {n}/{len(beaches)} beaches")
    return ir_start


if __name__ == "__main__":
    if "--window-state" in sys.argv[1:]:
        raise SystemExit(window_state_main())
    if "--cadence" in sys.argv[1:]:
        raise SystemExit(cadence_main())
    raise SystemExit(main())
