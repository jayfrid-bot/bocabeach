#!/usr/bin/env python3
"""
Read visible sargassum/seaweed + crowd from close-up beach-cam stills using a
FALLBACK CHAIN of free vision APIs. Runs OFF Netlify in the Action; writes one
tiny cam_seaweed.<slug>.json PER BEACH for the web app to read. Pure stdlib
(urllib/base64/json/zoneinfo) except for the optional ffmpeg frame-grab used
by "hls"-kind cams (see CAM_REGISTRY below).

PER-BEACH: which cams to read is NOT hard-coded here. It comes from the JSON
registry at CAM_REGISTRY (default config/vision-cams.json), shaped:
  { "<slug>": { "timezone": "America/New_York",
                "cams": [ { "id", "name", "role": "crowd"|"shore",
                            "source": {"kind": "feed"|"direct"|"hls", ...} } ] } }
Every slug in the registry is processed in one run, so adding a beach (e.g.
Deerfield Beach) is a registry edit, not a code change. A `lib/visionCams.test.ts`
vitest cross-checks every registry cam id + feed base/view against
config/locations.ts, so Python (plain json.load, no schema library needed) and
TS never drift apart. Three cam.source.kind values:
  feed   — a video-monitoring.com "latest.json" rotating-frame feed (existing
           logic): {base, view}.
  direct — a fixed JPG still URL, fetched as-is: {url}. Optionally also
           {meta}: a JSON {id, videoId, grabbedAtUtc, ok, error?} URL for a
           courier-fed cam (e.g. Deerfield Beach's uw-frame Worker) — when
           present we check it before spending a vision call and skip a frame
           that's stale (> DIRECT_FRAME_MAX_AGE_MIN) or one we already scored
           last run (dedupe against the courier's multi-hour refresh cadence
           vs. this job's ~10-min cycle). See direct_cam_decision().
  hls    — a live HLS (m3u8) stream; we grab exactly one frame with ffmpeg
           (preinstalled on GitHub's ubuntu runners): {url}.
Output: one file per beach, cam_seaweed.<slug>.json, written under
CAM_SEAWEED_OUT_DIR (default "."; the workflow points it at a temp dir). Each
file keeps the EXACT shape this script always wrote (history[], morning,
latest, uw, ...) so nothing downstream changes per beach. For one release we
also keep writing the pre-split single-file cam_seaweed.json (CAM_SEAWEED_OUT)
as a copy of boca-raton's file, so lib/sources/*.ts's transition fallback (and
any stale CDN cache) still resolves. If a beach's capture fails this cycle
(every cam errored, or no providers), we still (re)write its file from the
PREVIOUS published one (carry-forward) — see main() — so the workflow's
force-pushed branch never drops a beach it once had.

Reliability: each image is tried against each configured provider in order until
one answers, so one provider being rate-limited/down doesn't blank the feed. A
provider is "configured" only if its key is present (see OPENAI_PROVIDERS below):
  gemini · groq · openrouter · github (GitHub Models)
All are free tiers; set GEMINI_API_KEY and/or any of GROQ_API_KEY,
OPENROUTER_API_KEY, GITHUB_MODELS_TOKEN (GITHUB_TOKEN with `models: read` in CI).
With none configured it preserves existing readings and exits 0.

The City runs a tractor that clears beach seaweed every morning ~7-9 AM, so an
afternoon photo shows a *cleaned* beach and understates what's washing ashore.
We therefore weight the EARLY-MORNING (pre-tractor) capture highest: each run
records the local capture time, and we merge with the previously published file
to preserve today's earliest morning reading as the authoritative `morning`
value (plus a `latest` reading for the current beach state).

UNDERWATER CAM (calibration): Deerfield Beach runs "Spinner the Sea Cam", an
underwater YouTube livestream on the International Fishing Pier ~7 mi up-coast.
At most once per hour during daylight (hours 6-20) we grab a single frame and run
a SEPARATE underwater-visibility vision read through the same provider fallback
chain. This ground-truths the SURFACE water-clarity grades: later we correlate a
tick's surface `clr` against the underwater `uw`. It fully fail-softs — if no
frame is reachable we simply accrue no `uw` fields and lose nothing; the main cam
flow is never affected.

Frame source (fetch_uw_frame) is a COURIER CHAIN, tried in order:
  (a) the Cloudflare "uw-frame" Worker — headless Chrome (Browser Rendering)
      opens the YouTube embed hourly and stores a fresh frame in KV; we read its
      /meta and use /frame when grabbedAtUtc <= 90 min. URL via env UW_FRAME_URL
      (default the deployed worker). This is the cloud-side replacement for the
      old Mac courier and has NO Mac dependency. See workers/uw-frame/.
  (b) the legacy `uw-frames` branch raw file (the owner's Mac launchd courier) —
      kept as a silent fallback in case the Worker is down.
  (c) direct yt-dlp -g -> ffmpeg — works locally/residential but YouTube blocks
      it from GitHub datacenter IPs; kept as a last resort.

WEBCAM ARCHIVE (docs/CAM_ARCHIVE_PLAN.md R1/R3): every tick, each cam in
config/archive-cams.json (generated from config/locations.ts; lib/camFrames/
manifest.test.ts keeps the two equal) has its still POSTed to the app's
/api/cam-frames route with `Authorization: Bearer $INGEST_TOKEN`. The server
keeps one shot per cam per hour (about one per 10 minutes inside golden hour). Two paths feed it, and neither can break the
vision read: capture_beach() queues the still it already fetched for vision
(fetch_still -> queue, then assess) and uploads the queue on a small thread pool
AFTER the beach's reads, so an upload never delays a read; and archive_pass()
fetches the stills the vision loop did NOT fetch this tick (boca-inlet,
boca-inlet-north, boca-inlet-jetty, any courier cam it skipped as stale, and
Spinner when the hourly underwater read did not run). archive_pass() runs on
every tick whether or not a vision provider is configured. A cheap pre-check
(GET /api/cam-frames/slots, one per beach, fails open) tells the script which
cams' slot is already filled, so it skips those uploads, and for
archive-only cams the download too. A slot is a UTC hour, except inside a beach's
golden-hour window (sunrise -20/+40 min, sunset -40/+20 min), where it is 10
minutes wide: the server decides (lib/camFrames/golden.ts) and the pre-check
reply carries the windows so this script can place a frame of any age.
All archive work in a tick shares one 90-second budget (ARCHIVE_DEADLINE_S); unfinished work is dropped and logged
once. Archiving is best-effort: with INGEST_TOKEN unset it does nothing, and
any error is logged and swallowed.
The source's own frame time rides along as `frameAt`: latest.json `timestamp`
for feed cams, the uw-frame /meta grabbedAtUtc for courier cams.

STALE FEED FRAMES: that same latest.json timestamp also gates the vision read,
in three states (see vision_frame_verdict): scored when -5 min <= age <= 60 min;
skipped and logged ("skipped (frame is N min old)" / "... N min in the future")
outside that; and NOT scored when the timestamp is missing or unparsable, with one
WARN line per cam per tick, unless the cam entry sets "visionTrustNoTimestamp":
true in config/vision-cams.json. A skipped cam never reaches assess() and
publishes no reading, just as a courier cam skipped as stale. The archive keeps
its own, separate age rule.

SAME FEED FRAME (2026-10-12): a feed view refreshes only every ~10-30 min, but
the loop ticks every 10, so most ticks re-served a still already scored. Each
scored feed reading carries `frameSha` (sha256 prefix of the JPEG bytes) and the
document keeps a small top-level `frameShas` {cam id: sha} of the last frame each
cam scored SUCCESSFULLY (carried forward untouched for a cam skipped or failed
this tick). A feed frame whose sha equals its cam's entry is skipped with "same
frame already scored", no assess() call, no quota gap, and the cam is absent from
the tick's `cams` just like a skipped courier cam (all cams skipped -> the beach
carries its previous latest/morning/history forward and `generatedAt` is not
bumped). A failed read never records its sha, so it is retried next tick. The
archive still gets the frame (enqueue happens before this check).

VISION CALL LOG: each tick ends with one line, "vision calls this tick: ...",
counting every provider/model attempt (ok and failed) so quota exhaustion shows
in the run log.

Data shape (cam_seaweed.<slug>.json — identical shape on every beach's file):
  top-level `uw`: {level, pct, note, capturedAtLocal} — latest underwater read,
    carried forward on ticks that skip the underwater read (like morning/latest).
    Computed AT MOST ONCE per run (not per beach) and copied onto every beach's
    `uw` field — it's one shared calibration signal, not a per-beach reading.
  history[]: {t, hour, level(crowd), people, crowdPct, seaweed, cov, water, clr}
    plus SPARSE `uw` (pct) + `uwLevel` fields present ONLY on the ~hourly ticks
    that actually ran an underwater read (absent otherwise).
"""
import base64
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")  # 2.0-flash has no free tier
# Google meters the free tier PER MODEL, so a second model is a second daily
# bucket. 2026-09-14: with Deerfield's cams added, 2.5-flash ran out of its
# daily quota mid-afternoon and every beach went unread; 2.5-flash-lite has a
# larger free allowance and takes over for the rest of the day.
GEMINI_MODELS = [
    m.strip()
    for m in os.environ.get("GEMINI_MODELS", f"{MODEL},gemini-2.5-flash-lite").split(",")
    if m.strip()
]
# Legacy pre-per-beach output: kept as a copy of boca-raton's file for one
# release (see LEGACY_SLUG below and the copy step at the end of main()).
OUT = os.environ.get("CAM_SEAWEED_OUT", "cam_seaweed.json")
# Per-beach files (cam_seaweed.<slug>.json) are written here. The workflow
# points this at a temp dir; default "." matches the old single-file layout.
OUT_DIR = os.environ.get("CAM_SEAWEED_OUT_DIR", ".")
# Fallback timezone for a registry entry that omits its own "timezone".
DEFAULT_TZ_NAME = os.environ.get("CAM_TZ", "America/New_York")

# Free vision APIs return 429 (quota/rate) and 503 (overloaded) under load; both
# are usually transient, so we retry with exponential backoff. We also space the
# per-cam calls so a burst doesn't trip a per-minute limit.
RETRY_STATUSES = {429, 500, 502, 503, 504}
MAX_RETRIES = int(os.environ.get("GEMINI_RETRIES", "3"))
CAM_GAP_S = float(os.environ.get("CAM_GAP", "5"))
# api.groq.com sits behind Cloudflare, which blocks the default "Python-urllib"
# User-Agent with a 403 (error 1010). Send a normal browser UA so API calls go
# through. Other providers ignore the UA, so one value is safe everywhere.
HTTP_UA = os.environ.get(
    "HTTP_UA",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
)

# --- vision providers ------------------------------------------------------
# Reliability comes from a FALLBACK CHAIN: try each configured provider in order
# until one returns a valid reading. A provider is "configured" only if its key is
# present, so the script works with just Gemini today and lights up more providers
# as you add free keys (no code change). All but Gemini are OpenAI chat-compatible
# (image as a base64 data URI), so they share one adapter. Free tiers (mid-2026):
#   gemini      GEMINI_API_KEY       ~250 req/day  (Google AI Studio)
#   groq        GROQ_API_KEY         ~14,400/day   (Llama 4 Scout; no credit card)
#   openrouter  OPENROUTER_API_KEY   ~20 req/min   (many :free vision models)
#   github      GITHUB_MODELS_TOKEN  ~50 req/day   (uses the Action's own token)
# Override the order with VISION_PROVIDERS="groq,gemini,openrouter,github".
PROVIDER_ORDER = [
    p.strip()
    # GitHub Models is being retired (410 brownouts from 2026-09) and is off by default.
    for p in os.environ.get("VISION_PROVIDERS", "gemini,groq,openrouter").split(",")
    if p.strip()
]
OPENAI_PROVIDERS = {
    "groq": {
        "url": "https://api.groq.com/openai/v1/chat/completions",
        # Llama 4 Scout was withdrawn from Groq (404 model_not_found, 2026-09).
        # Qwen 3.8 27B is their current production vision model — note the
        # version number: "qwen3.6-27b" 404s (model_not_found), confirmed via
        # console.groq.com/docs/vision 2026-09-22; every cam was silently
        # falling through to Gemini-only until this was caught, so a Gemini
        # daily-quota exhaustion (now more likely with 7 cams across 3
        # beaches sharing the same ~250/day free tier) left every cam
        # unread for the rest of the day with no working fallback.
        "model": os.environ.get("GROQ_MODEL", "qwen/qwen3.8-27b"),
        "key": os.environ.get("GROQ_API_KEY", "").strip(),
    },
    "openrouter": {
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "model": os.environ.get(
            "OPENROUTER_MODEL", "meta-llama/llama-3.2-11b-vision-instruct:free"
        ),
        "key": os.environ.get("OPENROUTER_API_KEY", "").strip(),
    },
    "github": {
        # GitHub Models — free with a token that has `models: read`. In Actions the
        # job's GITHUB_TOKEN works once `permissions: models: read` is set.
        "url": os.environ.get(
            "GITHUB_MODELS_URL", "https://models.github.ai/inference/chat/completions"
        ),
        "model": os.environ.get("GITHUB_MODELS_MODEL", "openai/gpt-4o-mini"),
        "key": (os.environ.get("GITHUB_MODELS_TOKEN", "").strip()
                or os.environ.get("GITHUB_TOKEN", "").strip()),
    },
}

# Base URL each beach's PREVIOUS published file is read from (for carry-forward
# and the earliest-morning-of-the-day logic): "<base>/cam_seaweed.<slug>.json".
PREV_BASE = os.environ.get(
    "CAM_SEAWEED_PREV_BASE",
    "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data",
)
# The one beach that had a single-file feed before the per-beach split — the
# only slug fetch_prev() falls back to the legacy filename for (transition
# safety: its "cam_seaweed.boca-raton.json" may not exist yet on an old branch
# commit), and the only slug main() mirrors into the legacy OUT path.
LEGACY_SLUG = "boca-raton"
# Local hours considered "morning, before/at the beach-cleaning tractor".
MORNING = range(5, 10)

# Which cams to read is NOT hard-coded — see load_registry() and the module
# docstring. This used to be a fixed Boca-only list; it now comes from
# CAM_REGISTRY (config/vision-cams.json), one entry per beach.
CAM_REGISTRY_PATH = os.environ.get("CAM_REGISTRY", "config/vision-cams.json")

# A "direct" cam whose registry entry also carries a "meta" URL (a Frame
# Courier serving a headless-browser grab of a livestream — e.g. Deerfield
# Beach's uw-frame Worker) is read only when its frame is both fresh AND new
# since we last actually scored it — see direct_cam_decision(). The surface
# courier refreshes on a multi-hour cadence while this job runs every ~10 min,
# so without the dedupe check we'd re-score the identical frame a dozen times.
DIRECT_FRAME_MAX_AGE_MIN = float(os.environ.get("DIRECT_FRAME_MAX_AGE_MIN", "150"))

# FRESHNESS of a FEED cam's frame (video-monitoring.com latest.json) for the VISION
# read is three-state, judged by the feed's own timestamp:
#   -5 min <= age <= VISION_MAX_FRAME_AGE_MIN   scored;
#   older than that, or more than 5 min in the future   skipped + logged;
#   timestamp missing or unparsable   NOT scored by default (we cannot tell a live
#     frame from a night one), logged as a conspicuous one-liner per cam per tick.
#     A source known never to carry a timestamp can opt in with
#     "visionTrustNoTimestamp": true on its cam entry in config/vision-cams.json.
# "Not scored" means assess() is not called and no reading is published for the
# cam, exactly like a courier cam skipped as stale. Observed 2026-10-11 6 AM:
# boca-inlet-surf served a 431-470-min-old night frame and the loop scored it
# ("seaweed none, crowd empty") as if it were live. The frame is still offered to
# the archive, which keeps its own age rule (ARCHIVE_FRAME_MAX_AGE_MIN).
VISION_MAX_FUTURE_MIN = 5
VISION_MAX_FRAME_AGE_MIN = float(os.environ.get("VISION_MAX_FRAME_AGE_MIN", "60"))

# --- webcam archive (see the module docstring and docs/CAM_ARCHIVE_PLAN.md) ---
# Where stills are POSTed; the token is read at call time (archive_frame) so a
# missing INGEST_TOKEN simply turns archiving off.
ARCHIVE_URL = os.environ.get("ARCHIVE_URL", "https://app.isitbeachday.com/api/cam-frames")
ARCHIVE_TIMEOUT_S = 15
# Generated from config/locations.ts (scripts/gen_archive_cams.ts); the cams to archive.
ARCHIVE_CAMS_PATH = os.environ.get("ARCHIVE_CAMS", "config/archive-cams.json")
# A frame whose own timestamp is older than this is not archived: the server
# would drop a source time older than 3 h and file the image under "now".
ARCHIVE_FRAME_MAX_AGE_MIN = float(os.environ.get("ARCHIVE_FRAME_MAX_AGE_MIN", "170"))
# Same bounds the server enforces (app/api/cam-frames/route.ts); checking here
# saves a pointless upload.
ARCHIVE_MIN_BYTES = 10 * 1024
ARCHIVE_MAX_BYTES = 600 * 1024
ARCHIVE_WORKERS = int(os.environ.get("ARCHIVE_WORKERS", "4"))
# Wall-time budget for ALL archive work in one tick (pre-check, every upload
# flush, archive_pass). Unfinished work at the deadline is dropped.
ARCHIVE_DEADLINE_S = float(os.environ.get("ARCHIVE_DEADLINE_S", "90"))
ARCHIVE_PRECHECK_TIMEOUT_S = 8
# The underwater "Spinner" cam follows its own fetch path (fetch_uw_frame).
UW_ARCHIVE_SLUG = "deerfield-beach"
UW_ARCHIVE_CAM_ID = "deerfield-spinner-uw"


def load_registry() -> dict:
    """Every beach's cam list, keyed by slug. {} (and a warning) if the
    registry file is missing/unparsable — fail-soft, same spirit as "no
    vision providers configured": nothing to do, exit 0."""
    try:
        with open(CAM_REGISTRY_PATH, encoding="utf-8") as fh:
            registry = json.load(fh)
    except Exception as e:  # noqa: BLE001
        print(f"warn: couldn't load {CAM_REGISTRY_PATH}: {e}", file=sys.stderr)
        return {}
    if not isinstance(registry, dict):
        print(f"warn: {CAM_REGISTRY_PATH} is not a JSON object — ignoring", file=sys.stderr)
        return {}
    return registry


SEAWEED = ("none", "low", "moderate", "high")
SEAWEED_RANK = {s: i for i, s in enumerate(SEAWEED)}
CROWD = ("empty", "quiet", "moderate", "busy", "packed")
CROWD_RANK = {c: i for i, c in enumerate(CROWD)}
# Water clarity, ordered clearest -> most turbid ("churned" = sand stirred
# through the column, worse for visibility than plain murk).
WATER = ("clear", "slightly_murky", "murky", "churned")
WATER_RANK = {w: i for i, w in enumerate(WATER)}
# Underwater visibility from the Deerfield sea-cam, ordered clearest -> murkiest.
UW_CLARITY = ("clear", "slightly_hazy", "hazy", "murky")

# Underwater sea-cam: Deerfield Beach "Spinner the Sea Cam" YouTube livestream.
# yt-dlp -g resolves an HLS manifest URL (needs a JS runtime — node is on PATH in
# GitHub ubuntu runners); ffmpeg then grabs one frame. See fetch_uw_frame().
UW_STREAM_URL = os.environ.get(
    "UW_STREAM_URL", "https://www.youtube.com/watch?v=SHfAtWHr9Ks"
)
# Cloud-side frame courier: the Cloudflare Browser-Rendering Worker that grabs a
# fresh underwater frame hourly and serves /frame + /meta. Preferred source (no
# Mac dependency). See workers/uw-frame/.
UW_FRAME_URL = os.environ.get(
    "UW_FRAME_URL", "https://uw-frame.entwined-app.workers.dev"
).rstrip("/")
# A courier frame older than this (minutes) is considered stale -> fall through.
UW_FRAME_MAX_AGE_MIN = float(os.environ.get("UW_FRAME_MAX_AGE_MIN", "90"))
# Only run the underwater read within these LOCAL hours (dark underwater at night).
# The at-most-once-per-hour cap itself is enforced in main() by AGE of the
# previous uw read (>= 50 min), not by wall-clock minute — see the comment there
# for why. That age gate is what actually throttles this to ~hourly, whether a
# tick arrives from GitHub's throttled cron or from the workflow's internal
# ~10-min loop (see .github/workflows/sargassum.yml): a fresh run every ~10 min
# means the gate opens on the 6th cycle after the last successful read, i.e.
# close to exactly once per hour, same as before.
UW_HOURS = range(6, 21)  # 6 AM .. 8 PM local, inclusive

PROMPT = (
    "This is a live beach webcam photo. Return strict JSON only: "
    '{"seaweed":"none|low|moderate|high","seaweed_pct":<integer 0-100>,'
    '"seaweed_note":"<=8 words","crowd":"empty|quiet|moderate|busy|packed",'
    '"crowd_pct":<integer 0-100>,"people":<approx visible people as integer>,'
    '"crowd_note":"<=8 words",'
    '"water":"clear|slightly_murky|murky|churned|unknown",'
    '"water_pct":<integer 0-100 or null>,"water_note":"<=8 words"}. '
    "Seaweed = brown/golden sargassum on the sand and in shallow water: "
    "none=clean sand, low=thin wrack line or scattered patches, "
    "moderate=clear bands, high=heavy mats over much of the shore. "
    "seaweed_pct = percent of the visible sand/shoreline covered by sargassum "
    "(0=clean, 5=thin wrack line, 30=clear bands, 60=heavy mats, 90+=nearly all covered). "
    "Crowd = how busy the beach looks from people on the sand and in the water "
    "(and cars in any visible parking lot): empty=nobody, quiet=a few people, "
    "moderate=steady, busy=crowded, packed=very crowded. "
    "crowd_pct = how full the beach looks, 0=empty to 100=packed holiday peak. "
    "Water = how clear the OCEAN WATER itself looks where it is visible (judge "
    "color and transparency of the water beyond the breaking surf, not "
    "whitewater foam). IMPORTANT: floating seaweed patches and brown seaweed "
    "mats are NOT murkiness — seaweed is graded separately above; judge the "
    "water transparency in areas FREE of seaweed, and don't let sun glare or "
    "surface brightness read as murk. clear=blue-green and transparent, "
    "slightly_murky=greenish with some suspended sand, murky=brown/tea-colored "
    "water itself, churned=heavily stirred-up sand throughout. Use unknown "
    "(and water_pct null) if open water is not clearly visible in this frame. "
    "water_pct = water clarity 0-100. Use the FULL scale and discriminate: "
    "90-100 = exceptional glass-clear tropical water (rare here); 75-89 = very "
    "clear blue-green; 60-74 = decent but visibly tinted green, a typical fair "
    "day; 40-59 = noticeably murky/sandy; 20-39 = poor, brown or heavily "
    "suspended; <20 = opaque. Most days fall 55-80 — reserve 85+ for genuinely "
    "exceptional transparency."
)

# Separate prompt for the UNDERWATER sea-cam frame — a different scene (below the
# surface, looking through the water column), so it gets its own strict-JSON read.
UW_PROMPT = (
    "This is a frame from an UNDERWATER ocean webcam (a camera submerged off a "
    "fishing pier, looking through the water). Return strict JSON only: "
    '{"uw_clarity":"clear|slightly_hazy|hazy|murky",'
    '"uw_pct":<integer 0-100 or null>,"uw_note":"<=8 words"}. '
    "Judge how far you can SEE through the water: "
    "clear=fish/structures/pilings crisp at distance, "
    "slightly_hazy=objects visible but soft, "
    "hazy=only near objects visible, "
    "murky=heavy particulates, little visibility. "
    "uw_pct = underwater visibility 0-100 where 100=gin-clear and 0=opaque. "
    "If the frame is too dark to judge (night/no light), return uw_pct null."
)


def _get(url: str, timeout: int = 25) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "boca-beach-rats"})
    return urllib.request.urlopen(req, timeout=timeout).read()


def _ffmpeg_frame_from_url(url: str, timeout: int = 20) -> bytes:
    """Grab exactly one JPEG frame from a stream URL (HLS/m3u8 or anything
    else ffmpeg can open) via `ffmpeg -i <url> -frames:v 1`. Shared by the
    "hls"-kind registry cams and fetch_uw_frame()'s own last-resort grab."""
    fd, tmp = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", url, "-frames:v", "1", tmp],
            capture_output=True, timeout=timeout, check=True,
        )
        with open(tmp, "rb") as fh:
            data = fh.read()
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if not data:
        raise RuntimeError("ffmpeg produced an empty frame")
    return data


def direct_cam_decision(meta: dict | None, prev_frame_at: str | None, now: dt.datetime) -> dict:
    """Whether to read a "direct" cam that carries a "meta" URL (a Frame
    Courier serving a headless-browser grab of a livestream), and why. PURE —
    no network, no globals besides the DIRECT_FRAME_MAX_AGE_MIN constant — so
    it's unit-testable without mocking HTTP.

    `meta` is the already-fetched/parsed {id, videoId, grabbedAtUtc, ok, error?}
    document (or None if it couldn't be fetched/parsed at all). `prev_frame_at`
    is the grabbedAtUtc this same cam carried in the beach's previously
    published file (or None if never recorded). `now` must be tz-aware (or
    naive-UTC) so age can be computed.

    Returns {"skip": bool, "reason": str | None, "frameAt": str | None}:
      - meta missing/unreachable        -> skip, frameAt None
      - meta["ok"] is False              -> skip, frameAt None
      - no/unparsable grabbedAtUtc       -> skip, frameAt None
      - frame older than the max age     -> skip, frameAt carried (for display)
      - frame == the one we last scored  -> skip, frameAt carried (dedupe —
                                             the whole point of this check)
      - otherwise                        -> don't skip; frameAt is the fresh
                                             grabbedAtUtc to record on a
                                             successful read.
    """
    if not meta:
        return {"skip": True, "reason": "no meta", "frameAt": None}
    if meta.get("ok") is False:
        return {"skip": True, "reason": "meta not ok", "frameAt": None}
    grabbed_at = meta.get("grabbedAtUtc")
    if not grabbed_at:
        return {"skip": True, "reason": "no grabbedAtUtc", "frameAt": None}
    try:
        grabbed = dt.datetime.strptime(grabbed_at, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=dt.timezone.utc)
    except (ValueError, TypeError):
        return {"skip": True, "reason": "unparsable grabbedAtUtc", "frameAt": None}
    # `now` is a parameter (not wall-clock time) so this stays pure/testable —
    # unlike _age_min_utc(), which always measures against the real clock.
    now_utc = now if now.tzinfo else now.replace(tzinfo=dt.timezone.utc)
    age_min = (now_utc - grabbed).total_seconds() / 60
    if age_min > DIRECT_FRAME_MAX_AGE_MIN:
        return {"skip": True, "reason": f"stale frame ({age_min:.0f} min)", "frameAt": grabbed_at}
    if prev_frame_at and grabbed_at == prev_frame_at:
        return {"skip": True, "reason": "same frame already scored", "frameAt": grabbed_at}
    return {"skip": False, "reason": None, "frameAt": grabbed_at}


def prev_frame_at_for_cam(prev: dict, cam_id: str) -> str | None:
    """The most recent frameAt recorded for `cam_id` in the beach's previously
    published history (scanned newest-first), or None if it was never
    recorded (a brand-new cam, or one whose reads have all been skipped so
    far). See build_beach_output()'s `entry["frames"]`."""
    for entry in reversed(prev.get("history") or []):
        frames = entry.get("frames")
        if isinstance(frames, dict) and cam_id in frames:
            return frames[cam_id]
    return None


def frame_sha(img: bytes) -> str:
    """Short, stable fingerprint of a frame's bytes (first 20 hex chars of the
    sha256 — plenty to tell two stills of one cam apart)."""
    return hashlib.sha256(img).hexdigest()[:20]


def prev_scored_sha_for_cam(prev: dict, cam_id: str) -> str | None:
    """The fingerprint of the last frame of `cam_id` that a vision read SCORED
    successfully, from the beach's previously published document (`frameShas`,
    see build_beach_output), or None if there is none. A frame whose read failed
    is never recorded, so it is retried on the next tick."""
    shas = prev.get("frameShas")
    if isinstance(shas, dict):
        sha = shas.get(cam_id)
        if isinstance(sha, str) and sha:
            return sha
    return None


def _iso_utc_from_unix(ts: object) -> str | None:
    """'2026-10-11T14:05:09Z' from a unix timestamp (seconds; milliseconds are
    tolerated), or None when it is missing or not a believable number."""
    if isinstance(ts, bool) or not isinstance(ts, (int, float)) or ts <= 0:
        return None
    if ts > 1e11:  # milliseconds
        ts = ts / 1000.0
    try:
        return (dt.datetime.fromtimestamp(ts, dt.timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%SZ"))
    except (OverflowError, OSError, ValueError):
        return None


# Guards the optional shared latest.json cache in fetch_still(): archive_pass
# fetches stills on several threads, and several cams share one feed.
_FEED_LOCK = threading.Lock()


def fetch_still(cam: dict, info: dict | None = None, feed_cache: dict | None = None) -> bytes:
    """Grab one still frame for a registry cam, per its source.kind:
      feed   — video-monitoring.com "latest.json" rotating-frame feed
               ({base, view}, the pre-existing behaviour).
      direct — a fixed JPG still URL, fetched as-is ({url}).
      hls    — a live HLS/m3u8 stream, one frame via ffmpeg ({url}).

    `info`, when given, receives what the fetch learned about the frame:
    info["frameAt"] = the feed's own capture time for this view (latest.json
    `timestamp`, as 'YYYY-MM-DDTHH:MM:SSZ') for feed cams. It was always in the
    feed and used to be thrown away; the webcam archive needs it. Direct cams
    learn their frame time from their /meta URL instead (see capture_beach and
    archive_pass). `feed_cache`, when given, is a {base: parsed latest.json}
    dict that lets several cams on one feed share a single download.
    """
    src = cam.get("source") or {}
    kind = src.get("kind", "feed")
    if kind == "feed":
        base, view = src["base"], src["view"]
        if feed_cache is not None:
            with _FEED_LOCK:
                feed = feed_cache.get(base)
                if feed is None:
                    feed = json.loads(_get(f"{base}/latest.json").decode("utf-8", "replace"))
                    feed_cache[base] = feed
        else:
            feed = json.loads(_get(f"{base}/latest.json").decode("utf-8", "replace"))
        entry = feed[view]
        if info is not None:
            info["frameAt"] = _iso_utc_from_unix(entry.get("timestamp"))
        return _get(f"{base}/{entry['mr']}")
    if kind == "direct":
        return _get(src["url"])
    if kind == "hls":
        return _ffmpeg_frame_from_url(src["url"])
    raise ValueError(f"cam {cam.get('id')!r}: unknown source kind {kind!r}")


def _age_min_utc(grabbed_at: str) -> float:
    """Minutes since an ISO-8601 UTC timestamp like '2026-07-24T14:38:39Z'."""
    grabbed = dt.datetime.strptime(
        grabbed_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    return (dt.datetime.now(dt.timezone.utc) - grabbed).total_seconds() / 60


def fetch_uw_frame() -> bytes:
    """Grab a single JPEG frame from the Deerfield underwater YouTube livestream
    (bytes only; see fetch_uw_frame_timed for the frame's own capture time)."""
    return fetch_uw_frame_timed()[0]


def fetch_uw_frame_timed() -> tuple[bytes, str | None]:
    """Grab a single JPEG frame from the Deerfield underwater YouTube livestream.

    Returns (jpeg bytes, frame time). The frame time is the courier's own
    grabbedAtUtc ('YYYY-MM-DDTHH:MM:SSZ') for the Worker and legacy couriers, and
    None for the direct yt-dlp grab (a live grab, so "now" is the server's
    receive time). The webcam archive sends it as `frameAt`.

    COURIER CHAIN, tried in order (each fail-soft, all timeouts tight):
      (a) Cloudflare uw-frame Worker (Browser Rendering) — the cloud-side, NO-Mac
          replacement. Read its /meta; if grabbedAtUtc <= UW_FRAME_MAX_AGE_MIN
          (default 90 min) fetch /frame. URL via env UW_FRAME_URL.
      (b) legacy `uw-frames` branch raw file — the owner's Mac launchd courier,
          kept as a silent fallback if the Worker is down.
      (c) direct yt-dlp -g -> ffmpeg — works locally/residential; YouTube blocks
          it from GitHub datacenter IPs, so it's the last resort.

    If ALL three fail this raises — the caller catches it and the main cam flow
    is unaffected; we simply accrue no `uw` field for that tick.
    """
    # (a) PREFERRED — Cloudflare Browser-Rendering Worker (no Mac dependency).
    try:
        meta = json.loads(_get(f"{UW_FRAME_URL}/meta", timeout=15)
                          .decode("utf-8", "replace"))
        grabbed_at = meta.get("grabbedAtUtc")
        if grabbed_at:
            age_min = _age_min_utc(grabbed_at)
            if age_min <= UW_FRAME_MAX_AGE_MIN:
                frame = _get(f"{UW_FRAME_URL}/frame", timeout=25)
                if frame[:2] == b"\xff\xd8":  # JPEG magic — a real image
                    print(f"  uw: CF worker frame ({age_min:.0f} min old)")
                    return frame, grabbed_at
            else:
                print(f"  uw: CF worker frame stale ({age_min:.0f} min) — "
                      "trying legacy courier", file=sys.stderr)
        else:
            print("  uw: CF worker has no frame yet — trying legacy courier",
                  file=sys.stderr)
    except Exception as e:  # noqa: BLE001 — fall through to the legacy courier
        print(f"  uw: CF worker unavailable ({e}) — trying legacy courier",
              file=sys.stderr)

    # (b) LEGACY FALLBACK — the owner's Mac grabs a frame hourly
    # (scripts/uw_frame_local.sh via launchd) and pushes it to the `uw-frames`
    # branch. Silent fallback for when the Worker is down. Use if <= 90 min old.
    try:
        meta = json.loads(_get(
            "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/uw-frames/meta.json",
            timeout=15).decode("utf-8", "replace"))
        grabbed = dt.datetime.strptime(
            meta["grabbedAtUtc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        age_min = (dt.datetime.now(dt.timezone.utc) - grabbed).total_seconds() / 60
        if age_min <= 90:
            frame = _get(
                "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/uw-frames/"
                f"latest.jpg?cb={int(grabbed.timestamp())}", timeout=25)
            if frame[:2] == b"\xff\xd8":  # JPEG magic — a real image, not an error page
                print(f"  uw: legacy courier frame ({age_min:.0f} min old)")
                return frame, meta["grabbedAtUtc"]
        else:
            print(f"  uw: legacy courier frame stale ({age_min:.0f} min) — trying yt-dlp",
                  file=sys.stderr)
    except Exception as e:  # noqa: BLE001 — fall through to the direct grab
        print(f"  uw: legacy courier unavailable ({e}) — trying yt-dlp", file=sys.stderr)

    # (c) LAST RESORT — direct grab. Works locally/residential; blocked from
    # GitHub runners, but kept so the script still works outside CI and in case
    # the ios/tv innertube clients (served different bot-checks) start passing.
    manifest = None
    errors: list[str] = []
    for client in ("ios", "tv", "default"):
        try:
            proc = subprocess.run(
                ["yt-dlp", "--extractor-args", f"youtube:player_client={client}",
                 "-g", UW_STREAM_URL],
                capture_output=True, text=True, timeout=40, check=True,
            )
            lines = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
            if lines:
                manifest = lines[0]  # first line is the video/HLS URL
                break
            errors.append(f"{client}: no manifest URL")
        except Exception as e:  # noqa: BLE001 — try the next client
            errors.append(f"{client}: {e}")
    if manifest is None:
        raise RuntimeError("all yt-dlp clients failed -> " + " | ".join(errors))

    return _ffmpeg_frame_from_url(manifest), None


# --- webcam archive --------------------------------------------------------
# Everything below is best-effort: it never raises into the vision read, and
# with INGEST_TOKEN unset it does nothing at all.

def load_archive_cams() -> list[dict]:
    """The cams to archive, from ARCHIVE_CAMS_PATH (config/archive-cams.json,
    generated from config/locations.ts). Each entry is
    {slug, id, name, attribution, timezone, source: {kind, base/view | url/meta}},
    where `source` has the same shape as a vision-registry cam's, so
    fetch_still() reads either. [] (and a warning) if the file is missing or
    unparsable — then nothing is archived, and the vision read is unaffected."""
    try:
        with open(ARCHIVE_CAMS_PATH, encoding="utf-8") as fh:
            doc = json.load(fh)
        cams = doc.get("cams") if isinstance(doc, dict) else None
        if not isinstance(cams, list):
            raise ValueError("no 'cams' list")
        return [c for c in cams if isinstance(c, dict) and c.get("slug") and c.get("id")]
    except Exception as e:  # noqa: BLE001
        print(f"warn: couldn't load {ARCHIVE_CAMS_PATH}: {e}", file=sys.stderr)
        return []


def archive_keys() -> set[tuple[str, str]]:
    """{(slug, cam id)} for every cam in the archive manifest."""
    return {(c["slug"], c["id"]) for c in load_archive_cams()}


def _frame_age_min(frame_at: str) -> float | None:
    """Minutes since an ISO-8601 UTC time like '2026-10-11T14:05:09Z', or None
    if it does not parse."""
    try:
        t = dt.datetime.fromisoformat(frame_at.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return (dt.datetime.now(dt.timezone.utc) - t).total_seconds() / 60


def vision_frame_verdict(frame_at: str | None, trust_no_timestamp: bool = False) -> tuple[bool, str | None]:
    """(score_it, reason_if_not) for a FEED cam's frame, by its latest.json time.
    PURE. See the VISION_MAX_FRAME_AGE_MIN note: -5 min <= age <= 60 min is scored;
    older, or further ahead than 5 min, is not; a missing or unparsable time is not,
    unless the cam opts in with visionTrustNoTimestamp."""
    age = _frame_age_min(frame_at) if frame_at else None
    if age is None:
        if trust_no_timestamp:
            return True, None
        return False, "no frame timestamp \u2014 not scored"
    if age < -VISION_MAX_FUTURE_MIN:
        return False, f"frame is {-age:.0f} min in the future"
    if age > VISION_MAX_FRAME_AGE_MIN:
        return False, f"frame is {age:.0f} min old"
    return True, None


def archive_frame(slug: str, cam_id: str, img: bytes, frame_at: str | None = None) -> str:
    """POST one cam still to the webcam archive. BEST-EFFORT: never raises.

    Sends the raw JPEG to ARCHIVE_URL?slug=..&cam=..[&frameAt=..] with
    `Authorization: Bearer $INGEST_TOKEN` and a 15 s timeout. Returns a short
    status for the log and for tests:
      "no-token"        INGEST_TOKEN unset — skipped silently, nothing printed
      "skipped"         not a JPEG, outside 10-600 KB, or its own timestamp is
                        older than ARCHIVE_FRAME_MAX_AGE_MIN (the server would
                        file such a frame under "now"); nothing was sent
      "stored" / "slot-taken" / "unchanged"   the server's answer
      "http-<code>"     the server refused (401 bad token, 403/404 cam not in
                        the archive, 413, 5xx ...)
      "error"           network error, timeout, or an unreadable reply
    `frame_at` is the source's own capture time ('YYYY-MM-DDTHH:MM:SSZ'), or
    None when unknown (the server then uses its receive time).
    """
    token = os.environ.get("INGEST_TOKEN", "").strip()
    if not token:
        return "no-token"
    try:
        if not isinstance(img, (bytes, bytearray)) or bytes(img[:3]) != b"\xff\xd8\xff":
            print(f"  archive [{slug}] {cam_id}: skipped (not a JPEG)", file=sys.stderr)
            return "skipped"
        if not ARCHIVE_MIN_BYTES <= len(img) <= ARCHIVE_MAX_BYTES:
            print(f"  archive [{slug}] {cam_id}: skipped ({len(img)} bytes is outside "
                  f"{ARCHIVE_MIN_BYTES}-{ARCHIVE_MAX_BYTES})", file=sys.stderr)
            return "skipped"
        if frame_at:
            age = _frame_age_min(frame_at)
            if age is not None and age > ARCHIVE_FRAME_MAX_AGE_MIN:
                print(f"  archive [{slug}] {cam_id}: skipped (frame is {age:.0f} min old)")
                return "skipped"
        query = {"slug": slug, "cam": cam_id}
        if frame_at:
            query["frameAt"] = frame_at
        sep = "&" if "?" in ARCHIVE_URL else "?"
        req = urllib.request.Request(
            f"{ARCHIVE_URL}{sep}{urllib.parse.urlencode(query)}",
            data=bytes(img),
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "image/jpeg",
                "User-Agent": HTTP_UA,
            },
        )
        with urllib.request.urlopen(req, timeout=ARCHIVE_TIMEOUT_S) as resp:
            body = resp.read(4000)
        out = json.loads(body.decode("utf-8", "replace"))
        status = "stored" if out.get("stored") else str(out.get("reason") or "not-stored")
        print(f"  archive [{slug}] {cam_id}: {status}")
        return status
    except urllib.error.HTTPError as e:
        print(f"  warn archive [{slug}] {cam_id}: HTTP {e.code}", file=sys.stderr)
        return f"http-{e.code}"
    except Exception as e:  # noqa: BLE001 — archiving must never break the read
        print(f"  warn archive [{slug}] {cam_id}: {e}", file=sys.stderr)
        return "error"


GOLDEN_SLOT_S = 600
HOUR_SLOT_S = 3600


def _slot_utc_of(frame_at: str | None, golden: "list[tuple[dt.datetime, dt.datetime]] | None" = None) -> str:
    """The slot a frame lands in, as the server keys it ('2026-10-11T14:00:00.000Z').

    The frame's own time when that time is believable (not >5 min ahead, not >3 h
    old: the server's own rule), else "now". Inside a golden-hour window of the
    beach the slot is that time floored to 10 minutes; anywhere else it is
    floored to the UTC hour. `golden` is the list of [start, end) windows the
    pre-check returned for the beach (lib/camFrames/golden.ts decides them; this
    script only reads them). Without windows every slot is a UTC hour."""
    now = dt.datetime.now(dt.timezone.utc)
    when = now
    if frame_at:
        try:
            t = dt.datetime.fromisoformat(frame_at.replace("Z", "+00:00"))
            if t.tzinfo is None:
                t = t.replace(tzinfo=dt.timezone.utc)
            if -5 <= (now - t).total_seconds() / 60 <= 180:
                when = t
        except ValueError:
            pass
    when = when.astimezone(dt.timezone.utc)
    size = GOLDEN_SLOT_S if any(a <= when < b for a, b in (golden or ())) else HOUR_SLOT_S
    floored = int(when.timestamp() // size) * size
    return dt.datetime.fromtimestamp(floored, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:00.000Z")


def _parse_golden(raw: object) -> "list[tuple[dt.datetime, dt.datetime]]":
    """[{startUtc, endUtc}] from the pre-check reply as datetime pairs. A malformed
    entry is dropped (that window then simply counts as an hour)."""
    out: list[tuple[dt.datetime, dt.datetime]] = []
    for w in raw if isinstance(raw, list) else []:
        try:
            a = dt.datetime.fromisoformat(str(w["startUtc"]).replace("Z", "+00:00"))
            b = dt.datetime.fromisoformat(str(w["endUtc"]).replace("Z", "+00:00"))
            out.append((a, b))
        except (KeyError, TypeError, ValueError):
            continue
    return out


def fetch_filled_slots(slug: str) -> dict | None:
    """GET <ARCHIVE_URL>/slots?slug=.. . Returns
        {"slots": {slot ISO: {cam ids}}, "current": slot ISO | None, "golden": [(start, end), ...]}
    or None on ANY failure, so the caller fails open and behaves as if nothing
    were filled.

    `slots` covers the current and previous three UTC-hour slots plus every
    10-minute slot of any golden-hour window in that range (cams that are ready or
    freshly pending). `current` is the slot a frame taken at the moment of the
    reply would land in. `golden` is the beach's golden-hour windows (UTC) in that
    range, which is all this script needs to place a frame of any age with the
    server's slot rule (see _slot_utc_of). One request per beach, as before."""
    token = os.environ.get("INGEST_TOKEN", "").strip()
    if not token:
        return None
    try:
        req = urllib.request.Request(
            f"{ARCHIVE_URL.rstrip('/')}/slots?{urllib.parse.urlencode({'slug': slug})}",
            headers={"Authorization": f"Bearer {token}", "User-Agent": HTTP_UA},
        )
        with urllib.request.urlopen(req, timeout=ARCHIVE_PRECHECK_TIMEOUT_S) as resp:
            doc = json.loads(resp.read(200_000).decode("utf-8", "replace"))
        slots = doc["slots"]
        current = doc.get("currentSlotUtc")
        return {
            "slots": {str(k): {str(c) for c in v} for k, v in slots.items()},
            "current": current if isinstance(current, str) else None,
            "golden": _parse_golden(doc.get("golden")),
        }
    except Exception as e:  # noqa: BLE001 — a failed pre-check just means "upload as before"
        print(f"  warn archive pre-check [{slug}]: {e}", file=sys.stderr)
        return None


class ArchiveRun:
    """One tick's archive work: the cheap pre-check, the upload queue, and the
    overall time budget.

    * Pre-check (precheck): one GET per beach, at most 3 a tick, says which cams'
      slots are already filled (hour slots, and 10-minute slots in golden-hour windows). Filled cams are not uploaded,
      and cams only archive_pass reads are not even fetched. Fails open.
    * Queue (enqueue/flush): capture_beach hands over the JPEG it already
      fetched and moves on to the vision read; flush() uploads the queue on a
      small thread pool (ARCHIVE_WORKERS) after the beach's reads, so a slow
      upload never delays a read.
    * Budget: ARCHIVE_DEADLINE_S (90 s) of wall time across ALL archive work in
      the tick (pre-check + every flush + archive_pass). Work still unfinished
      at the deadline is dropped, and that is logged once.
    """

    def __init__(self, deadline_s: float | None = None):
        self.deadline_s = ARCHIVE_DEADLINE_S if deadline_s is None else deadline_s
        self.spent = 0.0
        self.filled: dict[str, dict] = {}  # slug -> fetch_filled_slots() reply
        self.prechecked: set[str] = set()
        self.queue: list[tuple[str, str, bytes, str | None]] = []
        self.dropped = 0
        self._logged_drop = False
        self._keys: set | None = None

    def remaining(self) -> float:
        return max(0.0, self.deadline_s - self.spent)

    def listed(self, slug: str, cam_id: str) -> bool:
        """Is the cam in the archive manifest (so archive:false cams are not)?"""
        if self._keys is None:
            self._keys = archive_keys()
        return (slug, cam_id) in self._keys

    def is_filled(self, slug: str, cam_id: str, frame_at: str | None = None) -> bool:
        """True when the slot the cam's frame would land in is known to be filled.

        That slot is the one for `frame_at` (else for "now") under the server's
        rule: 10 minutes wide inside a golden-hour window of the beach, a UTC hour
        elsewhere. The windows come from the pre-check reply, so no extra request
        is made. "Now" is read at the time of THIS call, not of the pre-check, so a
        tick that crosses a 10-minute boundary asks about the right slot. With no
        pre-check answer (it failed, or INGEST_TOKEN is unset) nothing is filled."""
        info = self.filled.get(slug)
        if not info:
            return False
        return cam_id in info["slots"].get(_slot_utc_of(frame_at, info.get("golden")), set())

    def run_bounded(self, tasks: list) -> dict:
        """Run [(label, zero-arg callable)] on a thread pool within the remaining
        budget. Returns {label: result} for the tasks that finished; the rest
        are dropped (cancelled if not started) and counted."""
        if not tasks:
            return {}
        remaining = self.remaining()
        if remaining <= 0:
            self._drop(len(tasks))
            return {}
        started = time.monotonic()
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=max(1, ARCHIVE_WORKERS))
        futures = {pool.submit(fn): label for label, fn in tasks}
        done, not_done = concurrent.futures.wait(futures, timeout=remaining)
        for f in not_done:
            f.cancel()
        pool.shutdown(wait=False, cancel_futures=True)
        self.spent += time.monotonic() - started
        if not_done:
            self._drop(len(not_done))
        results = {}
        for f in done:
            try:
                results[futures[f]] = f.result()
            except Exception as e:  # noqa: BLE001
                print(f"  warn archive [{futures[f]}]: {e}", file=sys.stderr)
                results[futures[f]] = "error"
        return results

    def _drop(self, n: int) -> None:
        self.dropped += n
        if not self._logged_drop:
            self._logged_drop = True
            print(f"  warn archive: {self.deadline_s:.0f} s budget for this tick ran out; "
                  f"dropping unfinished archive work ({n} item(s) so far)", file=sys.stderr)

    def precheck(self, slugs) -> None:
        """Ask the app which cams are already filled, once per beach (idempotent)."""
        todo = sorted(set(slugs) - self.prechecked)
        if not todo or not os.environ.get("INGEST_TOKEN", "").strip():
            return
        self.prechecked.update(todo)
        got = self.run_bounded([(slug, (lambda sl=slug: fetch_filled_slots(sl))) for slug in todo])
        for slug, slots in got.items():
            if slots is not None:
                self.filled[slug] = slots

    def enqueue(self, slug: str, cam_id: str, img: bytes, frame_at: str | None) -> bool:
        """Queue a fetched still for upload. False (nothing queued) when archiving
        is off, the cam is not in the manifest, or its slot is already filled."""
        if not os.environ.get("INGEST_TOKEN", "").strip() or not self.listed(slug, cam_id):
            return False
        if self.is_filled(slug, cam_id, frame_at):
            print(f"  archive [{slug}] {cam_id}: skipped (slot already filled)")
            return False
        self.queue.append((slug, cam_id, img, frame_at))
        return True

    def flush(self) -> dict:
        """Upload everything queued, concurrently, within the budget."""
        items, self.queue = self.queue, []
        return self.run_bounded([
            (f"{s}/{c}", (lambda s=s, c=c, i=i, f=f: archive_frame(s, c, i, f)))
            for s, c, i, f in items
        ])


def _courier_frame_at(meta_url: str) -> str | None:
    """The courier's own capture time for a "direct" cam, from its /meta URL,
    or None unless the meta says `ok` is true, carries a parseable
    grabbedAtUtc, and that frame is no older than ARCHIVE_FRAME_MAX_AGE_MIN.
    The age check happens HERE, before the JPEG is downloaded: a courier frame
    whose age cannot be established, or is too old, is not worth fetching."""
    try:
        meta = json.loads(_get(meta_url, timeout=15).decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        print(f"  warn archive meta {meta_url}: {e}", file=sys.stderr)
        return None
    if not isinstance(meta, dict) or meta.get("ok") is not True:
        return None
    grabbed = meta.get("grabbedAtUtc")
    if not isinstance(grabbed, str):
        return None
    age = _frame_age_min(grabbed)
    if age is None or age > ARCHIVE_FRAME_MAX_AGE_MIN:
        return None
    return grabbed


def archive_pass(attempted: set, cams: list[dict] | None = None, run: "ArchiveRun | None" = None) -> dict:
    """Fetch + archive every manifest cam the vision loop did NOT already fetch
    this tick (`attempted` is a set of (slug, cam id) the vision/underwater paths
    went after, whether or not the fetch worked, so a broken cam is not hit
    twice). Runs on EVERY tick, whether or not a vision provider is configured.
    Does nothing when INGEST_TOKEN is unset (no point fetching stills nobody
    will keep).

    Before fetching a cam it asks the pre-check (see ArchiveRun) whether the
    cam's slot is already filled and skips the fetch if so; for courier cams it
    reads /meta first and skips the download of a frame that is stale, or whose
    own hour is already filled. Cams run on a small thread pool inside the tick's
    archive budget; one cam failing never affects another.

    Returns {"attempted": n, "results": {"slug/cam": status, ...}}."""
    if not os.environ.get("INGEST_TOKEN", "").strip():
        return {"attempted": 0, "results": {}, "skipped": "INGEST_TOKEN unset"}
    run = run or ArchiveRun()
    manifest = load_archive_cams() if cams is None else cams
    run.precheck({c["slug"] for c in manifest})
    todo = [c for c in manifest if (c["slug"], c["id"]) not in attempted]
    feed_cache: dict = {}

    def one(cam: dict) -> str:
        slug, cam_id = cam["slug"], cam["id"]
        try:
            if run.is_filled(slug, cam_id):
                print(f"  archive [{slug}] {cam_id}: skipped (slot already filled)")
                return "filled"
            src = cam.get("source") or {}
            frame_at = None
            if src.get("kind") == "direct" and src.get("meta"):
                frame_at = _courier_frame_at(src["meta"])
                if frame_at is None:
                    print(f"  archive [{slug}] {cam_id}: skipped (no usable meta)")
                    return "skipped"
                if run.is_filled(slug, cam_id, frame_at):
                    print(f"  archive [{slug}] {cam_id}: skipped (slot already filled)")
                    return "filled"
            info: dict = {}
            img = fetch_still(cam, info, feed_cache)
            frame_at = frame_at or info.get("frameAt")
            if run.is_filled(slug, cam_id, frame_at):
                print(f"  archive [{slug}] {cam_id}: skipped (slot already filled)")
                return "filled"
            return archive_frame(slug, cam_id, img, frame_at)
        except Exception as e:  # noqa: BLE001
            print(f"  warn archive [{slug}] {cam_id}: {e}", file=sys.stderr)
            return "error"

    results = run.run_bounded([(f"{c['slug']}/{c['id']}", (lambda c=c: one(c))) for c in todo])
    for c in todo:
        attempted.add((c["slug"], c["id"]))
    return {"attempted": len(todo), "results": results, "dropped": run.dropped}


def _post(url: str, body: bytes, headers: dict | None = None, timeout: int = 40) -> bytes:
    """POST JSON, retrying transient quota (429) / overload (5xx) with backoff."""
    hdrs = {"Content-Type": "application/json", "User-Agent": HTTP_UA, **(headers or {})}
    delay = 2.0
    for attempt in range(MAX_RETRIES + 1):
        req = urllib.request.Request(url, data=body, headers=hdrs)
        try:
            return urllib.request.urlopen(req, timeout=timeout).read()
        except urllib.error.HTTPError as e:
            # Surface the provider's error detail (e.g. API_KEY_INVALID vs quota).
            detail = e.read().decode("utf-8", "replace")[:200]
            # A DAILY quota that is already spent will not come back in a few
            # seconds of backoff: retrying only stalls the whole run (~25 s per
            # cam on 2026-09-14). Fail this provider at once so the chain moves
            # on to the next model/provider; per-minute limits still get retried.
            if e.code == 429 and "current quota" in detail:
                raise RuntimeError(f"HTTP 429 (daily quota spent): {detail[:120]}") from None
            if e.code in RETRY_STATUSES and attempt < MAX_RETRIES:
                time.sleep(delay + random.uniform(0, 0.75))
                delay *= 2.2
                continue
            raise RuntimeError(f"HTTP {e.code}: {detail}") from None
        except urllib.error.URLError as e:
            if attempt < MAX_RETRIES:
                time.sleep(delay + random.uniform(0, 0.75))
                delay *= 2.2
                continue
            raise RuntimeError(f"network error: {e}") from None
    raise RuntimeError("unreachable")  # pragma: no cover


def _extract_json(text: str) -> dict:
    """Parse a model's text reply into JSON, tolerating ```json fences / prose."""
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*", "", t).rstrip("`").strip()
    i, j = t.find("{"), t.rfind("}")
    if i != -1 and j > i:
        t = t[i : j + 1]
    return json.loads(t)


def _pct(v: object) -> int | None:
    """A 0-100 integer percent, or None when missing/invalid."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return max(0, min(100, int(round(v))))


def _parse_out(out: dict) -> dict:
    """Validate a raw model reply and normalize to our reading shape."""
    sw = str(out.get("seaweed", "")).lower()
    if sw not in SEAWEED:
        raise ValueError(f"bad seaweed: {sw!r}")
    cr = str(out.get("crowd", "")).lower()
    people = out.get("people")
    return {
        "level": sw,
        "coveragePct": _pct(out.get("seaweed_pct")),  # 0-100 coverage, refines the score
        "note": str(out.get("seaweed_note", ""))[:80],
        "crowd": cr if cr in CROWD else None,
        "crowdPct": _pct(out.get("crowd_pct")),  # 0-100 fullness
        "people": int(people) if isinstance(people, (int, float)) else None,
        "crowdNote": str(out.get("crowd_note", ""))[:80],
        # Water clarity is best-effort: not every frame shows open water, so an
        # unrecognized/unknown grade simply becomes None rather than an error.
        "water": wt if (wt := str(out.get("water", "")).lower()) in WATER else None,
        "waterPct": _pct(out.get("water_pct")),  # 0-100, 100 = crystal clear
        "waterNote": str(out.get("water_note", ""))[:80],
    }


def _parse_uw(out: dict) -> dict:
    """Validate a raw underwater reply and normalize to our uw reading shape."""
    cl = str(out.get("uw_clarity", "")).lower()
    if cl not in UW_CLARITY:
        raise ValueError(f"bad uw_clarity: {cl!r}")
    return {
        "level": cl,
        "pct": _pct(out.get("uw_pct")),  # 0-100 visibility, 100 = gin-clear; None at night
        "note": str(out.get("uw_note", ""))[:80],
    }


def _gemini_out(img: bytes, prompt: str = PROMPT, model: str | None = None) -> dict:
    model = model or MODEL
    body = json.dumps({
        "contents": [{"parts": [
            {"text": prompt},
            {"inline_data": {"mime_type": "image/jpeg",
                             "data": base64.b64encode(img).decode()}},
        ]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }).encode()
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model}:generateContent?key={API_KEY}")
    resp = json.loads(_post(url, body))
    return _extract_json(resp["candidates"][0]["content"]["parts"][0]["text"])


def _openai_out(cfg: dict, img: bytes, prompt: str = PROMPT) -> dict:
    """One adapter for every OpenAI chat-compatible vision API (Groq/OpenRouter/GitHub)."""
    data_uri = "data:image/jpeg;base64," + base64.b64encode(img).decode()
    body = json.dumps({
        "model": cfg["model"],
        "temperature": 0,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": data_uri}},
        ]}],
    }).encode()
    resp = json.loads(_post(cfg["url"], body, headers={"Authorization": f"Bearer {cfg['key']}"}))
    return _extract_json(resp["choices"][0]["message"]["content"])


def _enabled_providers() -> list[tuple[str, str]]:
    """[(name, model)] for each configured provider, in fallback order."""
    out = []
    for name in PROVIDER_ORDER:
        if name == "gemini":
            if API_KEY:
                for m in GEMINI_MODELS:
                    out.append((name, m))
        elif name in OPENAI_PROVIDERS and OPENAI_PROVIDERS[name]["key"]:
            out.append((name, OPENAI_PROVIDERS[name]["model"]))
    return out


def _provider_configured(name: str) -> bool:
    if name == "gemini":
        return bool(API_KEY)
    cfg = OPENAI_PROVIDERS.get(name)
    return bool(cfg and cfg["key"])


# Vision calls made this process, {(provider, model): [ok, failed]}. Every attempt
# counts (a failed one usually still spent quota). Printed once a tick by
# vision_call_summary() so exhaustion of a free tier is visible in the run log.
_VISION_CALLS: dict[tuple[str, str], list[int]] = {}
_VISION_CALLS_LOCK = threading.Lock()


def _count_vision_call(name: str, model: str | None, ok: bool) -> None:
    with _VISION_CALLS_LOCK:
        _VISION_CALLS.setdefault((name, model or "?"), [0, 0])[0 if ok else 1] += 1


def vision_call_summary() -> str:
    """One line: 'vision calls this tick: gemini/gemini-2.5-flash ok=3 failed=0; ...',
    or '... none' when no vision call was made."""
    with _VISION_CALLS_LOCK:
        items = sorted(_VISION_CALLS.items())
    if not items:
        return "vision calls this tick: none"
    parts = [f"{n}/{m} ok={ok} failed={bad}" for (n, m), (ok, bad) in items]
    total = sum(ok + bad for _, (ok, bad) in items)
    return f"vision calls this tick: {total} total; " + "; ".join(parts)


def assess_with(name: str, img: bytes, prompt: str = PROMPT, parse=_parse_out,
                model: str | None = None) -> dict:
    """Read one image with exactly ONE named provider (for per-provider eval).

    `prompt`/`parse` let the same provider plumbing serve both the beach read
    (default) and the underwater read (UW_PROMPT + _parse_uw)."""
    if name == "gemini":
        if not API_KEY:
            raise RuntimeError("gemini not configured")
        model = model or MODEL
        call = lambda: _gemini_out(img, prompt, model)  # noqa: E731
    else:
        cfg = OPENAI_PROVIDERS.get(name)
        if not cfg or not cfg["key"]:
            raise RuntimeError(f"{name} not configured")
        model = cfg["model"]
        call = lambda: _openai_out(cfg, img, prompt)  # noqa: E731
    try:
        raw = call()
        result = parse(raw)
    except Exception:
        _count_vision_call(name, model, False)
        raise
    _count_vision_call(name, model, True)
    result["provider"] = name
    result["model"] = model
    return result


def assess(img: bytes, prompt: str = PROMPT, parse=_parse_out) -> dict:
    """Read one image, falling through the provider chain until one succeeds."""
    errors = []
    for name, model in _enabled_providers():
        try:
            return assess_with(name, img, prompt, parse, model)
        except Exception as e:  # noqa: BLE001 — try the next provider
            errors.append(f"{name}/{model}: {str(e)[:160]}")
    if not errors:
        raise RuntimeError("no vision providers configured (set GEMINI_API_KEY or another key)")
    raise RuntimeError("all vision providers failed -> " + " | ".join(errors))


def assess_uw(img: bytes) -> dict:
    """Read the underwater frame through the SAME provider chain, own prompt/parser."""
    return assess(img, UW_PROMPT, _parse_uw)


def capture_uw(now_local: dt.datetime, attempted: set | None = None,
               archive: "ArchiveRun | None" = None) -> dict | None:
    """Grab + read one underwater frame; fail-soft to None so the cam flow is safe.

    Returns {level, pct, note, capturedAtLocal, provider, model} or None on ANY
    failure (unreachable stream, IP block, no providers, bad frame, timeout).

    The frame is also handed to the webcam archive (Spinner follows this fetch
    path, not capture_beach's): queued BEFORE the vision read so it is kept even
    when the read fails, and uploaded after the read, so the upload never delays
    it. `attempted` (optional) is told Spinner was fetched, so archive_pass()
    does not fetch it a second time this tick."""
    run = archive if archive is not None else ArchiveRun()
    try:
        if attempted is not None:
            attempted.add((UW_ARCHIVE_SLUG, UW_ARCHIVE_CAM_ID))
        frame, frame_at = fetch_uw_frame_timed()
        run.enqueue(UW_ARCHIVE_SLUG, UW_ARCHIVE_CAM_ID, frame, frame_at)
        r = assess_uw(frame)
    except Exception as e:  # noqa: BLE001 — underwater is best-effort calibration only
        print(f"  warn underwater cam: {e}", file=sys.stderr)
        return None
    finally:
        run.flush()
    print(f"  underwater: clarity={r['level']}({r.get('pct')}%) via {r.get('provider')}")
    return {
        "level": r["level"],
        "pct": r.get("pct"),
        "note": r.get("note"),
        "capturedAtLocal": now_local.isoformat(timespec="minutes"),
    }


def busiest_crowd(group: dict | None) -> dict | None:
    """Aggregate a capture's per-cam crowd into the busiest reading."""
    cams = [c for c in (group or {}).get("cams", []) if c.get("crowd") in CROWD_RANK]
    if not cams:
        return None
    # Busiest by category, tie-broken by crowd_pct then people.
    b = max(cams, key=lambda c: (CROWD_RANK[c["crowd"]],
                                 c.get("crowdPct") or -1, c.get("people") or -1))
    return {"level": b["crowd"], "people": b.get("people"), "crowdPct": b.get("crowdPct")}


def worst_seaweed(group: dict | None) -> dict | None:
    """The worst seaweed across a capture's cams: {level, pct} (rank, then coverage)."""
    cams = [c for c in (group or {}).get("cams", []) if c.get("level") in SEAWEED_RANK]
    if not cams:
        return None
    b = max(cams, key=lambda c: (SEAWEED_RANK[c["level"]], c.get("coveragePct") or -1))
    return {"level": b["level"], "pct": b.get("coveragePct")}


def median_water(group: dict | None) -> dict | None:
    """The MEDIAN water clarity across a capture's cams: {level, pct}.

    CALIBRATED 2026-07-24 against owner in-water ground truth: cams read
    25/65/85 while the owner (swimming at Boca that minute) estimated 75%
    clear. Worst-of published 25 — a single angle contaminated by floating
    seaweed patches (a separate signal) dragged the whole reading down.
    Per-angle clarity noise is mostly DOWNWARD (seaweed patches, sun glare,
    breaking whitewater), so worst-of is the wrong estimator here; the median
    (65 that tick) landed within 10 pts of truth. Cams whose frame shows no
    open water report water=None and are skipped. The categorical level is
    taken from the cam whose pct is closest to the median pct."""
    cams = [c for c in (group or {}).get("cams", []) if c.get("water") in WATER_RANK]
    if not cams:
        return None
    with_pct = [c for c in cams if c.get("waterPct") is not None]
    if not with_pct:
        # No numeric pcts — fall back to the median-ranked categorical grade.
        ranked = sorted(cams, key=lambda c: WATER_RANK[c["water"]])
        mid = ranked[len(ranked) // 2]
        return {"level": mid["water"], "pct": None}
    pcts = sorted(c["waterPct"] for c in with_pct)
    n = len(pcts)
    med = pcts[n // 2] if n % 2 else round((pcts[n // 2 - 1] + pcts[n // 2]) / 2)
    closest = min(with_pct, key=lambda c: abs(c["waterPct"] - med))
    return {"level": closest["water"], "pct": med}


def fetch_prev(slug: str) -> dict:
    """The beach's last published file: "<PREV_BASE>/cam_seaweed.<slug>.json".
    For LEGACY_SLUG only, falls back to the pre-split "cam_seaweed.json" if the
    per-beach file 404s (an old sargassum-data branch commit, or the very first
    run of this per-beach version). Any other slug that 404s just starts fresh
    — {} — same as it always has for a brand-new beach."""
    try:
        return json.loads(_get(f"{PREV_BASE}/cam_seaweed.{slug}.json").decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        if slug != LEGACY_SLUG:
            return {}
        try:
            return json.loads(_get(f"{PREV_BASE}/cam_seaweed.json").decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            return {}


def capture_beach(
    slug: str, cams: list[dict], now_local: dt.datetime, gap_state: dict, prev: dict,
    attempted: set | None = None, archive: "ArchiveRun | None" = None,
) -> dict | None:
    """Read every cam configured for one beach. `gap_state` is a single
    {"called": bool} shared across ALL beaches in this run, so CAM_GAP_S spaces
    EVERY call in the whole run (not just within one beach) — quota math is
    per-run, not per-beach (see the module docstring / DECISIONS #2). `prev` is
    this beach's previously published document (see fetch_prev()) — read for
    the freshness/dedupe check on "direct" cams that carry a "meta" URL.

    Webcam archive: each still fetched here is also queued for the archive
    (fetch_still -> queue -> assess), so it is archived even when the read fails
    and never fetched twice. The vision read does NOT wait for the upload: the
    queue is uploaded concurrently (thread pool) after this beach's reads, within
    the tick's archive budget (see ArchiveRun). `attempted` (optional) is a set
    that collects (slug, cam id) of every cam this function goes after;
    archive_pass() uses it to fetch only the rest. `archive` (optional) is the
    tick's shared ArchiveRun; without one this call uses its own."""
    run = archive if archive is not None else ArchiveRun()
    readings = []
    for cam in cams:
        src = cam.get("source") or {}
        frame_at = None
        if src.get("kind") == "direct" and src.get("meta"):
            # A courier-fed "direct" cam: check its meta before spending a
            # vision call — skip a frame that's stale or one we already scored
            # (the courier refreshes on a multi-hour cadence; this job runs
            # every ~10 min, so most ticks see the identical frame).
            try:
                meta = json.loads(_get(src["meta"], timeout=15).decode("utf-8", "replace"))
            except Exception as e:  # noqa: BLE001 — treat as "no meta"
                meta = None
                print(f"  warn [{slug}] {cam['id']} meta: {e}", file=sys.stderr)
            decision = direct_cam_decision(
                meta, prev_frame_at_for_cam(prev, cam["id"]), dt.datetime.now(dt.timezone.utc))
            if decision["skip"]:
                print(f"  [{slug}] {cam['id']}: skipped ({decision['reason']})")
                continue
            frame_at = decision["frameAt"]

        try:
            if attempted is not None:
                attempted.add((slug, cam["id"]))
            info: dict = {}
            img = fetch_still(cam, info)
            run.enqueue(slug, cam["id"], img, frame_at or info.get("frameAt"))
            # A FEED frame is scored only when its own timestamp says it is live
            # (see vision_frame_verdict). Otherwise: no assess() call and no
            # reading (the cam is simply absent from this tick's `cams`, like a
            # skipped courier cam). Courier cams were judged above, by their meta.
            is_feed = (cam.get("source") or {}).get("kind", "feed") == "feed"
            if is_feed and not frame_at:
                ok, why = vision_frame_verdict(
                    info.get("frameAt"), cam.get("visionTrustNoTimestamp") is True)
                if not ok:
                    if why.startswith("no frame timestamp"):
                        print(f"  WARN [{slug}] {cam['id']}: {why} (set visionTrustNoTimestamp "
                              "on the cam in config/vision-cams.json only if this source never has one)",
                              file=sys.stderr)
                    else:
                        print(f"  [{slug}] {cam['id']}: skipped ({why})")
                    continue
            # SAME FRAME ALREADY SCORED (feed cams): a feed view refreshes every
            # ~10-30 min but this loop ticks every 10, so most ticks see a frame
            # we already read. Skip it, as a courier cam is skipped on an
            # unchanged meta. Absent from the tick's cams, exactly like a skipped
            # courier cam. The fingerprint is recorded only on a SUCCESSFUL read
            # (reading["frameSha"] -> build_beach_output), so a failed read is
            # retried next tick.
            sha = None
            if is_feed and not frame_at:
                sha = frame_sha(img)
                if sha == prev_scored_sha_for_cam(prev, cam["id"]):
                    print(f"  [{slug}] {cam['id']}: skipped (same frame already scored)")
                    continue
            # The gap spaces vision API calls, so it sits here, after the fetch
            # and the freshness check: a skipped or failed cam spends no quota.
            if gap_state["called"]:
                time.sleep(CAM_GAP_S)  # space calls to respect the per-minute limit
            gap_state["called"] = True
            r = assess(img)
            reading = {"id": cam["id"], "name": cam["name"], **r}
            if frame_at:
                reading["frameAt"] = frame_at
            if sha:
                reading["frameSha"] = sha
            readings.append(reading)
            print(f"  [{slug}] {cam['id']}: seaweed={r['level']}({r.get('coveragePct')}%) "
                  f"crowd={r.get('crowd')}({r.get('crowdPct')}%) "
                  f"people={r.get('people')} via {r.get('provider')}")
        except Exception as e:  # noqa: BLE001
            print(f"  warn [{slug}] {cam['id']}: {e}", file=sys.stderr)
    run.flush()  # the beach's reads are done: upload its stills now
    if not readings:
        return None
    return {"capturedAtLocal": now_local.isoformat(timespec="minutes"),
            "hour": now_local.hour, "cams": readings}


def build_beach_output(
    slug: str, tz_name: str, now_local: dt.datetime, providers: list[tuple[str, str]],
    prev: dict, current: dict | None, uw: dict | None, uw_reading: dict | None,
) -> dict:
    """Assemble one beach's cam_seaweed.<slug>.json document — the exact shape
    this script has always written, just computed per-beach now. `uw`/
    `uw_reading` are the ONE shared underwater read for this whole run (see
    main()), not per-beach."""
    today = now_local.date().isoformat()
    prev_morning = prev.get("morning") if prev.get("dateLocal") == today else None

    # The earliest morning (pre-tractor) reading of the day is authoritative.
    morning = prev_morning
    if current and current["hour"] in MORNING:
        if not prev_morning or current["hour"] < prev_morning.get("hour", 99):
            morning = current
    latest = current or prev.get("latest")

    # Rolling RAW history of cam reads -> the app derives all four views from it:
    # busyness by-hour & by-day, and seaweed by-hour & by-day. Each entry records
    # the busiest crowd and the worst seaweed seen across the cams in that capture,
    # plus the local timestamp/hour so the app can bucket by hour and by date.
    history = prev.get("history") if isinstance(prev.get("history"), list) else []
    if current:
        crowd = busiest_crowd(current) or {}
        ws = worst_seaweed(current) or {}
        wc = median_water(current) or {}
        entry = {
            "t": current["capturedAtLocal"],
            "hour": current["hour"],
            "level": crowd.get("level"),       # busiest crowd across the cams
            "people": crowd.get("people"),
            "crowdPct": crowd.get("crowdPct"),  # 0-100 fullness (busiest cam)
            "seaweed": ws.get("level"),         # worst seaweed across the cams
            "cov": ws.get("pct"),               # 0-100 seaweed coverage (worst cam)
            "water": wc.get("level"),           # MEDIAN water clarity across the cams
            "clr": wc.get("pct"),               # 0-100 clarity (100 = crystal clear)
        }
        # SPARSE underwater fields — present ONLY on the ~hourly ticks that
        # actually ran an underwater read, so we can later correlate surface
        # `clr` vs underwater `uw` for calibration. Absent on every other tick.
        if uw_reading:
            entry["uw"] = uw_reading.get("pct")       # 0-100 underwater visibility
            entry["uwLevel"] = uw_reading.get("level")  # clear|slightly_hazy|hazy|murky
        # SPARSE per-cam frameAt — present only for "direct" cams that carry a
        # "meta" URL and were actually read this tick (see capture_beach's
        # direct_cam_decision call). The NEXT run's prev_frame_at_for_cam()
        # scans this back out of history to dedupe against the same frame.
        frames = {c["id"]: c["frameAt"] for c in current["cams"] if c.get("frameAt")}
        if frames:
            entry["frames"] = frames
        history = history + [entry]
        # No cap — keep every raw read forever. Growth is trivial: ~60 reads/day ×
        # ~110 bytes ≈ 7 KB/day ≈ 2.4 MB/year, negligible for years. The full
        # archive is wanted for future seasonality work. NOTE: this is only the
        # RAW retention; the app's vs-average baselines still cap their own
        # lookback at 56 days (see lib/vsAverage.ts), so "average" stays anchored
        # to the recent season rather than drifting across all of history.

    # Fingerprint of the last frame each FEED cam scored successfully (see
    # capture_beach's "same frame already scored"). Carried forward from prev for
    # a cam that was skipped or failed this tick; overwritten only by a reading
    # that actually succeeded. Kept as a small top-level map, NOT in history[],
    # so the file does not grow with every tick.
    frame_shas = dict(prev.get("frameShas")) if isinstance(prev.get("frameShas"), dict) else {}
    if current:
        for c in current["cams"]:
            if c.get("frameSha"):
                frame_shas[c["id"]] = c["frameSha"]

    now_iso = (dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
               .isoformat().replace("+00:00", "Z"))
    return {
        # Bump the timestamp only on a fresh capture; otherwise keep prev's so a
        # failed run that re-publishes the last good data doesn't look "fresh".
        "generatedAt": now_iso if current else (prev.get("generatedAt") or now_iso),
        # Label with the providers actually in play (each reading also records the
        # exact provider/model that produced it). Keep prev's label on a no-op run.
        "model": (",".join(n for n, _ in providers) if current
                  else prev.get("model")) or (providers[0][1] if providers else None),
        "tz": tz_name,
        "dateLocal": today,
        "morning": morning,  # earliest pre-cleaning reading (highest weight)
        "latest": latest,    # most recent reading (current beach state)
        # Latest underwater sea-cam read {level, pct, note, capturedAtLocal} —
        # ONE shared calibration signal, same value on every beach's file;
        # carried forward on ticks that skip the ~hourly underwater read. None
        # until the first successful underwater grab.
        "uw": uw,
        # [{t, hour, level(crowd), people, seaweed, ..., uw?, uwLevel?}] -> by-hour
        # & by-day charts; uw/uwLevel present only on ticks that read underwater.
        "history": history,
        # {cam id: fingerprint} of the last feed frame each cam scored — the
        # next run's "same frame already scored" check reads it back.
        "frameShas": frame_shas,
    }


# --- run window (which ticks the workflow loop spends) -----------------------
# The workflow loop (.github/workflows/sargassum.yml) used to decide "is it
# daylight" with a fixed local clock window (05:55-20:05 America/New_York). A
# June sunset is about 8:15 PM EDT, so the reader stopped before the last golden
# light. The loop now asks THIS script: `python scripts/cam_seaweed.py
# --window-state` prints one word:
#   day      from the earliest sunrise - 30 min to the latest sunset + 30 min,
#            across the beaches in the archive manifest (each beach on its own
#            local date): the loop reads;
#   dusk     the 20 minutes after `day` ends: a loop that STARTS then still owes
#            the one carry-forward read for the night;
#   night    any other time: the loop idles;
#   unknown  the window could not be computed (no manifest, no coordinates): the
#            workflow falls back to its fixed clock window.
# Sunrise and sunset are the NOAA solver already in scripts/sun_cam_check.py (a
# port of lib/sources/sun.ts, so these times equal the app's own).
RUN_WINDOW_BEFORE_MIN = 30
RUN_WINDOW_AFTER_MIN = 30
RUN_DUSK_GRACE_MIN = 20


def _sun_times_for(lat: float, lon: float, day: "dt.date") -> dict:
    """sun_cam_check.sun_times(), imported on demand (it sits next to this file)."""
    here = os.path.dirname(os.path.abspath(__file__))
    if here not in sys.path:
        sys.path.insert(0, here)
    import sun_cam_check  # noqa: PLC0415 — lazy: only the run-window check needs it
    return sun_cam_check.sun_times(lat, lon, day)


def run_window(cams: list[dict], now: dt.datetime) -> "tuple[dt.datetime, dt.datetime] | None":
    """(start, end) of today's reading window as UTC datetimes: the earliest
    sunrise minus RUN_WINDOW_BEFORE_MIN to the latest sunset plus
    RUN_WINDOW_AFTER_MIN over the beaches of `cams` (manifest entries with slug,
    timezone, lat, lon), each on its own local date. A beach with no sunrise or
    sunset that day (polar), or without coordinates or a usable timezone, adds
    nothing. None when no beach gives a window."""
    now_utc = now if now.tzinfo else now.replace(tzinfo=dt.timezone.utc)
    starts: list[dt.datetime] = []
    ends: list[dt.datetime] = []
    seen: set[str] = set()
    for c in cams:
        slug = c.get("slug")
        if slug in seen:
            continue
        seen.add(slug)
        try:
            lat, lon = float(c["lat"]), float(c["lon"])
            local_day = now_utc.astimezone(ZoneInfo(c.get("timezone") or DEFAULT_TZ_NAME)).date()
            t = _sun_times_for(lat, lon, local_day)
        except Exception as e:  # noqa: BLE001 — one odd beach must not blank the window
            print(f"  warn run window [{slug}]: {e}", file=sys.stderr)
            continue
        if t.get("sunrise") and t.get("sunset"):
            starts.append(t["sunrise"] - dt.timedelta(minutes=RUN_WINDOW_BEFORE_MIN))
            ends.append(t["sunset"] + dt.timedelta(minutes=RUN_WINDOW_AFTER_MIN))
    if not starts or not ends:
        return None
    return min(starts), max(ends)


def window_state(now: "dt.datetime | None" = None, cams: "list[dict] | None" = None) -> str:
    """'day', 'dusk', 'night' or 'unknown' (see the run-window note above)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    window = run_window(load_archive_cams() if cams is None else cams, now)
    if window is None:
        return "unknown"
    start, end = window
    if start <= now < end:
        return "day"
    if end <= now < end + dt.timedelta(minutes=RUN_DUSK_GRACE_MIN):
        return "dusk"
    return "night"


def window_state_main() -> int:
    """`--window-state`: print the state on stdout (the workflow reads it) and the
    window itself on stderr (for the log). Always exits 0; the caller treats
    anything but day/dusk/night as "unknown"."""
    try:
        now = dt.datetime.now(dt.timezone.utc)
        cams = load_archive_cams()
        window = run_window(cams, now)
        state = window_state(now, cams)
        if window:
            print(f"run window {window[0].strftime('%H:%MZ')}-{window[1].strftime('%H:%MZ')} -> {state}", file=sys.stderr)
        print(state)
    except Exception as e:  # noqa: BLE001
        print(f"  warn run window: {e}", file=sys.stderr)
        print("unknown")
    return 0


def _run_archive_pass(attempted: set, run: "ArchiveRun | None" = None) -> None:
    """archive_pass() that can never fail the cycle (a red cycle counts toward
    the workflow loop's consecutive-failure bail-out)."""
    try:
        out = archive_pass(attempted, run=run)
        if out.get("skipped"):
            print(f"archive: skipped ({out['skipped']})")
        else:
            print(f"archive: pass over {out['attempted']} cam(s) the vision loop did not fetch")
    except Exception as e:  # noqa: BLE001
        print(f"  warn archive pass: {e}", file=sys.stderr)


def main() -> int:
    with _VISION_CALLS_LOCK:
        _VISION_CALLS.clear()
    registry = load_registry()
    # (slug, cam id) of every cam the vision/underwater paths go after this tick;
    # archive_pass() archives the manifest cams NOT in here.
    attempted: set[tuple[str, str]] = set()
    # The tick's shared archive state: pre-check answers, upload queue, time budget.
    archive_run = ArchiveRun()
    if not registry:
        print("no beaches in vision-cams registry — nothing to do", file=sys.stderr)
        _run_archive_pass(attempted, archive_run)  # the archive does not depend on the vision registry
        return 0
    try:
        # One GET per beach (<= 3 a tick): which cams' hour slot is already filled.
        archive_run.precheck({c["slug"] for c in load_archive_cams()})
    except Exception as e:  # noqa: BLE001 — fails open: archive as if nothing were filled
        print(f"  warn archive pre-check: {e}", file=sys.stderr)

    providers = _enabled_providers()
    if providers:
        print(f"vision providers (in order): {', '.join(n for n, _ in providers)}")
    else:
        print("no vision providers configured — preserving any existing readings",
              file=sys.stderr)

    now_by_slug = {
        slug: dt.datetime.now(ZoneInfo(entry.get("timezone", DEFAULT_TZ_NAME)))
        for slug, entry in registry.items()
    }
    prevs = {slug: fetch_prev(slug) for slug in registry}

    # One capture pass over every beach's cams. gap_state is shared so
    # CAM_GAP_S spaces every call across the WHOLE run, not just within one
    # beach — the quota math (DECISIONS #2) is a per-run budget.
    gap_state = {"called": False}
    current_by_slug: dict[str, dict | None] = {}
    for slug, entry in registry.items():
        if providers:
            current_by_slug[slug] = capture_beach(
                slug, entry.get("cams", []), now_by_slug[slug], gap_state, prevs[slug],
                attempted, archive_run)
        else:
            current_by_slug[slug] = None

    # UNDERWATER read — AT MOST ONCE PER RUN (not per beach; see module
    # docstring), quota-gated to at most once per hour, during daylight only
    # (dark underwater at night). Gating is by AGE of the previous uw read
    # (>= 50 min), NOT by wall-clock minute: GitHub throttles the */10 cron to
    # roughly hourly at unpredictable minutes (observed 2026-07-23), so a
    # minute<10 gate almost never fired. Age-based gating attempts on ~every
    # throttled tick (~11/day) yet still caps at ~once/hour if GitHub ever
    # honors the full 10-min cadence. Every beach's local clock is currently
    # the same zone (America/New_York); we use LEGACY_SLUG's (falling back to
    # the first registered beach) to judge daylight/staleness, and carry the
    # previous uw reading forward from whichever beach's prior file has one
    # (LEGACY_SLUG preferred, since it's the long-running carrier).
    clock_slug = LEGACY_SLUG if LEGACY_SLUG in registry else next(iter(registry))
    now_local_for_uw = now_by_slug[clock_slug]
    prev_uw = None
    if prevs.get(LEGACY_SLUG, {}).get("uw"):
        prev_uw = prevs[LEGACY_SLUG]["uw"]
    else:
        for slug in registry:
            if prevs[slug].get("uw"):
                prev_uw = prevs[slug]["uw"]
                break
    uw = prev_uw
    uw_reading = None
    if providers and now_local_for_uw.hour in UW_HOURS:
        prev_uw_at = (prev_uw or {}).get("capturedAtLocal")
        uw_age_min = None
        if prev_uw_at:
            try:
                uw_age_min = (now_local_for_uw - dt.datetime.fromisoformat(prev_uw_at)).total_seconds() / 60
            except ValueError:
                uw_age_min = None  # unparseable -> treat as due
        if uw_age_min is None or uw_age_min >= 50:
            uw_reading = capture_uw(now_local_for_uw, attempted, archive_run)
            if uw_reading:
                uw = uw_reading

    # WEBCAM ARCHIVE — every manifest cam the loops above did not fetch. Runs on
    # every tick, whether or not any vision provider is configured.
    _run_archive_pass(attempted, archive_run)

    if providers:
        print(vision_call_summary())

    os.makedirs(OUT_DIR, exist_ok=True)
    wrote_any = False
    legacy_src_path = None
    for slug, entry in registry.items():
        tz_name = entry.get("timezone", DEFAULT_TZ_NAME)
        out = build_beach_output(
            slug, tz_name, now_by_slug[slug], providers,
            prevs[slug], current_by_slug[slug], uw, uw_reading,
        )

        # Non-destructive: never overwrite a beach's published feed with an
        # empty document. `latest`/`morning` already carry forward prev's good
        # data, so `out` is empty only when this run got nothing for this
        # beach AND there was no prior reading — in that case skip writing so
        # the publish step leaves that beach's last good feed untouched. If a
        # beach captured fine before but failed just this cycle, `out` still
        # carries prev's morning/latest/history forward, so its file IS
        # rewritten (unchanged) — the force-push never drops a beach.
        if not (out["morning"] or out["latest"]):
            print(f"  [{slug}] no fresh readings and no prior good data — "
                  "leaving published feed unchanged (not writing output)", file=sys.stderr)
            continue

        out_path = os.path.join(OUT_DIR, f"cam_seaweed.{slug}.json")
        with open(out_path, "w") as fh:
            json.dump(out, fh, separators=(",", ":"))
        wrote_any = True
        mh = out["morning"].get("hour") if out["morning"] else None
        fresh = "fresh" if current_by_slug[slug] else "preserved (no fresh capture this run)"
        print(f"wrote {out_path} [{fresh}]: morning={mh} latest={(out['latest'] or {}).get('hour')}")
        if slug == LEGACY_SLUG:
            legacy_src_path = out_path

    # Legacy single-file feed: for one release, keep publishing cam_seaweed.json
    # (CAM_SEAWEED_OUT) as a copy of boca-raton's file, so lib/sources/*.ts's
    # transition fallback (and any stale CDN cache still pointed at the old
    # single-file URL) keeps resolving until every reader has moved over.
    if legacy_src_path:
        with open(legacy_src_path, "rb") as src, open(OUT, "wb") as dst:
            dst.write(src.read())
        print(f"wrote legacy {OUT} (copy of {legacy_src_path})")

    if not wrote_any:
        print("no beach had fresh readings or prior data — nothing written this run",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    if "--window-state" in sys.argv[1:]:
        raise SystemExit(window_state_main())
    raise SystemExit(main())
