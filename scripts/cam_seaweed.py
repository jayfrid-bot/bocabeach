#!/usr/bin/env python3
"""
Read visible sargassum/seaweed from the close-up beach-cam stills using Google
Gemini Flash (free tier). Runs OFF Netlify in the daily Action; writes a tiny
cam_seaweed.json the web app reads. Pure stdlib (urllib/base64/json/zoneinfo).

The City runs a tractor that clears beach seaweed every morning ~7-9 AM, so an
afternoon photo shows a *cleaned* beach and understates what's washing ashore.
We therefore weight the EARLY-MORNING (pre-tractor) capture highest: each run
records the local capture time, and we merge with the previously published file
to preserve today's earliest morning reading as the authoritative `morning`
value (plus a `latest` reading for the current beach state).

Needs a free GEMINI_API_KEY (Google AI Studio). Without it, it preserves any
existing readings and exits 0 so the rest of the pipeline keeps working.
"""
import base64
import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")  # 2.0-flash has no free tier
OUT = os.environ.get("CAM_SEAWEED_OUT", "cam_seaweed.json")
TZ = ZoneInfo(os.environ.get("CAM_TZ", "America/New_York"))
PREV_URL = os.environ.get(
    "CAM_SEAWEED_PREV_URL",
    "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/sargassum-data/cam_seaweed.json",
)
# Local hours considered "morning, before/at the beach-cleaning tractor".
MORNING = range(5, 10)

CAMS = [
    {"id": "boca-surf", "name": "Boca Surf Cam",
     "still": "http://bocasurfcam.com/most_recent_image.php"},
    {"id": "boca-inlet-surf", "name": "Boca Inlet — Surf & Shoreline",
     "feed": "http://video-monitoring.com/beachcams/bocainlet", "view": "s16"},
    {"id": "boca-south-surf", "name": "South Beach — Shoreline & Surf",
     "feed": "http://video-monitoring.com/beachcams/boca", "view": "s11"},
    # Wide pavilion + parking-lot view — the best gauge of how busy the beach is.
    {"id": "boca-south", "name": "South Beach — Pavilion & Lot",
     "feed": "http://video-monitoring.com/beachcams/boca", "view": "s4"},
]

SEAWEED = ("none", "low", "moderate", "high")
CROWD = ("empty", "quiet", "moderate", "busy", "packed")
CROWD_RANK = {c: i for i, c in enumerate(CROWD)}
MAX_HISTORY = 480  # ~30 days of readings for the "busyness by hour" pattern

PROMPT = (
    "This is a live beach webcam photo. Return strict JSON only: "
    '{"seaweed":"none|low|moderate|high","seaweed_note":"<=8 words",'
    '"crowd":"empty|quiet|moderate|busy|packed","people":<approx visible people as integer>,'
    '"crowd_note":"<=8 words"}. '
    "Seaweed = brown/golden sargassum on the sand and in shallow water: "
    "none=clean sand, low=thin wrack line or scattered patches, "
    "moderate=clear bands, high=heavy mats over much of the shore. "
    "Crowd = how busy the beach looks from people on the sand and in the water "
    "(and cars in any visible parking lot): empty=nobody, quiet=a few people, "
    "moderate=steady, busy=crowded, packed=very crowded."
)


def _get(url: str, timeout: int = 25) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "boca-beach-rats"})
    return urllib.request.urlopen(req, timeout=timeout).read()


def fetch_still(cam: dict) -> bytes:
    if cam.get("still"):
        return _get(cam["still"])
    feed = json.loads(_get(f"{cam['feed']}/latest.json").decode("utf-8", "replace"))
    return _get(f"{cam['feed']}/{feed[cam['view']]['mr']}")


def assess(img: bytes) -> dict:
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
    req = urllib.request.Request(url, data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        raw = urllib.request.urlopen(req, timeout=40).read()
    except urllib.error.HTTPError as e:
        # Surface Google's error detail (e.g. API_KEY_INVALID vs RESOURCE_EXHAUSTED).
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}") from None
    resp = json.loads(raw)
    out = json.loads(resp["candidates"][0]["content"]["parts"][0]["text"])
    sw = str(out.get("seaweed", "")).lower()
    if sw not in SEAWEED:
        raise ValueError(f"bad seaweed: {sw!r}")
    cr = str(out.get("crowd", "")).lower()
    people = out.get("people")
    return {
        "level": sw,
        "note": str(out.get("seaweed_note", ""))[:80],
        "crowd": cr if cr in CROWD else None,
        "people": int(people) if isinstance(people, (int, float)) else None,
        "crowdNote": str(out.get("crowd_note", ""))[:80],
    }


def busiest_crowd(group: dict | None) -> dict | None:
    """Aggregate a capture's per-cam crowd into the busiest reading."""
    cams = [c for c in (group or {}).get("cams", []) if c.get("crowd") in CROWD_RANK]
    if not cams:
        return None
    b = max(cams, key=lambda c: CROWD_RANK[c["crowd"]])
    return {"level": b["crowd"], "people": b.get("people")}


def fetch_prev() -> dict:
    try:
        return json.loads(_get(PREV_URL).decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return {}


def capture_now(now_local: dt.datetime) -> dict | None:
    readings = []
    for cam in CAMS:
        try:
            r = assess(fetch_still(cam))
            readings.append({"id": cam["id"], "name": cam["name"], **r})
            print(f"  {cam['id']}: seaweed={r['level']} crowd={r.get('crowd')} people={r.get('people')}")
        except Exception as e:  # noqa: BLE001
            print(f"  warn {cam['id']}: {e}", file=sys.stderr)
    if not readings:
        return None
    return {"capturedAtLocal": now_local.isoformat(timespec="minutes"),
            "hour": now_local.hour, "cams": readings}


def main() -> int:
    now_local = dt.datetime.now(TZ)
    today = now_local.date().isoformat()
    prev = fetch_prev()
    # Carry over today's morning reading; drop it if it's from a previous day.
    prev_morning = prev.get("morning") if prev.get("dateLocal") == today else None

    current = capture_now(now_local) if API_KEY else None
    if current is None and not API_KEY:
        print("no GEMINI_API_KEY — preserving any existing readings", file=sys.stderr)

    # The earliest morning (pre-tractor) reading of the day is authoritative.
    morning = prev_morning
    if current and current["hour"] in MORNING:
        if not prev_morning or current["hour"] < prev_morning.get("hour", 99):
            morning = current
    latest = current or prev.get("latest")

    # Rolling history of busyness readings -> the app builds a by-hour pattern.
    history = prev.get("history") if isinstance(prev.get("history"), list) else []
    agg = busiest_crowd(current)
    if current and agg:
        history = history + [
            {"t": current["capturedAtLocal"], "hour": current["hour"], **agg}
        ]
        history = history[-MAX_HISTORY:]

    out = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        .isoformat().replace("+00:00", "Z"),
        "model": MODEL if API_KEY else None,
        "tz": str(TZ),
        "dateLocal": today,
        "morning": morning,  # earliest pre-cleaning reading (highest weight)
        "latest": latest,    # most recent reading (current beach state)
        "history": history,  # [{t, hour, level, people}] for the busyness-by-hour chart
    }
    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    mh = morning.get("hour") if morning else None
    print(f"wrote {OUT}: morning={mh} latest={(latest or {}).get('hour')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
