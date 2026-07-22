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
"""
import base64
import datetime as dt
import json
import os
import random
import re
import sys
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
MAX_HISTORY = 480  # rolling raw reads (~1+ month) for the by-hour & by-day charts

PROMPT = (
    "This is a live beach webcam photo. Return strict JSON only: "
    '{"seaweed":"none|low|moderate|high","seaweed_pct":<integer 0-100>,'
    '"seaweed_note":"<=8 words","crowd":"empty|quiet|moderate|busy|packed",'
    '"crowd_pct":<integer 0-100>,"people":<approx visible people as integer>,'
    '"crowd_note":"<=8 words"}. '
    "Seaweed = brown/golden sargassum on the sand and in shallow water: "
    "none=clean sand, low=thin wrack line or scattered patches, "
    "moderate=clear bands, high=heavy mats over much of the shore. "
    "seaweed_pct = percent of the visible sand/shoreline covered by sargassum "
    "(0=clean, 5=thin wrack line, 30=clear bands, 60=heavy mats, 90+=nearly all covered). "
    "Crowd = how busy the beach looks from people on the sand and in the water "
    "(and cars in any visible parking lot): empty=nobody, quiet=a few people, "
    "moderate=steady, busy=crowded, packed=very crowded. "
    "crowd_pct = how full the beach looks, 0=empty to 100=packed holiday peak."
)


def _get(url: str, timeout: int = 25) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "boca-beach-rats"})
    return urllib.request.urlopen(req, timeout=timeout).read()


def fetch_still(cam: dict) -> bytes:
    if cam.get("still"):
        return _get(cam["still"])
    feed = json.loads(_get(f"{cam['feed']}/latest.json").decode("utf-8", "replace"))
    return _get(f"{cam['feed']}/{feed[cam['view']]['mr']}")


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
    }


def _gemini_out(img: bytes) -> dict:
    body = json.dumps({
        "contents": [{"parts": [
            {"text": PROMPT},
            {"inline_data": {"mime_type": "image/jpeg",
                             "data": base64.b64encode(img).decode()}},
        ]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }).encode()
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{MODEL}:generateContent?key={API_KEY}")
    resp = json.loads(_post(url, body))
    return _extract_json(resp["candidates"][0]["content"]["parts"][0]["text"])


def _openai_out(cfg: dict, img: bytes) -> dict:
    """One adapter for every OpenAI chat-compatible vision API (Groq/OpenRouter/GitHub)."""
    data_uri = "data:image/jpeg;base64," + base64.b64encode(img).decode()
    body = json.dumps({
        "model": cfg["model"],
        "temperature": 0,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
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


def assess_with(name: str, img: bytes) -> dict:
    """Read one image with exactly ONE named provider (for per-provider eval)."""
    if name == "gemini":
        if not API_KEY:
            raise RuntimeError("gemini not configured")
        raw, model = _gemini_out(img), MODEL
    else:
        cfg = OPENAI_PROVIDERS.get(name)
        if not cfg or not cfg["key"]:
            raise RuntimeError(f"{name} not configured")
        raw, model = _openai_out(cfg, img), cfg["model"]
    result = _parse_out(raw)
    result["provider"] = name
    result["model"] = model
    return result


def assess(img: bytes) -> dict:
    """Read one image, falling through the provider chain until one succeeds."""
    errors = []
    for name, _model in _enabled_providers():
        try:
            return assess_with(name, img)
        except Exception as e:  # noqa: BLE001 — try the next provider
            errors.append(f"{name}: {e}")
    if not errors:
        raise RuntimeError("no vision providers configured (set GEMINI_API_KEY or another key)")
    raise RuntimeError("all vision providers failed -> " + " | ".join(errors))


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
        history = history + [{
            "t": current["capturedAtLocal"],
            "hour": current["hour"],
            "level": crowd.get("level"),       # busiest crowd across the cams
            "people": crowd.get("people"),
            "crowdPct": crowd.get("crowdPct"),  # 0-100 fullness (busiest cam)
            "seaweed": ws.get("level"),         # worst seaweed across the cams
            "cov": ws.get("pct"),               # 0-100 seaweed coverage (worst cam)
        }]
        history = history[-MAX_HISTORY:]

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
        # [{t, hour, level(crowd), people, seaweed}] -> by-hour & by-day charts.
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
