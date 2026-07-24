#!/usr/bin/env python3
"""
Read visible sargassum/seaweed + crowd from the close-up beach-cam stills using a
FALLBACK CHAIN of free vision APIs. Runs OFF Netlify in the Action; writes a tiny
cam_seaweed.json the web app reads. Pure stdlib (urllib/base64/json/zoneinfo).

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
At most once per hour (local minute < 10) during daylight (hours 6-20) we grab a
single frame (yt-dlp -g -> ffmpeg) and run a SEPARATE underwater-visibility
vision read through the same provider fallback chain. This ground-truths the
SURFACE water-clarity grades: later we correlate a tick's surface `clr` against
the underwater `uw`. It fully fail-softs — YouTube sometimes blocks datacenter
IPs, so if Actions can't reach the stream we simply accrue no `uw` fields and
lose nothing; the main cam flow is never affected.

Data shape (cam_seaweed.json):
  top-level `uw`: {level, pct, note, capturedAtLocal} — latest underwater read,
    carried forward on ticks that skip the underwater read (like morning/latest).
  history[]: {t, hour, level(crowd), people, crowdPct, seaweed, cov, water, clr}
    plus SPARSE `uw` (pct) + `uwLevel` fields present ONLY on the ~hourly ticks
    that actually ran an underwater read (absent otherwise).
"""
import base64
import datetime as dt
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")  # 2.0-flash has no free tier
OUT = os.environ.get("CAM_SEAWEED_OUT", "cam_seaweed.json")
TZ = ZoneInfo(os.environ.get("CAM_TZ", "America/New_York"))

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
    for p in os.environ.get("VISION_PROVIDERS", "gemini,groq,openrouter,github").split(",")
    if p.strip()
]
OPENAI_PROVIDERS = {
    "groq": {
        "url": "https://api.groq.com/openai/v1/chat/completions",
        "model": os.environ.get("GROQ_MODEL", "meta-llama/llama-4-scout-17b-16e-instruct"),
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

PREV_URL = os.environ.get(
    "CAM_SEAWEED_PREV_URL",
    "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/cam_seaweed.json",
)
# Local hours considered "morning, before/at the beach-cleaning tractor".
MORNING = range(5, 10)

CAMS = [
    {"id": "boca-inlet-surf", "name": "Boca Inlet — Surf & Shoreline",
     "feed": "http://video-monitoring.com/beachcams/bocainlet", "view": "s16"},
    {"id": "boca-south-surf", "name": "South Beach — Shoreline & Surf",
     "feed": "http://video-monitoring.com/beachcams/boca", "view": "s11"},
    # Wide pavilion + parking-lot view — the best gauge of how busy the beach is.
    {"id": "boca-south", "name": "South Beach — Pavilion & Lot",
     "feed": "http://video-monitoring.com/beachcams/boca", "view": "s4"},
]

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
# Only run the underwater read within these LOCAL hours (dark underwater at night)
# and only in the first 10 minutes of the hour, so it fires at most ~once/hour.
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
    "Water = how clear the OCEAN WATER looks where it is visible (judge color "
    "and transparency of the water beyond the breaking surf, not whitewater "
    "foam): clear=blue-green and transparent, slightly_murky=greenish with "
    "some suspended sand, murky=brown/tea-colored, churned=heavily stirred-up "
    "sand throughout. Use unknown (and water_pct null) if open water is not "
    "clearly visible in this frame. "
    "water_pct = water clarity 0-100 where 100=crystal clear and 0=opaque."
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


def fetch_still(cam: dict) -> bytes:
    if cam.get("still"):
        return _get(cam["still"])
    feed = json.loads(_get(f"{cam['feed']}/latest.json").decode("utf-8", "replace"))
    return _get(f"{cam['feed']}/{feed[cam['view']]['mr']}")


def fetch_uw_frame() -> bytes:
    """Grab a single JPEG frame from the Deerfield underwater YouTube livestream.

    Two subprocess hops: `yt-dlp -g` resolves the live HLS manifest URL (needs a
    JS runtime — node is preinstalled on GitHub ubuntu runners), then ffmpeg
    pulls one frame. Kept fully self-contained with tight timeouts (~60s total).

    CAVEAT: YouTube periodically blocks datacenter IPs, and the stream can be
    offline. EVERY failure mode here (yt-dlp missing, IP block, offline stream,
    ffmpeg error, timeout) raises — the caller catches it and the main cam flow
    is unaffected; we simply accrue no `uw` field for that tick.
    """
    # PREFERRED PATH — the frame COURIER: YouTube blocks ALL yt-dlp clients from
    # GitHub's datacenter IPs (confirmed 2026-07-24: ios/tv/default each exit 1
    # in CI while working from a residential connection), so the owner's Mac
    # grabs a frame hourly (scripts/uw_frame_local.sh via launchd) and pushes it
    # to the `uw-frames` branch. Use it when fresh (<=90 min per its meta.json).
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
                print(f"  uw: courier frame ({age_min:.0f} min old)")
                return frame
        else:
            print(f"  uw: courier frame stale ({age_min:.0f} min) — trying yt-dlp",
                  file=sys.stderr)
    except Exception as e:  # noqa: BLE001 — fall through to the direct grab
        print(f"  uw: courier unavailable ({e}) — trying yt-dlp", file=sys.stderr)

    # FALLBACK — direct grab. Works locally/residential; blocked from GitHub
    # runners, but kept so the script still works outside CI and in case the
    # ios/tv innertube clients (served different bot-checks) start passing.
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

    fd, tmp = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", manifest,
             "-frames:v", "1", tmp],
            capture_output=True, timeout=20, check=True,
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


def _gemini_out(img: bytes, prompt: str = PROMPT) -> dict:
    body = json.dumps({
        "contents": [{"parts": [
            {"text": prompt},
            {"inline_data": {"mime_type": "image/jpeg",
                             "data": base64.b64encode(img).decode()}},
        ]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }).encode()
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{MODEL}:generateContent?key={API_KEY}")
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
                out.append((name, MODEL))
        elif name in OPENAI_PROVIDERS and OPENAI_PROVIDERS[name]["key"]:
            out.append((name, OPENAI_PROVIDERS[name]["model"]))
    return out


def _provider_configured(name: str) -> bool:
    if name == "gemini":
        return bool(API_KEY)
    cfg = OPENAI_PROVIDERS.get(name)
    return bool(cfg and cfg["key"])


def assess_with(name: str, img: bytes, prompt: str = PROMPT, parse=_parse_out) -> dict:
    """Read one image with exactly ONE named provider (for per-provider eval).

    `prompt`/`parse` let the same provider plumbing serve both the beach read
    (default) and the underwater read (UW_PROMPT + _parse_uw)."""
    if name == "gemini":
        if not API_KEY:
            raise RuntimeError("gemini not configured")
        raw, model = _gemini_out(img, prompt), MODEL
    else:
        cfg = OPENAI_PROVIDERS.get(name)
        if not cfg or not cfg["key"]:
            raise RuntimeError(f"{name} not configured")
        raw, model = _openai_out(cfg, img, prompt), cfg["model"]
    result = parse(raw)
    result["provider"] = name
    result["model"] = model
    return result


def assess(img: bytes, prompt: str = PROMPT, parse=_parse_out) -> dict:
    """Read one image, falling through the provider chain until one succeeds."""
    errors = []
    for name, _model in _enabled_providers():
        try:
            return assess_with(name, img, prompt, parse)
        except Exception as e:  # noqa: BLE001 — try the next provider
            errors.append(f"{name}: {e}")
    if not errors:
        raise RuntimeError("no vision providers configured (set GEMINI_API_KEY or another key)")
    raise RuntimeError("all vision providers failed -> " + " | ".join(errors))


def assess_uw(img: bytes) -> dict:
    """Read the underwater frame through the SAME provider chain, own prompt/parser."""
    return assess(img, UW_PROMPT, _parse_uw)


def capture_uw(now_local: dt.datetime) -> dict | None:
    """Grab + read one underwater frame; fail-soft to None so the cam flow is safe.

    Returns {level, pct, note, capturedAtLocal, provider, model} or None on ANY
    failure (unreachable stream, IP block, no providers, bad frame, timeout)."""
    try:
        r = assess_uw(fetch_uw_frame())
    except Exception as e:  # noqa: BLE001 — underwater is best-effort calibration only
        print(f"  warn underwater cam: {e}", file=sys.stderr)
        return None
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


def murkiest_water(group: dict | None) -> dict | None:
    """The murkiest water clarity across a capture's cams: {level, pct}.

    Worst-of wins (like seaweed): a single cam angle showing churned water is
    the honest read for a swimmer. Cams whose frame shows no open water report
    water=None and are skipped; pct is 0-100 with 100 = crystal clear, so the
    murkiest cam is the one with the LOWEST pct (rank first, pct as tiebreak)."""
    cams = [c for c in (group or {}).get("cams", []) if c.get("water") in WATER_RANK]
    if not cams:
        return None
    b = max(cams, key=lambda c: (WATER_RANK[c["water"]],
                                 -(c.get("waterPct") if c.get("waterPct") is not None else 101)))
    return {"level": b["water"], "pct": b.get("waterPct")}


def fetch_prev() -> dict:
    try:
        return json.loads(_get(PREV_URL).decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return {}


def capture_now(now_local: dt.datetime) -> dict | None:
    readings = []
    for i, cam in enumerate(CAMS):
        if i:
            time.sleep(CAM_GAP_S)  # space calls to respect the per-minute limit
        try:
            r = assess(fetch_still(cam))
            readings.append({"id": cam["id"], "name": cam["name"], **r})
            print(f"  {cam['id']}: seaweed={r['level']}({r.get('coveragePct')}%) "
                  f"crowd={r.get('crowd')}({r.get('crowdPct')}%) "
                  f"people={r.get('people')} via {r.get('provider')}")
        except Exception as e:  # noqa: BLE001
            print(f"  warn {cam['id']}: {e}", file=sys.stderr)
    if not readings:
        return None
    return {"capturedAtLocal": now_local.isoformat(timespec="minutes"),
            "hour": now_local.hour, "cams": readings}


def main() -> int:
    now_local = dt.datetime.now(TZ)
    today = now_local.date().isoformat()
    providers = _enabled_providers()
    prev = fetch_prev()
    # Carry over today's morning reading; drop it if it's from a previous day.
    prev_morning = prev.get("morning") if prev.get("dateLocal") == today else None

    if providers:
        print(f"vision providers (in order): {', '.join(n for n, _ in providers)}")
    current = capture_now(now_local) if providers else None
    if current is None and not providers:
        print("no vision providers configured — preserving any existing readings",
              file=sys.stderr)

    # UNDERWATER read — quota-gated to AT MOST once per hour, during daylight
    # only (dark underwater at night). Gating is by AGE of the previous uw read
    # (>= 50 min), NOT by wall-clock minute: GitHub throttles the */10 cron to
    # roughly hourly at unpredictable minutes (observed 2026-07-23), so a
    # minute<10 gate almost never fired. Age-based gating attempts on ~every
    # throttled tick (~11/day) yet still caps at ~once/hour if GitHub ever
    # honors the full 10-min cadence. Carry the previous `uw` forward on
    # skipped/failed ticks, like morning/latest.
    uw = prev.get("uw")
    uw_reading = None
    if providers and now_local.hour in UW_HOURS:
        prev_uw_at = (uw or {}).get("capturedAtLocal")
        uw_age_min = None
        if prev_uw_at:
            try:
                uw_age_min = (now_local - dt.datetime.fromisoformat(prev_uw_at)).total_seconds() / 60
            except ValueError:
                uw_age_min = None  # unparseable -> treat as due
        if uw_age_min is None or uw_age_min >= 50:
            uw_reading = capture_uw(now_local)
            if uw_reading:
                uw = uw_reading

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
        wc = murkiest_water(current) or {}
        entry = {
            "t": current["capturedAtLocal"],
            "hour": current["hour"],
            "level": crowd.get("level"),       # busiest crowd across the cams
            "people": crowd.get("people"),
            "crowdPct": crowd.get("crowdPct"),  # 0-100 fullness (busiest cam)
            "seaweed": ws.get("level"),         # worst seaweed across the cams
            "cov": ws.get("pct"),               # 0-100 seaweed coverage (worst cam)
            "water": wc.get("level"),           # murkiest water across the cams
            "clr": wc.get("pct"),               # 0-100 clarity (100 = crystal clear)
        }
        # SPARSE underwater fields — present ONLY on the ~hourly ticks that
        # actually ran an underwater read, so we can later correlate surface
        # `clr` vs underwater `uw` for calibration. Absent on every other tick.
        if uw_reading:
            entry["uw"] = uw_reading.get("pct")       # 0-100 underwater visibility
            entry["uwLevel"] = uw_reading.get("level")  # clear|slightly_hazy|hazy|murky
        history = history + [entry]
        # No cap — keep every raw read forever. Growth is trivial: ~60 reads/day ×
        # ~110 bytes ≈ 7 KB/day ≈ 2.4 MB/year, negligible for years. The full
        # archive is wanted for future seasonality work. NOTE: this is only the
        # RAW retention; the app's vs-average baselines still cap their own
        # lookback at 56 days (see lib/vsAverage.ts), so "average" stays anchored
        # to the recent season rather than drifting across all of history.

    now_iso = (dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
               .isoformat().replace("+00:00", "Z"))
    out = {
        # Bump the timestamp only on a fresh capture; otherwise keep prev's so a
        # failed run that re-publishes the last good data doesn't look "fresh".
        "generatedAt": now_iso if current else (prev.get("generatedAt") or now_iso),
        # Label with the providers actually in play (each reading also records the
        # exact provider/model that produced it). Keep prev's label on a no-op run.
        "model": (",".join(n for n, _ in providers) if current
                  else prev.get("model")) or (providers[0][1] if providers else None),
        "tz": str(TZ),
        "dateLocal": today,
        "morning": morning,  # earliest pre-cleaning reading (highest weight)
        "latest": latest,    # most recent reading (current beach state)
        # Latest underwater sea-cam read {level, pct, note, capturedAtLocal};
        # carried forward on ticks that skip the ~hourly underwater read. None
        # until the first successful underwater grab.
        "uw": uw,
        # [{t, hour, level(crowd), people, seaweed, ..., uw?, uwLevel?}] -> by-hour
        # & by-day charts; uw/uwLevel present only on ticks that read underwater.
        "history": history,
    }

    # Non-destructive: never overwrite the published feed with an empty document.
    # `latest`/`morning` already carry forward prev's good data, so `out` is empty
    # only when this run got nothing AND there was no prior reading — in that case
    # write nothing so the publish step leaves the last good feed untouched.
    if not (out["morning"] or out["latest"]):
        print("no fresh readings and no prior good data — leaving published feed "
              "unchanged (not writing output)", file=sys.stderr)
        return 0

    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    mh = morning.get("hour") if morning else None
    fresh = "fresh" if current else "preserved (no fresh capture this run)"
    print(f"wrote {OUT} [{fresh}]: morning={mh} latest={(latest or {}).get('hour')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
