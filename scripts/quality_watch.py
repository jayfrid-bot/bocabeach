"""
The cam reader's half of the data-quality loop (docs/QUALITY_PLAN.md, "Catch" and
"Check"). Imported by scripts/cam_seaweed.py; pure stdlib, no network at import.

When the reader HOLDS a sudden seaweed jump (a moderate/high read that nothing has
confirmed yet), it asks a second reader to look at the SAME image:

  * the claim came from Gemini, Groq, OpenRouter or GitHub Models  -> ask Clef
  * the claim came from Clef                                       -> ask Gemini
  * the other provider is not configured                           -> no second opinion

If the second reader also says moderate or high, the reader confirms the jump at
once (`confirmedBy: "second-opinion:<provider>"`). If it disagrees, the jump stays
held and the app is told (POST /api/quality/alerts, Bearer INGEST_TOKEN): the app
stores the alert for the owner's review screen and may push it to the owner's
phone. If the second reader fails or calls the frame unreadable, nothing happens:
the jump stays held, exactly as before this existed.

OWNER VERDICTS (docs/QUALITY_PLAN.md): the owner taps Right or Wrong on an alert, and the
app keeps that as an override until the end of the beach-local day. Once per beach per tick
the reader fetches them (GET /api/quality/overrides, Bearer INGEST_TOKEN; any failure is "no
overrides", exactly as before):

  * WRONG on a cam: its pending claim is cleared, and its further moderate+ reads this day
    do not confirm by persistence or second opinion (they are published as no seaweed, with
    `ownerHold`), until a fresh read of that cam comes in below moderate: then the override
    is SPENT (remembered in the feed's `spentOverrides`). Another fresh cam that also claims
    moderate+ can still confirm it, but a suppressed cam never confirms another.
  * RIGHT on a held claim: the claim is confirmed. The held reading is published at the
    claimed level with `confirmedBy: "owner"`, and its pending claim becomes a confirmed one.

Everything here that decides something is pure and tested (quality_watch_test.py):
which provider to ask, whether an opinion agrees, how the confirmed reading is
rebuilt, what the alert body holds. The one network function, post_alert(), never
raises.
"""
import base64
import datetime as dt
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

# Same ranks as cam_seaweed.SEAWEED_RANK / _MODERATE; copied so this module needs no import of it.
_RANK = {"none": 0, "low": 1, "moderate": 2, "high": 3}
_MODERATE = 2

# Which provider may check which. A claim from Clef is checked by Gemini; a claim
# from anything else is checked by Clef. Only these two ever give a second opinion:
# the free OpenAI-compatible models are weaker readers, and a weak "yes" would
# bypass the very check this is.
SECOND_OPINION_AFTER = {"clef": "gemini"}
SECOND_OPINION_DEFAULT = "clef"

# At most this many second opinions in one run (one process = one tick). They are rare
# (only on a held jump); the cap keeps a misbehaving feed from spending Clef's daily
# allowance (600 calls a UTC day, server side).
MAX_SECOND_OPINIONS_PER_RUN = int(os.environ.get("MAX_SECOND_OPINIONS_PER_RUN", "6"))

ALERT_URL = os.environ.get("QUALITY_ALERT_URL", "https://app.isitbeachday.com/api/quality/alerts")
ALERT_TIMEOUT_S = 30  # the body carries a shrunk frame of up to ALERT_FRAME_MAX_BYTES
# The exact frame sent with an alert: shrunk to at most this many bytes (the app refuses more).
ALERT_FRAME_MAX_BYTES = 150 * 1024
HTTP_UA = os.environ.get(
    "HTTP_UA",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
)


def pick_second_provider(claim_provider, configured) -> str | None:
    """The provider to ask for a second opinion on a claim, or None.

    `claim_provider` is the name that made the claim (a reading's "provider"; None
    when unknown). `configured` is the set of provider names that can be called.
    Never the claim's own provider. Pure."""
    if claim_provider == "clef":
        want = SECOND_OPINION_AFTER["clef"]
    else:
        want = SECOND_OPINION_DEFAULT
    if want == claim_provider:
        return None
    return want if want in configured else None


def agrees(level) -> bool:
    """A second opinion backs the claim when it is itself moderate or high. Pure."""
    return level in _RANK and _RANK[level] >= _MODERATE


def opinion_from_reading(reading: dict) -> dict:
    """The slice of a second reader's reading we keep: provider, model, level, coverage, note. Pure."""
    return {
        "provider": reading.get("provider"),
        "model": reading.get("model"),
        "level": reading.get("level"),
        "coveragePct": reading.get("coveragePct"),
        "note": reading.get("note"),
    }


def confirm_held(held: dict, by: str, claim: dict | None = None) -> dict:
    """The held reading, published: the claim's level, coverage and note restored, the
    hold marks removed, and `confirmedBy` set to `by`. `claim` (when it has a valid level)
    replaces the reading's own stored claim. Returns a new dict; the input is not
    mutated. Pure."""
    own = held.get("claim") or {}
    use = claim if claim and claim.get("level") in _RANK else own
    out = {k: v for k, v in held.items() if k not in ("unconfirmed", "claim")}
    out["level"] = use.get("level")
    out["coveragePct"] = use.get("coveragePct")
    out["note"] = use.get("note")
    out["confirmedBy"] = by
    return out


def confirmed_by_second_opinion(held: dict, opinion: dict) -> dict:
    """confirm_held() for a second reader that backed the claim: confirmedBy
    "second-opinion:<provider>". Pure."""
    return confirm_held(held, f"second-opinion:{opinion.get('provider')}")


def other_cams(group_cams: list, this_id: str) -> list[dict]:
    """The beach's OTHER cams that have a published seaweed level right now, as
    {id, name, level, coveragePct, carried}. A cam that is held, gated by low sun or has
    no seaweed level is left out: it has no current reading to compare. Pure."""
    out = []
    for c in group_cams:
        if c.get("id") == this_id or c.get("level") not in _RANK:
            continue
        out.append({
            "id": c.get("id"),
            "name": c.get("name") or c.get("id"),
            "level": c["level"],
            "coveragePct": c.get("coveragePct"),
            "carried": bool(c.get("carried")),
        })
    return out


def frame_sha256(img: bytes) -> str:
    """Full SHA-256 (hex) of the JPEG bytes; the archive stores the same hash per frame."""
    return hashlib.sha256(img).hexdigest()


def build_alert(slug: str, held: dict, opinion: dict, others: list, published, sha256: str | None,
                archived_this_tick: bool, frame_jpeg: bytes | None = None) -> dict:
    """The body POSTed to /api/quality/alerts for a held jump the second reader did
    not back. `held` is the reading as confirm_seaweed_jumps left it (unconfirmed, with
    its `claim`); `published` is the beach roll-up that stood meanwhile, {level, pct} or
    None. `frame_jpeg` is the shrunk image (at most ALERT_FRAME_MAX_BYTES) the app keeps so the
    review screen shows the exact frame that was judged; without it the screen falls back to
    the nearest archived frame. Pure."""
    claim = held.get("claim") or {}
    return {
        "slug": slug,
        "camId": held.get("id"),
        "camName": held.get("name") or held.get("id"),
        "observedAt": held.get("frameAt") or held.get("scoredAt"),
        "published": published,
        "claim": {
            "level": claim.get("level"),
            "coveragePct": claim.get("coveragePct"),
            "note": claim.get("note"),
            "provider": held.get("provider"),
            "model": held.get("model"),
        },
        "secondOpinion": opinion,
        "others": others,
        "frame": {"sha256": sha256, "archivedThisTick": bool(archived_this_tick),
                  **({"jpegB64": base64.b64encode(frame_jpeg).decode("ascii")}
                     if frame_jpeg and len(frame_jpeg) <= ALERT_FRAME_MAX_BYTES else {})},
    }


def post_alert(body: dict, token: str | None = None, url: str | None = None) -> str:
    """POST an alert to the app. BEST-EFFORT: never raises. Returns a short status:
    "no-token" (INGEST_TOKEN unset, nothing sent), "sent", "http-<code>" or "error"."""
    token = (token if token is not None else os.environ.get("INGEST_TOKEN", "")).strip()
    if not token:
        return "no-token"
    try:
        req = urllib.request.Request(
            url or ALERT_URL,
            data=json.dumps(body, separators=(",", ":")).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
                "User-Agent": HTTP_UA,
            },
        )
        with urllib.request.urlopen(req, timeout=ALERT_TIMEOUT_S) as resp:
            resp.read(2000)
        return "sent"
    except urllib.error.HTTPError as e:
        print(f"  warn quality alert: HTTP {e.code}", file=sys.stderr)
        return f"http-{e.code}"
    except Exception as e:  # noqa: BLE001 — an alert must never break the read
        print(f"  warn quality alert: {e}", file=sys.stderr)
        return "error"


# --- owner verdicts -------------------------------------------------------------------------

OVERRIDES_URL = os.environ.get("QUALITY_OVERRIDES_URL", "https://app.isitbeachday.com/api/quality/overrides")
OVERRIDES_TIMEOUT_S = 8


def parse_iso(stamp) -> dt.datetime | None:
    """An ISO-8601 stamp ('2026-10-13T17:45:00.000Z' or with an offset) as an aware UTC
    datetime, or None when it does not parse. Pure."""
    if not isinstance(stamp, str):
        return None
    try:
        t = dt.datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.timezone.utc)


def parse_overrides(doc) -> list[dict]:
    """The reply of GET /api/quality/overrides as [{camId, verdict, createdAt, untilUtc,
    claim}], seaweed only. A malformed entry is dropped. Pure."""
    out = []
    items = doc.get("overrides") if isinstance(doc, dict) else None
    for o in items if isinstance(items, list) else []:
        if not isinstance(o, dict) or o.get("signal", "seaweed") != "seaweed":
            continue
        cam, created, until = o.get("camId"), o.get("createdAtUtc"), o.get("untilUtc")
        if not isinstance(cam, str) or not cam or parse_iso(created) is None or parse_iso(until) is None:
            continue
        claim = o.get("claim") if isinstance(o.get("claim"), dict) else None
        out.append({"camId": cam, "verdict": "right" if o.get("verdict") == "right" else "wrong",
                    "createdAt": created, "untilUtc": until, "claim": claim})
    return out


def fetch_overrides(slug: str, token: str | None = None, url: str | None = None) -> list[dict]:
    """The owner's running seaweed verdicts for one beach. FAILS OPEN: with no INGEST_TOKEN,
    or on any error, it returns [] and the reader behaves exactly as it did before verdicts
    existed. Never raises."""
    token = (token if token is not None else os.environ.get("INGEST_TOKEN", "")).strip()
    if not token:
        return []
    try:
        req = urllib.request.Request(
            f"{url or OVERRIDES_URL}?{urllib.parse.urlencode({'slug': slug})}",
            headers={"Authorization": f"Bearer {token}", "User-Agent": HTTP_UA},
        )
        with urllib.request.urlopen(req, timeout=OVERRIDES_TIMEOUT_S) as resp:
            return parse_overrides(json.loads(resp.read(200_000).decode("utf-8", "replace")))
    except Exception as e:  # noqa: BLE001 — fail open
        print(f"  warn [{slug}] quality overrides: {e}", file=sys.stderr)
        return []


def owner_state(overrides: list, spent, now: dt.datetime) -> dict:
    """What the owner's verdicts mean for this tick:
      {"wrong": {cam id: createdAt of its latest running Wrong override, not yet spent},
       "right": [running Right overrides, oldest first]}
    An override that has ended, or one already recorded in `spent` ({cam id: createdAt}),
    is not running. Pure."""
    spent = spent if isinstance(spent, dict) else {}
    now_utc = now if now.tzinfo else now.replace(tzinfo=dt.timezone.utc)
    wrong: dict[str, str] = {}
    right = []
    for o in sorted(overrides, key=lambda o: parse_iso(o.get("createdAt")) or now_utc):
        until = parse_iso(o.get("untilUtc"))
        if until is None or until <= now_utc:
            continue
        if o.get("verdict") == "right":
            right.append(o)
        elif spent.get(o["camId"]) != o["createdAt"]:
            wrong[o["camId"]] = o["createdAt"]
    return {"wrong": wrong, "right": right}


def spent_by(wrong: dict, cams: list) -> dict[str, str]:
    """Wrong overrides this tick spends: a cam under one whose FRESH (not carried) reading is
    below moderate. Returns {cam id: that override's createdAt}. Pure."""
    out = {}
    for c in cams or []:
        cid = c.get("id")
        if cid in wrong and not c.get("carried") and c.get("level") in _RANK and _RANK[c["level"]] < _MODERATE:
            out[cid] = wrong[cid]
    return out


def prune_spent(spent, now: dt.datetime) -> dict[str, str]:
    """The spent map without entries made on another beach-local date (an override ends at
    the close of its day, so a stale entry can never matter). Pure."""
    if not isinstance(spent, dict):
        return {}
    out = {}
    for cam, created in spent.items():
        t = parse_iso(created)
        if t is not None and (not now.tzinfo or t.astimezone(now.tzinfo).date() == now.date()):
            out[cam] = created
    return out


def apply_owner_confirmations(prev: dict, rights: list) -> dict:
    """The previous published feed with the owner's Right verdicts applied: a still-held
    reading of that cam (scored at or before the verdict) becomes published at the judged
    level with `confirmedBy: "owner"`, in `latest`, `lastSeaweed` and `morning`; and the cam's
    held pending claim becomes a confirmed one (`confirmed`, `confirmedBy: "owner"`), so its
    next moderate+ frame is not held again. Returns a new dict; `prev` is not mutated. With
    nothing to apply it returns `prev` itself. Pure."""
    if not rights:
        return prev
    out = dict(prev)
    for o in rights:
        cam, limit, claim = o["camId"], parse_iso(o["createdAt"]), o.get("claim")
        for key in ("latest", "lastSeaweed", "morning"):
            group = out.get(key)
            if not isinstance(group, dict) or not isinstance(group.get("cams"), list):
                continue
            cams = []
            for c in group["cams"]:
                at = parse_iso(c.get("scoredAt"))
                if (c.get("id") == cam and c.get("unconfirmed") and (at is None or limit is None or at <= limit)):
                    c = confirm_held(c, "owner", claim)
                cams.append(c)
            out[key] = {**group, "cams": cams}
        claims = out.get("pendingClaims")
        entry = claims.get(cam) if isinstance(claims, dict) else None
        if isinstance(entry, dict) and not entry.get("confirmed"):
            at = parse_iso(entry.get("claimedAt")) or parse_iso(entry.get("frameAt"))
            if at is None or limit is None or at <= limit:
                out["pendingClaims"] = {**claims, cam: {**entry, "confirmed": True, "confirmedBy": "owner"}}
    return out
