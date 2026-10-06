#!/usr/bin/env python3
"""Sun-cam check: an automatic "what actually happened" score for every
sunrise and sunset (runs on the owner's Mac, every 30 min via launchd -- see
scripts/com.isitbeachday.suncam.plist). Full write-up: docs/SUN_CAM_CHECK.md.

WHY: lib/sunQuality.ts predicts how colorful each sunrise/sunset will be, and
the hourly archiver logs every prediction to D1 (`sun_event_predictions`,
migrations/0013). To calibrate the model we need ground truth. On 2026-10-06
the model said "Good" for a spectacular sunrise and nothing recorded what the
sky really did. This script looks at the sky and records a 0-100 score.

HOW (the DVR trick): the cams are 24/7 YouTube livestreams, and YouTube keeps
about 4 hours of DVR for each one. `yt-dlp -J` gives the HLS manifest; its
playlist lists ~2,880 five-second segments, each timed by an
#EXT-X-PROGRAM-DATE-TIME tag plus the #EXTINF durations. For every sample time
we fetch the segment that contains it and pull one frame with ffmpeg. So the
Mac does NOT need to be awake at sunrise: any run within ~3.5 h after the event
can rebuild it. (YouTube blocks datacenter IPs, so this has to run at home.)
Gotchas learned the hard way: segment URLs go stale ~30 s after the manifest is
issued (the script re-issues it), a segment can 403 for good if it predates a
stream restart (the script skips it), and ffmpeg's input-side -ss finds nothing
in these segments (the script seeks on the output side).

Each run, for every cam in config/sun-cams.json and every beach it observes:
  1. compute today's sunrise/sunset (NOAA solar algorithm, same constants as
     lib/sources/sun.ts, so event times match the app's own predictions);
  2. pick the events that ended 25 min to 3.5 h ago and are not in the state
     file yet;
  3. grab frames every 2.5 min from event-35 min to event+25 min (25 frames);
  4. score each frame (see "SCORING" below), take the PEAK frame as the event
     score, keep the whole series;
  5. save the frames under ~/Projects/bocabeach-sunframes/<local-date>/<event>/<cam>/
     (peak at full quality, the rest at low JPEG quality; that folder is backed
     up hourly) and POST the result to /api/sun-observations.
Sunrise views are "solar" (the cam looks straight at the sun); sunset views are
"antisolar" (the cam looks away from it and sees clouds catching the afterglow),
so calibration can treat them apart.

SCORING (deterministic; bump SUN_CAM_SCORE_VERSION whenever any of this changes):
  Work on the sky region of each frame (config sky_regions), shrunk 4x by box
  averaging. Per pixel (S, V in 0..1, H in degrees):
    * near-black   : V < 0.18                  -> ignored (no information)
    * sun glare    : V > 0.92 and S < 0.25     -> ignored (the disc and its blown-out halo)
    * warm         : (H <= 50 or H >= 300) and S >= 0.30 and V >= 0.35
                     (red, orange, gold, pink, magenta)
  valid_frac  = valid pixels / region pixels
  warm_frac   = warm pixels / valid pixels
  colorfulness = Hasler-Suesstrunk over valid pixels:
                 rg = R-G, yb = 0.5(R+G)-B,
                 sqrt(std(rg)^2 + std(yb)^2) + 0.3 * sqrt(mean(rg)^2 + mean(yb)^2)
  warm_sat    = mean saturation of the warm pixels (0 when there are none)
  Terms, each clamped to 0..1:
    W = warm_frac / 0.30
    K = (colorfulness - 35) / (70 - 35)
    P = (warm_sat - 0.25) / (0.55 - 0.25)  * min(1, warm_frac / 0.05)
  confidence C = min(1, valid_frac / 0.30)   (a frame that is mostly dark or
                                              mostly glare says little)
  score = 100 * C * (0.55 W + 0.20 K + 0.25 P)
  Calibration anchors: the 2026-10-06 Elbo Room sunrise peak (~07:05 local,
  a mid/high deck lit pink and red across the top) scores ~95; plain blue sky
  and white-sun daytime frames score below ~15.
  Event score = max over the window's frames (the PEAK frame).

REQUIREMENTS: Python 3.9+, Pillow (`pip install pillow`), and yt-dlp + ffmpeg on
PATH (yt-dlp needs node as its JS runtime; this script adds the same PATH
entries the courier does). No other third-party packages.

USAGE:
  python3 scripts/sun_cam_check.py                  # normal run (what launchd does)
  python3 scripts/sun_cam_check.py --dry-run        # score, print, upload/save nothing
  python3 scripts/sun_cam_check.py --force          # ignore the state file and the age window
  python3 scripts/sun_cam_check.py --from-dir DIR   # score saved frames (tests / backfills)
      DIR is <...>/<local-date>/<sunrise|sunset>/<cam-id>/ holding HHMMZ.jpg or
      HHMMSSZ.jpg frames; date, event and cam come from the path (override with
      --date/--event/--cam/--slug). Add --dry-run to print without uploading.
  Other flags: --cams a,b  --now ISO  --json  --verbose

INSTALL the launchd job (NOT done by the change that added this file):
  1. pip install pillow; make sure yt-dlp and ffmpeg are installed (the courier
     already needs them).
  2. The upload needs the same token file the camera courier uses. It holds the
     INGEST_TOKEN value, no trailing newline (see scripts/cam_courier_local.sh):
       mkdir -p "$HOME/.config/isitbeachday"
       printf '%s' '<the INGEST_TOKEN value>' > "$HOME/.config/isitbeachday/courier.token"
       chmod 600 "$HOME/.config/isitbeachday/courier.token"
     The APP worker (the one that serves /api/sun-observations) needs a secret
     with that same name and value too: `wrangler secret put INGEST_TOKEN`.
  3. Install the job (renders __HOME__ in the plist, then loads it):
       sed "s#__HOME__#$HOME#g" scripts/com.isitbeachday.suncam.plist \\
         > "$HOME/Library/LaunchAgents/com.isitbeachday.suncam.plist"
       launchctl bootstrap gui/$(id -u) \\
         "$HOME/Library/LaunchAgents/com.isitbeachday.suncam.plist"
  4. Try it once by hand first: python3 scripts/sun_cam_check.py --dry-run
Logs land at ~/Library/Logs/sun-cam-check.log. State lives at
~/Library/Application Support/isitbeachday/sun-cam-state.json.
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None  # type: ignore

# launchd does not load the user's shell profile, so find yt-dlp (needs node),
# ffmpeg and friends explicitly -- same entries as scripts/cam_courier_local.sh.
os.environ["PATH"] = os.pathsep.join(
    [str(Path.home() / ".hermes/node/bin"), "/opt/homebrew/bin", "/usr/local/bin", os.environ.get("PATH", "")]
)

SUN_CAM_SCORE_VERSION = "2026-10-06.1"

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "config" / "sun-cams.json"
API_BASE = os.environ.get("SUNCAM_API_BASE", "https://app.isitbeachday.com")
TOKEN_FILE = Path(os.environ.get("SUNCAM_TOKEN_FILE", str(Path.home() / ".config/isitbeachday/courier.token")))
STATE_FILE = Path(
    os.environ.get(
        "SUNCAM_STATE_FILE",
        str(Path.home() / "Library/Application Support/isitbeachday/sun-cam-state.json"),
    )
)
FRAMES_ROOT = Path(os.environ.get("SUNCAM_FRAMES_ROOT", str(Path.home() / "Projects/bocabeach-sunframes")))

# --- Event window ---------------------------------------------------------
WINDOW_BEFORE_MIN = 35
WINDOW_AFTER_MIN = 25
STEP_SECONDS = 150  # 2.5 min
MIN_AGE_MIN = 25  # the window must have closed
MAX_AGE_MIN = 210  # 3.5 h: YouTube's DVR holds ~4 h, and the window opens 35 min before the event
DVR_HOURS = 4.0  # YouTube's live DVR depth
MIN_FRAME_COVERAGE = 0.6  # share of the planned frames that must be recovered
HLS_PREFERRED_HEIGHT = 720

# --- Scoring constants (see the SCORING block in the docstring) -----------
DARK_V = 0.18
GLARE_V = 0.92
GLARE_S = 0.25
WARM_HUE_MAX = 50.0
WARM_HUE_MIN = 300.0
WARM_S_MIN = 0.30
WARM_V_MIN = 0.35
W_FULL = 0.30
K_LO, K_HI = 35.0, 70.0
P_LO, P_HI = 0.25, 0.55
P_MIN_WARM = 0.05
C_FULL_VALID = 0.30
WEIGHT_W, WEIGHT_K, WEIGHT_P = 0.55, 0.20, 0.25
REDUCE_FACTOR = 4

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"


def log(msg: str) -> None:
    print(f"{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} {msg}", flush=True)


# ===========================================================================
# Solar times -- NOAA solar position algorithm, ported from lib/sources/sun.ts
# so event times here equal the ones the app's predictions are keyed on.
# ===========================================================================

ZENITH_SUNRISE = 90.833  # upper limb + standard atmospheric refraction


def _mod360(x: float) -> float:
    return ((x % 360.0) + 360.0) % 360.0


def _julian_day_0h(year: int, month: int, day: int) -> float:
    y, m = year, month
    if m <= 2:
        y -= 1
        m += 12
    a = math.floor(y / 100)
    b = 2 - a + math.floor(a / 4)
    return math.floor(365.25 * (y + 4716)) + math.floor(30.6001 * (m + 1)) + day + b - 1524.5


def _solar_params(jd0: float, lon: float) -> Tuple[float, float]:
    """(declination in degrees, equation of time in minutes)."""
    t = (jd0 + (720 - 4 * lon) / 1440 - 2451545.0) / 36525
    l0 = _mod360(280.46646 + t * (36000.76983 + t * 0.0003032))
    m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
    mr = math.radians(m)
    e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
    c = (
        math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t))
        + math.sin(2 * mr) * (0.019993 - 0.000101 * t)
        + math.sin(3 * mr) * 0.000289
    )
    app_long = l0 + c - 0.00569 - 0.00478 * math.sin(math.radians(125.04 - 1934.136 * t))
    mean_obliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60
    obliq_corr = mean_obliq + 0.00256 * math.cos(math.radians(125.04 - 1934.136 * t))
    declin = math.degrees(math.asin(math.sin(math.radians(obliq_corr)) * math.sin(math.radians(app_long))))
    var_y = math.tan(math.radians(obliq_corr / 2)) ** 2
    eq_time = 4 * math.degrees(
        var_y * math.sin(2 * math.radians(l0))
        - 2 * e * math.sin(mr)
        + 4 * e * var_y * math.sin(mr) * math.cos(2 * math.radians(l0))
        - 0.5 * var_y * var_y * math.sin(4 * math.radians(l0))
        - 1.25 * e * e * math.sin(2 * mr)
    )
    return declin, eq_time


def _hour_angle(lat: float, declin: float, zenith: float) -> Optional[float]:
    lat_r, dec_r = math.radians(lat), math.radians(declin)
    cos_h = (math.cos(math.radians(zenith)) - math.sin(dec_r) * math.sin(lat_r)) / (math.cos(dec_r) * math.cos(lat_r))
    if cos_h > 1 or cos_h < -1:
        return None
    return math.degrees(math.acos(cos_h))


def sun_times(lat: float, lon: float, d: date) -> Dict[str, Any]:
    """Sunrise and sunset (UTC instants) for the calendar day `d` at a
    coordinate, plus the sun's azimuth at each event (degrees, clockwise from
    north). `d` is the beach-LOCAL calendar day, exactly as the app calls it."""
    jd0 = _julian_day_0h(d.year, d.month, d.day)
    declin, eq_time = _solar_params(jd0, lon)
    noon_utc_min = 720 - 4 * lon - eq_time
    midnight = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)

    def at(minutes: float) -> datetime:
        return midnight + timedelta(milliseconds=int(math.floor(minutes * 60000 + 0.5)))

    ha = _hour_angle(lat, declin, ZENITH_SUNRISE)
    if ha is None:
        return {"sunrise": None, "sunset": None, "sunrise_az": None, "sunset_az": None}
    cos_az = math.sin(math.radians(declin)) / math.cos(math.radians(lat))
    cos_az = max(-1.0, min(1.0, cos_az))
    rise_az = math.degrees(math.acos(cos_az))
    return {
        "sunrise": at(noon_utc_min - 4 * ha),
        "sunset": at(noon_utc_min + 4 * ha),
        "sunrise_az": rise_az,
        "sunset_az": 360.0 - rise_az,
    }


def view_for(facing_deg: float, sun_az: Optional[float]) -> str:
    """'solar' when the cam looks within 60 degrees of where the sun is at the
    event, else 'antisolar'. East-facing cams: sunrise = solar, sunset = antisolar."""
    if sun_az is None:
        return "antisolar"
    diff = abs((facing_deg - sun_az + 180.0) % 360.0 - 180.0)
    return "solar" if diff <= 60.0 else "antisolar"


# ===========================================================================
# Frame scoring
# ===========================================================================


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def combine_score(warm_frac: float, colorfulness: float, warm_sat: float, valid_frac: float) -> float:
    """The documented 0-100 formula (see the module docstring)."""
    w = _clamp01(warm_frac / W_FULL)
    k = _clamp01((colorfulness - K_LO) / (K_HI - K_LO))
    p = _clamp01((warm_sat - P_LO) / (P_HI - P_LO)) * min(1.0, warm_frac / P_MIN_WARM)
    conf = min(1.0, valid_frac / C_FULL_VALID)
    return 100.0 * conf * (WEIGHT_W * w + WEIGHT_K * k + WEIGHT_P * p)


def score_image(img: Any, regions: List[List[float]]) -> Dict[str, float]:
    """Score one PIL image over its sky regions. Returns the per-frame metrics."""
    rgb = img.convert("RGB")
    width, height = rgb.size
    total = 0
    n = 0
    warm = 0
    warm_s = 0.0
    sum_rg = sum_yb = sum_rg2 = sum_yb2 = 0.0
    for x0, y0, x1, y1 in regions:
        box = (int(x0 * width), int(y0 * height), max(int(x1 * width), int(x0 * width) + 1), max(int(y1 * height), int(y0 * height) + 1))
        crop = rgb.crop(box)
        if REDUCE_FACTOR > 1:
            crop = crop.reduce(REDUCE_FACTOR)
        rgb_bytes = crop.tobytes()
        hsv_bytes = crop.convert("HSV").tobytes()
        for i in range(0, len(rgb_bytes), 3):
            total += 1
            v = hsv_bytes[i + 2] / 255.0
            if v < DARK_V:
                continue
            s = hsv_bytes[i + 1] / 255.0
            if v > GLARE_V and s < GLARE_S:
                continue
            r, g, b = rgb_bytes[i], rgb_bytes[i + 1], rgb_bytes[i + 2]
            n += 1
            rg = r - g
            yb = 0.5 * (r + g) - b
            sum_rg += rg
            sum_yb += yb
            sum_rg2 += rg * rg
            sum_yb2 += yb * yb
            hue = hsv_bytes[i] * 360.0 / 255.0
            if (hue <= WARM_HUE_MAX or hue >= WARM_HUE_MIN) and s >= WARM_S_MIN and v >= WARM_V_MIN:
                warm += 1
                warm_s += s
    if total == 0 or n == 0:
        return {"valid_frac": 0.0, "warm_frac": 0.0, "colorfulness": 0.0, "warm_sat": 0.0, "score": 0.0}
    mean_rg, mean_yb = sum_rg / n, sum_yb / n
    std_rg = math.sqrt(max(0.0, sum_rg2 / n - mean_rg * mean_rg))
    std_yb = math.sqrt(max(0.0, sum_yb2 / n - mean_yb * mean_yb))
    colorfulness = math.hypot(std_rg, std_yb) + 0.3 * math.hypot(mean_rg, mean_yb)
    valid_frac = n / total
    warm_frac = warm / n
    warm_sat = warm_s / warm if warm else 0.0
    return {
        "valid_frac": valid_frac,
        "warm_frac": warm_frac,
        "colorfulness": colorfulness,
        "warm_sat": warm_sat,
        "score": combine_score(warm_frac, colorfulness, warm_sat, valid_frac),
    }


def score_file(path: Path, regions: List[List[float]]) -> Dict[str, float]:
    from PIL import Image  # imported late so --help works without Pillow

    with Image.open(path) as im:
        im.load()
        return score_image(im, regions)


# ===========================================================================
# Config, state
# ===========================================================================


def load_config(path: Path = CONFIG_PATH) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_state() -> Dict[str, Any]:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("done"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"done": {}}


def save_state(state: Dict[str, Any], now: datetime) -> None:
    cutoff = (now - timedelta(days=14)).strftime("%Y-%m-%d")
    state["done"] = {k: v for k, v in state["done"].items() if k.split("|")[2] >= cutoff}
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
    os.replace(tmp, STATE_FILE)


def state_key(slug: str, kind: str, local_date: str, cam_id: str) -> str:
    return f"{slug}|{kind}|{local_date}|{cam_id}"


# ===========================================================================
# YouTube DVR -> frames
# ===========================================================================


def iso_z(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def parse_iso(s: str) -> datetime:
    s = s.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    # Python 3.9's fromisoformat wants 3 or 6 fractional digits; normalise.
    m = re.match(r"^(.*?)(\.\d+)?([+-]\d\d:\d\d)?$", s)
    if m:
        base, frac, off = m.group(1), m.group(2) or "", m.group(3) or "+00:00"
        if frac:
            frac = "." + (frac[1:] + "000000")[:6]
        s = base + frac + off
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class HlsTimeline:
    """The DVR playlist as (start, duration, url) segments with real times."""

    def __init__(self, segments: List[Tuple[datetime, float, str]]):
        self.segments = segments
        self._starts = [s[0].timestamp() for s in segments]

    @classmethod
    def parse(cls, text: str) -> "HlsTimeline":
        """Time each segment from the MOST RECENT #EXT-X-PROGRAM-DATE-TIME tag
        plus the EXTINF durations since it. After a stream restart there can be
        several tags; each one re-anchors the clock. Segments before the first
        tag have no known time and are dropped."""
        segs: List[Tuple[datetime, float, str]] = []
        cur: Optional[datetime] = None
        pending: Optional[float] = None
        for raw in text.splitlines():
            line = raw.strip()
            if not line:
                continue
            if line.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
                try:
                    cur = parse_iso(line.split(":", 1)[1])
                except ValueError:
                    cur = None
            elif line.startswith("#EXTINF:"):
                try:
                    pending = float(line[len("#EXTINF:") :].split(",")[0])
                except ValueError:
                    pending = None
            elif not line.startswith("#"):
                if pending is not None and cur is not None:
                    segs.append((cur, pending, line))
                    cur = cur + timedelta(seconds=pending)
                pending = None
        return cls(segs)

    def span(self) -> Optional[Tuple[datetime, datetime]]:
        if not self.segments:
            return None
        last = self.segments[-1]
        return self.segments[0][0], last[0] + timedelta(seconds=last[1])

    def locate(self, t: datetime) -> Optional[Tuple[datetime, float, str]]:
        """The segment containing instant `t`, or None if outside the window."""
        if not self.segments:
            return None
        i = bisect.bisect_right(self._starts, t.timestamp()) - 1
        if i < 0:
            return None
        start, dur, url = self.segments[i]
        if (t - start).total_seconds() >= dur + 0.5:
            return None  # a gap (e.g. after a discontinuity)
        return start, dur, url


def _run(cmd: List[str], timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def _http_get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _resolve_elbo_fallback(cam: Dict[str, Any]) -> Optional[str]:
    """Elbo Room's stream id changes whenever they restart. Scrape the CURRENT
    id from their beach-cam page (the same trick scripts/cam_courier_local.sh
    uses) and accept the first playable one whose title contains the configured
    word (the weather-station stream on the same page shows the street)."""
    fb = cam.get("fallback")
    if not fb:
        return None
    try:
        html = _http_get(fb["page"], timeout=20).decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - best effort
        log(f"{cam['id']}: fallback page fetch failed: {exc}")
        return None
    seen: List[str] = []
    for cand in re.findall(r"live_chat\?v=([A-Za-z0-9_-]{6,})", html):
        if cand not in seen:
            seen.append(cand)
    for cand in seen:
        try:
            r = _run(["yt-dlp", "--no-warnings", "--print", "%(title)s", f"https://www.youtube.com/watch?v={cand}"], 40)
        except subprocess.TimeoutExpired:
            continue
        if r.returncode == 0 and fb.get("title_contains", "") in r.stdout:
            log(f"{cam['id']}: fallback video id -> {cand}")
            return cand
    return None


def _ytdlp_info(video_id: str) -> Optional[Dict[str, Any]]:
    try:
        r = _run(["yt-dlp", "-J", "--no-warnings", "--no-playlist", "--socket-timeout", "20", f"https://www.youtube.com/watch?v={video_id}"], 90)
    except subprocess.TimeoutExpired:
        return None
    if r.returncode != 0 or not r.stdout.strip():
        return None
    try:
        return json.loads(r.stdout)
    except ValueError:
        return None


def _pick_hls_format(info: Dict[str, Any]) -> Optional[str]:
    fmts = [f for f in info.get("formats", []) if f.get("protocol", "").startswith("m3u8") and f.get("url") and f.get("vcodec") not in (None, "none")]
    if not fmts:
        return None
    exact = [f for f in fmts if f.get("height") == HLS_PREFERRED_HEIGHT]
    if exact:
        return exact[0]["url"]
    under = sorted((f for f in fmts if (f.get("height") or 0) <= HLS_PREFERRED_HEIGHT), key=lambda f: f.get("height") or 0)
    return (under[-1] if under else fmts[0])["url"]


# YouTube signs every segment URL in a playlist for only ~30 s: after that the
# same URL answers 403 (measured 2026-10-06; a playlist's first ~15 frames fetch
# fine, then everything 403s). So the session re-issues the manifest (one
# `yt-dlp -J`, ~1.5 s) every REFRESH_AFTER_S seconds, and again on any 403.
REFRESH_AFTER_S = 18.0


class DvrSession:
    """One cam's DVR playlist plus the logic to keep its URLs fresh."""

    def __init__(self, cam: Dict[str, Any]):
        self.cam = cam
        self.video_id: str = cam["youtube_id"]
        self.timeline: Optional[HlsTimeline] = None
        self.issued = 0.0
        self.refreshes = 0

    def _issue(self) -> Optional[HlsTimeline]:
        info = _ytdlp_info(self.video_id)
        if info is None and self.cam.get("fallback"):
            log(f"{self.cam['id']}: video id {self.video_id} failed; trying the fallback lookup")
            alt = _resolve_elbo_fallback(self.cam)
            if alt:
                info = _ytdlp_info(alt)
                if info is not None:
                    self.video_id = alt
        if info is None:
            log(f"{self.cam['id']}: yt-dlp could not open the stream")
            return None
        url = _pick_hls_format(info)
        if not url:
            log(f"{self.cam['id']}: no HLS format offered")
            return None
        try:
            text = _http_get(url, timeout=30).decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001
            log(f"{self.cam['id']}: playlist fetch failed: {exc}")
            return None
        tl = HlsTimeline.parse(text)
        if tl.span() is None:
            log(f"{self.cam['id']}: playlist had no timed segments")
            return None
        return tl

    def open(self) -> bool:
        tl = self._issue()
        if tl is None:
            return False
        self.timeline = tl
        self.issued = time.monotonic()
        self.refreshes += 1
        span = tl.span()
        assert span is not None
        if self.refreshes == 1:
            log(f"{self.cam['id']}: DVR {iso_z(span[0])} .. {iso_z(span[1])} ({len(tl.segments)} segments)")
        return True

    def _fetch(self, t: datetime, dest: Path) -> Optional[Tuple[datetime, str]]:
        """Download the segment containing `t`. Returns (segment start, 'ok')
        or (.., 'forbidden') on a 403, None when there is nothing to fetch."""
        if self.timeline is None:
            return None
        hit = self.timeline.locate(t)
        if hit is None:
            return None
        start, _dur, url = hit
        for attempt in (1, 2):
            try:
                dest.write_bytes(_http_get(url, timeout=30))
                return start, "ok"
            except urllib.error.HTTPError as exc:
                return start, "forbidden" if exc.code in (401, 403) else "error"
            except (urllib.error.URLError, OSError, ValueError):
                if attempt == 2:
                    return start, "error"
        return start, "error"

    def frame(self, t: datetime, workdir: Path) -> Optional[Path]:
        """One frame at instant `t`, or None (outside the DVR, a segment that
        403s even on a fresh manifest because it predates a stream restart, ...)."""
        if self.timeline is None:
            return None
        if time.monotonic() - self.issued > REFRESH_AFTER_S:
            self.open()  # on failure keep the old timeline; the 403 path below retries
        seg = workdir / "seg.ts"
        out = workdir / "frame.jpg"
        for p in (seg, out):
            if p.exists():
                p.unlink()
        got = self._fetch(t, seg)
        if got is not None and got[1] == "forbidden" and self.open():
            got = self._fetch(t, seg)
        if got is None or got[1] != "ok":
            return None
        offset = max(0.0, (t - got[0]).total_seconds())
        try:
            # -ss goes AFTER -i on purpose: YouTube's segments carry huge absolute
            # timestamps (start_time ~24,000 s), and an input-side seek on them
            # finds nothing and writes no frame. A segment is only 5 s, so decoding
            # up to the offset is cheap. The scale filter converts the stream's
            # limited ("tv") YUV range to the full range JPEG expects; without it
            # ffmpeg's mjpeg encoder refuses some segments and dulls the colours
            # of others.
            r = _run(
                ["ffmpeg", "-loglevel", "error", "-y", "-i", str(seg), "-ss", f"{offset:.2f}", "-frames:v", "1",
                 "-vf", "scale=in_range=auto:out_range=pc,format=yuvj420p", "-q:v", "2", str(out)],
                40,
            )
        except subprocess.TimeoutExpired:
            return None
        if r.returncode != 0 or not out.exists() or out.stat().st_size < 2000:
            return None
        return out


# ===========================================================================
# Per-event processing
# ===========================================================================


def sample_times(event_t: datetime) -> List[datetime]:
    n = (WINDOW_BEFORE_MIN + WINDOW_AFTER_MIN) * 60 // STEP_SECONDS
    first = event_t - timedelta(minutes=WINDOW_BEFORE_MIN)
    return [first + timedelta(seconds=STEP_SECONDS * i) for i in range(n + 1)]


def frame_name(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%H%M%SZ.jpg")


def build_result(frames: List[Dict[str, Any]], planned: int) -> Optional[Dict[str, Any]]:
    """Collapse scored frames to the event result. `frames` holds dicts with
    t (datetime) plus the per-frame metrics. None when too few frames."""
    if not frames or len(frames) < max(1, math.ceil(planned * MIN_FRAME_COVERAGE)):
        return None
    peak = max(frames, key=lambda f: f["score"])
    return {
        "observed_score": round(peak["score"], 1),
        "warm_frac": round(peak["warm_frac"], 4),
        "colorfulness": round(peak["colorfulness"], 1),
        "peak_frame_iso": iso_z(peak["t"]),
        "series": [
            {
                "t": iso_z(f["t"]),
                "score": round(f["score"], 1),
                "warm_frac": round(f["warm_frac"], 4),
                "colorfulness": round(f["colorfulness"], 1),
                "warm_sat": round(f["warm_sat"], 3),
            }
            for f in frames
        ],
        "frames": len(frames),
        "planned": planned,
    }


def save_frames(out_dir: Path, scored: List[Dict[str, Any]], peak_t: datetime) -> None:
    """Peak frame at full quality, the rest at low JPEG quality."""
    from PIL import Image

    out_dir.mkdir(parents=True, exist_ok=True)
    for f in scored:
        src = f.get("path")
        if not src or not Path(src).exists():
            continue
        if f["t"] == peak_t:
            shutil.copyfile(src, out_dir / ("peak-" + frame_name(f["t"])))
        with Image.open(src) as im:
            im.convert("RGB").save(out_dir / frame_name(f["t"]), "JPEG", quality=40, optimize=True)


def payload_for(cam: Dict[str, Any], beach: Dict[str, Any], kind: str, local_date: str, event_iso: str, view: str, result: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "slug": beach["slug"],
        "event_kind": kind,
        "event_date_local": local_date,
        "event_iso": event_iso,
        "cam_id": cam["id"],
        "view": view,
        "distance_mi": beach["distance_mi"],
        "observed_score": result["observed_score"],
        "warm_frac": result["warm_frac"],
        "colorfulness": result["colorfulness"],
        "peak_frame_iso": result["peak_frame_iso"],
        "series": result["series"],
        "score_version": SUN_CAM_SCORE_VERSION,
        "credit": cam["credit"],
    }


def post_observation(payload: Dict[str, Any], token: str) -> Tuple[bool, str]:
    req = urllib.request.Request(
        f"{API_BASE}/api/sun-observations",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "isitbeachday-suncam/1"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return True, resp.read().decode("utf-8", "replace")[:300]
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:300]}"
    except (urllib.error.URLError, OSError) as exc:
        return False, f"network: {exc}"


def read_token() -> Optional[str]:
    try:
        tok = TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return tok or None


def print_series(label: str, frames: List[Dict[str, Any]], peak_t: Optional[datetime], in_window: Optional[set] = None) -> None:
    print(f"\n{label}")
    print(f"  {'frame (UTC)':<22}{'warm':>7}{'color':>8}{'wsat':>7}{'valid':>7}{'score':>8}")
    for f in frames:
        mark = " <- PEAK" if peak_t is not None and f["t"] == peak_t else ""
        out = "" if in_window is None or f["t"] in in_window else "  (outside window)"
        print(
            f"  {iso_z(f['t']):<22}{f['warm_frac']:>7.3f}{f['colorfulness']:>8.1f}{f['warm_sat']:>7.2f}{f['valid_frac']:>7.2f}{f['score']:>8.1f}{mark}{out}"
        )


# ---------------------------------------------------------------------------
# --from-dir: score already-saved frames
# ---------------------------------------------------------------------------

FRAME_RE = re.compile(r"^(?:peak-)?(\d{2})(\d{2})(\d{2})?Z\.jpe?g$", re.IGNORECASE)


def run_from_dir(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    d = Path(args.from_dir).expanduser().resolve()
    parts = d.parts
    cam_id = args.cam or (parts[-1] if len(parts) >= 1 else None)
    kind = args.event or (parts[-2] if len(parts) >= 2 else None)
    date_s = args.date or (parts[-3] if len(parts) >= 3 else None)
    cam = next((c for c in cfg["cams"] if c["id"] == cam_id), None)
    if cam is None or kind not in ("sunrise", "sunset") or not date_s or not re.match(r"^\d{4}-\d{2}-\d{2}$", date_s):
        log(f"--from-dir: could not work out cam/event/date from {d} (got cam={cam_id!r}, event={kind!r}, date={date_s!r}); pass --cam/--event/--date")
        return 2
    beach = next((b for b in cam["beaches"] if b["slug"] == args.slug), None) if args.slug else cam["beaches"][0]
    if beach is None:
        log(f"--from-dir: cam {cam_id} does not observe {args.slug}")
        return 2
    local_date = date.fromisoformat(date_s)
    st = sun_times(beach["lat"], beach["lon"], local_date)
    event_t = st[kind]
    if event_t is None:
        log("no sunrise/sunset on that date")
        return 2
    view = view_for(cam["facing_azimuth_deg"], st[f"{kind}_az"])
    event_iso = iso_z(event_t)

    files = sorted(p for p in d.iterdir() if p.is_file() and FRAME_RE.match(p.name) and not p.name.lower().startswith("peak-"))
    if not files:
        log(f"--from-dir: no HHMMZ.jpg / HHMMSSZ.jpg frames in {d}")
        return 2
    win_lo = event_t - timedelta(minutes=WINDOW_BEFORE_MIN)
    win_hi = event_t + timedelta(minutes=WINDOW_AFTER_MIN)
    frames: List[Dict[str, Any]] = []
    for p in files:
        m = FRAME_RE.match(p.name)
        assert m is not None
        hh, mm, ss = int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)
        t = datetime(local_date.year, local_date.month, local_date.day, hh, mm, ss, tzinfo=timezone.utc)
        # Frames are named in UTC; pick the day that lands within 12 h of the event.
        while t - event_t > timedelta(hours=12):
            t -= timedelta(days=1)
        while event_t - t > timedelta(hours=12):
            t += timedelta(days=1)
        m_ = score_file(p, cam["sky_regions"])
        m_["t"] = t
        m_["path"] = str(p)
        frames.append(m_)
    frames.sort(key=lambda f: f["t"])
    in_win = [f for f in frames if win_lo <= f["t"] <= win_hi]
    basis = in_win or frames
    peak = max(basis, key=lambda f: f["score"])
    in_window_set = {f["t"] for f in in_win}
    print(f"cam {cam_id} | {beach['slug']} {kind} {local_date} | event {event_iso} | view {view} | score version {SUN_CAM_SCORE_VERSION}")
    print_series(f"Per-frame scores ({len(frames)} frames, {len(in_win)} inside the event window {iso_z(win_lo)} .. {iso_z(win_hi)})", frames, peak["t"], in_window_set)
    result = build_result(basis, len(basis))
    assert result is not None
    print(
        f"\nPEAK: {result['peak_frame_iso']}  observed_score={result['observed_score']}  "
        f"warm_frac={result['warm_frac']}  colorfulness={result['colorfulness']}"
    )
    payloads = [payload_for(cam, b, kind, local_date.isoformat(), iso_z(sun_times(b["lat"], b["lon"], local_date)[kind]), view, result) for b in cam["beaches"] if args.slug is None or b["slug"] == args.slug]
    if args.json:
        print(json.dumps(payloads[0], indent=2))
    if args.dry_run:
        print("\n(dry run: nothing uploaded)")
        return 0
    token = read_token()
    if not token:
        log(f"ERROR: token file missing or empty at {TOKEN_FILE}; see this script's header for the install steps")
        return 1
    bad = 0
    for pl in payloads:
        ok, msg = post_observation(pl, token)
        log(f"{pl['slug']} {pl['event_kind']} {pl['event_date_local']} {pl['cam_id']}: {'uploaded' if ok else 'FAILED'} {msg}")
        bad += 0 if ok else 1
    return 1 if bad else 0


# ---------------------------------------------------------------------------
# Normal run
# ---------------------------------------------------------------------------


def due_events(cam: Dict[str, Any], now: datetime, tz: Any, force: bool) -> List[Dict[str, Any]]:
    """Every (local date, kind) whose event ended MIN_AGE..MAX_AGE ago, per
    beach the cam observes. Grouped per (date, kind): one frame series per cam."""
    out: Dict[Tuple[str, str], Dict[str, Any]] = {}
    today = now.astimezone(tz).date()
    facing = cam["facing_azimuth_deg"]
    for offset in (-1, 0, 1):
        d = today + timedelta(days=offset)
        cam_st = sun_times(cam["lat"], cam["lon"], d)
        for kind in ("sunrise", "sunset"):
            cam_event = cam_st[kind]
            if cam_event is None:
                continue
            age_min = (now - cam_event).total_seconds() / 60.0
            if not force and not (MIN_AGE_MIN <= age_min <= MAX_AGE_MIN):
                continue
            if force and not (0 <= age_min <= DVR_HOURS * 60):
                continue  # --force relaxes the 25 min .. 3.5 h rule, but an event the DVR cannot hold is pointless
            key = (d.isoformat(), kind)
            beaches = []
            for b in cam["beaches"]:
                bst = sun_times(b["lat"], b["lon"], d)
                if bst[kind] is not None:
                    beaches.append({"beach": b, "event_t": bst[kind]})
            out[key] = {"local_date": d.isoformat(), "kind": kind, "cam_event_t": cam_event, "view": view_for(facing, cam_st[f"{kind}_az"]), "beaches": beaches}
    return list(out.values())


def run_normal(args: argparse.Namespace, cfg: Dict[str, Any]) -> int:
    now = parse_iso(args.now) if args.now else datetime.now(timezone.utc)
    tz = ZoneInfo(cfg.get("timezone", "America/New_York")) if ZoneInfo else timezone(timedelta(hours=-5))
    state = load_state()
    token = None if args.dry_run else read_token()
    if not args.dry_run and not token:
        log(f"ERROR: token file missing or empty at {TOKEN_FILE}; see this script's header for the install steps")
        return 1
    only = set(args.cams.split(",")) if args.cams else None
    failures = 0
    handled = 0
    for cam in cfg["cams"]:
        if only and cam["id"] not in only:
            continue
        events = due_events(cam, now, tz, args.force)
        todo = []
        for ev in events:
            pending = [b for b in ev["beaches"] if args.force or state_key(b["beach"]["slug"], ev["kind"], ev["local_date"], cam["id"]) not in state["done"]]
            if pending:
                todo.append((ev, pending))
        if not todo:
            if args.verbose:
                log(f"{cam['id']}: nothing due")
            continue
        dvr = DvrSession(cam)
        if not dvr.open():
            failures += 1
            continue
        for ev, pending in todo:
            kind, local_date = ev["kind"], ev["local_date"]
            targets = sample_times(ev["cam_event_t"])
            scored: List[Dict[str, Any]] = []
            with tempfile.TemporaryDirectory(prefix="suncam-") as tmp:
                for t in targets:
                    path = dvr.frame(t, Path(tmp))
                    if path is None:
                        continue
                    m = score_file(path, cam["sky_regions"])
                    m["t"] = t
                    keep = Path(tmp) / f"keep-{t.strftime('%H%M%S')}.jpg"
                    shutil.copyfile(path, keep)
                    m["path"] = str(keep)
                    scored.append(m)
                result = build_result(scored, len(targets))
                if result is None:
                    log(f"{cam['id']} {kind} {local_date}: only {len(scored)}/{len(targets)} frames recovered (need {math.ceil(len(targets) * MIN_FRAME_COVERAGE)}); will retry while the DVR still has it")
                    continue
                peak_t = parse_iso(result["peak_frame_iso"])
                if args.dry_run:
                    print_series(f"{cam['id']} {kind} {local_date} (view {ev['view']})", scored, peak_t)
                    print(f"  PEAK {result['peak_frame_iso']} score={result['observed_score']} warm_frac={result['warm_frac']} colorfulness={result['colorfulness']}")
                else:
                    save_frames(FRAMES_ROOT / local_date / kind / cam["id"], scored, peak_t)
            # Upload one observation per observed beach.
            for item in pending:
                b = item["beach"]
                payload = payload_for(cam, b, kind, local_date, iso_z(item["event_t"]), ev["view"], result)
                if args.json:
                    print(json.dumps(payload, indent=2))
                if args.dry_run:
                    log(f"{b['slug']} {kind} {local_date} {cam['id']}: dry run, score {result['observed_score']} (not uploaded)")
                    continue
                ok, msg = post_observation(payload, token or "")
                if ok:
                    handled += 1
                    state["done"][state_key(b["slug"], kind, local_date, cam["id"])] = {
                        "uploaded_at": iso_z(datetime.now(timezone.utc)),
                        "score": result["observed_score"],
                        "score_version": SUN_CAM_SCORE_VERSION,
                    }
                    save_state(state, now)
                    log(f"{b['slug']} {kind} {local_date} {cam['id']}: score {result['observed_score']} uploaded {msg}")
                else:
                    failures += 1
                    log(f"{b['slug']} {kind} {local_date} {cam['id']}: upload FAILED {msg}")
    log(f"done: {handled} observation(s) uploaded, {failures} failure(s)")
    return 1 if failures and not handled else 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Score every sunrise/sunset from the beach livestreams and upload the result.")
    ap.add_argument("--dry-run", action="store_true", help="score and print; upload nothing, write no state, save no frames")
    ap.add_argument("--force", action="store_true", help="ignore the state file and the 25 min - 3.5 h age window")
    ap.add_argument("--from-dir", help="score already-saved frames in DIR (…/<local-date>/<event>/<cam-id>/)")
    ap.add_argument("--cam", help="--from-dir: cam id (default: from the path)")
    ap.add_argument("--event", choices=["sunrise", "sunset"], help="--from-dir: event kind (default: from the path)")
    ap.add_argument("--date", help="--from-dir: beach-local date YYYY-MM-DD (default: from the path)")
    ap.add_argument("--slug", help="--from-dir: only this beach (default: every beach the cam observes)")
    ap.add_argument("--cams", help="comma-separated cam ids to process (default: all)")
    ap.add_argument("--now", help="override the clock (ISO 8601), for testing")
    ap.add_argument("--json", action="store_true", help="also print each upload payload")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)
    try:
        import PIL  # noqa: F401
    except ImportError:
        print("Pillow is missing: pip install pillow", file=sys.stderr)
        return 2
    cfg = load_config()
    if args.from_dir:
        return run_from_dir(args, cfg)
    return run_normal(args, cfg)


if __name__ == "__main__":
    sys.exit(main())
