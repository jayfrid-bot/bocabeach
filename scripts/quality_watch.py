"""
The cam reader's half of the data-quality loop (docs/QUALITY_PLAN.md, "Catch" and
"Check"). Imported by scripts/cam_seaweed.py; pure stdlib, no network at import.

SECOND OPINION. When the reader HOLDS a sudden seaweed jump (a moderate/high read that
nothing has confirmed yet), it asks a second reader to look at the SAME image:

  * the claim came from Gemini, Groq, OpenRouter or GitHub Models  -> ask Clef
  * the claim came from Clef                                       -> ask Gemini
  * the other provider is not configured                           -> no second opinion

Exactly ONE provider HTTP attempt per second opinion (no retry, no second Gemini model),
and the per-tick cap counts those attempts. If the second reader also says moderate or
high, the jump is confirmed at once (`confirmedBy: "second-opinion:<provider>"`). If it
disagrees, the jump stays held, the cam is DISPUTED for the rest of the day (below), and
the app is told (POST /api/quality/alerts, Bearer QUALITY_INGEST_TOKEN): the app stores
the alert for the owner's review screen and may push it to the owner's phone. If the
second reader fails or calls the frame unreadable, nothing changes.

A failed alert POST is not lost: it waits in the feed's `pendingAlerts` outbox and is
retried every tick until the app answers 2xx, and dropped after 24 hours (or at once on a
permanent 4xx: 400, 404, 413, 422).

OWNER VERDICTS. The owner taps Right or Wrong on an alert. The app keeps the answer as an
override that names ONE EXACT CLAIM: the cam, the frame (its hash for a feed cam, else its time)
AND the time the reader scored it (`claimedAt`, required), and acts only on that claim, only on
the beach-local day (of claimedAt) it was made. The same image scored again later is a new claim. Once per beach per tick the
reader fetches the running ones (GET /api/quality/overrides; any failure is "none", exactly as
before). The verdicts in force are ONE merged stream of publishes and rejects, ordered by
(created time, id) and replayed in that order; of several on one exact target, the latest wins (same
rules as the app; lib/quality/verdictVectors.json holds the shared test vectors).

  * PUBLISH (Right, or Wrong with a corrected level of moderate or high): the held reading
    of that frame publishes at the verdict's level with `confirmedBy: "owner"`, and that
    frame's pending claim becomes a confirmed one.
  * REJECT (Wrong with none, low, or no value): the held reading of that frame is cleared,
    nothing is published for it, its pending claim is removed, and the cam is DISPUTED.

DISPUTED CAMS. A cam is disputed for the rest of its beach-local day by an owner Wrong, or by a
second opinion that disagrees. The state lives in the feed (`disputedCams`, same day only). While
a cam is disputed, its new moderate+ claims are held, and confirm ONLY by (a) a second opinion
that agrees, (b) a fresh OTHER cam, itself not disputed, claiming moderate+ in the same tick,
(c) an owner Right, or (d) the same cam claiming moderate+ on at least 3 distinct frames over at
least 90 minutes (a real bloom on a one-cam beach still publishes). Plain two-frame persistence
does NOT confirm a disputed cam. A held claim on a disputed cam still alerts the owner. A fresh
read of the cam below moderate restarts its frame count; any confirmation ends the dispute.

Everything here that decides something is pure and tested (quality_watch_test.py). The network
functions, post_alert() and fetch_overrides(), never raise.
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

# At most this many second-opinion provider HTTP attempts in one run (one process = one tick).
# Each opinion is exactly one attempt, so this is also the most calls a tick can bill. They are
# rare (only on a held jump); the cap keeps a misbehaving feed from spending Clef's daily
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

# The reader's credential for the quality routes. Its own secret (a Worker secret and a GitHub
# Actions secret), apart from INGEST_TOKEN, which the archive and the Clef route share.
TOKEN_ENV = "QUALITY_INGEST_TOKEN"


def _token(explicit: str | None = None) -> str:
    return (explicit if explicit is not None else os.environ.get(TOKEN_ENV, "")).strip()


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
    out = {k: v for k, v in held.items() if k not in ("unconfirmed", "claim", "dispute", "disputed")}
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


def claim_target(held: dict) -> dict:
    """The exact identity of a held claim, as the reader's own feed records it: the frame's hash
    (feed cams) and time, and when the claim was scored. An owner verdict binds to this. Pure."""
    return {"frameSha": held.get("frameSha"), "frameAt": held.get("frameAt"), "claimedAt": held.get("scoredAt")}


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
        "claimTarget": claim_target(held),
        "secondOpinion": opinion,
        "others": others,
        "frame": {"sha256": sha256, "archivedThisTick": bool(archived_this_tick),
                  **({"jpegB64": base64.b64encode(frame_jpeg).decode("ascii")}
                     if frame_jpeg and len(frame_jpeg) <= ALERT_FRAME_MAX_BYTES else {})},
    }


def post_alert(body: dict, token: str | None = None, url: str | None = None) -> str:
    """POST an alert to the app. BEST-EFFORT: never raises. Returns a short status:
    "no-token" (QUALITY_INGEST_TOKEN unset, nothing sent), "sent", "http-<code>" or "error"."""
    token = _token(token)
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


# --- the alert outbox ----------------------------------------------------------------------

OUTBOX_MAX_AGE = dt.timedelta(hours=24)
OUTBOX_MAX_PER_TICK = 5
# A 4xx that retrying cannot fix: the app refused the alert itself, not the moment.
PERMANENT_STATUSES = {"http-400", "http-404", "http-413", "http-422"}


def utc_iso(t: dt.datetime) -> str:
    """'2026-10-13T17:20:00Z' for an aware datetime. Pure."""
    return t.astimezone(dt.timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def alert_key(body: dict) -> str:
    """One alert per exact image: slug, cam, and the frame's hash (else its time). Pure."""
    frame = body.get("frame") or {}
    return f"{body.get('slug')}:{body.get('camId')}:{frame.get('sha256') or body.get('observedAt')}"


def queue_alert(outbox: list, body: dict, now: dt.datetime) -> bool:
    """Put a failed alert in the outbox, once per exact image. The picture is NOT kept (the
    feed file is read by the app every few minutes, and the app falls back to the archived
    frame without it). True when it was added. Mutates `outbox`."""
    key = alert_key(body)
    if any(e.get("key") == key for e in outbox):
        return False
    light = {**body, "frame": {k: v for k, v in (body.get("frame") or {}).items() if k != "jpegB64"}}
    outbox.append({"key": key, "createdAt": utc_iso(now), "attempts": 1, "body": light})
    return True


def retry_outbox(outbox: object, now: dt.datetime, post=None) -> list[dict]:
    """Send what is waiting in the outbox, once each (at most OUTBOX_MAX_PER_TICK). Returns the
    entries still waiting: dropped are those the app accepted, those older than 24 hours, those
    malformed, and those it refused permanently. `post` is post_alert by default."""
    post = post or post_alert
    keep: list[dict] = []
    tried = 0
    for e in outbox if isinstance(outbox, list) else []:
        made = parse_iso(e.get("createdAt")) if isinstance(e, dict) else None
        if made is None or not isinstance(e.get("body"), dict):
            continue
        if now - made > OUTBOX_MAX_AGE:
            continue
        if tried >= OUTBOX_MAX_PER_TICK:
            keep.append(e)
            continue
        tried += 1
        status = post(e["body"])
        if status == "sent" or status in PERMANENT_STATUSES:
            continue
        keep.append({**e, "attempts": int(e.get("attempts") or 1) + 1})
    return keep


# --- owner verdicts: targets, supersession, application ------------------------------------

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


def same_frame(a: dict, b: dict) -> bool:
    """True when two things name the same frame: equal hash prefixes when both have a hash, else
    equal frame time. Pure. (The app's sameFrame, lib/quality/seaweedOverrides.ts, is the twin.)"""
    sa, sb = a.get("frameSha"), b.get("frameSha")
    if sa and sb:
        n = min(len(sa), len(sb))
        return n >= 8 and sa[:n] == sb[:n]
    fa, fb = a.get("frameAt"), b.get("frameAt")
    return bool(fa and fb and fa == fb)


def same_claim(a: dict, b: dict) -> bool:
    """True when two things name the same CLAIM: the same frame, scored at the same time. The same
    image scored again later is a different claim. Pure."""
    return same_frame(a, b) and bool(a.get("claimedAt")) and a.get("claimedAt") == b.get("claimedAt")


def claim_key(o: dict) -> str | None:
    """The key of a frame: its hash prefix, else its time; None with neither. Pure."""
    if o.get("frameSha"):
        return f"sha:{o['frameSha'][:20]}"
    if o.get("frameAt"):
        return f"at:{o['frameAt']}"
    return None


def target_key(o: dict) -> str | None:
    """The key of one exact target: cam, frame and claim time. None when it lacks a frame identity or
    a claim time (it cannot bind). Pure."""
    k = claim_key(o)
    return f"{o.get('camId')}|{k}|{o['claimedAt']}" if k and o.get("claimedAt") else None


def parse_overrides(doc) -> list[dict]:
    """The reply of GET /api/quality/overrides as a list of overrides (same field names as the
    reply), seaweed only. A malformed entry is dropped. Pure."""
    out = []
    items = doc.get("overrides") if isinstance(doc, dict) else None
    for o in items if isinstance(items, list) else []:
        if not isinstance(o, dict) or o.get("signal", "seaweed") != "seaweed":
            continue
        cam, created, until = o.get("camId"), o.get("createdAtUtc"), o.get("untilUtc")
        if not isinstance(cam, str) or not cam or parse_iso(created) is None or parse_iso(until) is None:
            continue
        action = "publish" if o.get("action") == "publish" else "reject" if o.get("action") == "reject" else None
        if action is None:
            continue
        out.append({
            "id": o.get("id") if isinstance(o.get("id"), int) else 0,
            "camId": cam,
            "verdict": "right" if o.get("verdict") == "right" else "wrong",
            "action": action,
            "level": o.get("level") if o.get("level") in _RANK else None,
            "coveragePct": o.get("coveragePct"),
            "note": o.get("note"),
            "frameSha": o.get("frameSha") if isinstance(o.get("frameSha"), str) else None,
            "frameAt": o.get("frameAt") if isinstance(o.get("frameAt"), str) else None,
            "claimedAt": o.get("claimedAt"),
            "localDate": o.get("localDate"),
            "createdAtUtc": created,
            "untilUtc": until,
        })
    return out


def fetch_overrides(slug: str, token: str | None = None, url: str | None = None) -> list[dict]:
    """The owner's running seaweed verdicts for one beach. FAILS OPEN: with no
    QUALITY_INGEST_TOKEN, or on any error, it returns [] and the reader behaves exactly as it did
    before verdicts existed. Never raises."""
    token = _token(token)
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


def effective_overrides(overrides: list, now: dt.datetime) -> list[dict]:
    """The verdicts in force at `now`: not ended, bound to a frame, and the LATEST per exact
    target (created time, then id). Oldest first. The app's effectiveOverrides is the twin. Pure."""
    now_utc = now if now.tzinfo else now.replace(tzinfo=dt.timezone.utc)
    best: dict[str, dict] = {}
    for o in overrides:
        until, made = parse_iso(o.get("untilUtc")), parse_iso(o.get("createdAtUtc"))
        key = target_key(o)
        if until is None or made is None or key is None or until <= now_utc:
            continue
        cur = best.get(key)
        if cur is None:
            best[key] = o
            continue
        cur_made = parse_iso(cur["createdAtUtc"])
        if made > cur_made or (made == cur_made and (o.get("id") or 0) > (cur.get("id") or 0)):
            best[key] = o
    return sorted(best.values(), key=lambda o: (parse_iso(o["createdAtUtc"]), o.get("id") or 0))


def owner_state(overrides: list, now: dt.datetime) -> dict:
    """The owner's verdicts in force, as
      {"publish": [...], "reject": [...], "events": [...]}
    `events` is ONE merged stream of both, ordered by (created time, id); `publish` and `reject` are
    the same events split by action, in the same order. Pure."""
    live = effective_overrides(overrides, now)
    return {"publish": [o for o in live if o["action"] == "publish"],
            "reject": [o for o in live if o["action"] == "reject"],
            "events": live}


def apply_owner_confirmations(prev: dict, events: list) -> dict:
    """The previous published feed with the owner's verdicts applied, in order, to their exact claims
    (`events` is owner_state()["events"]). PUBLISH: a reading still held for that claim publishes at the
    verdict's level with `confirmedBy: "owner"` (in `latest`, `lastSeaweed`, `morning`), and that claim's
    pending entry becomes confirmed (`confirmedBy: "owner"`). REJECT: a held reading for that claim is
    cleared and its pending entry removed. A claim is the cam, the frame AND the time it was scored: a
    verdict never touches another frame, or the same image scored at another time. Returns a new dict;
    `prev` is not mutated, and with nothing to apply it returns `prev` itself. Pure."""
    both = sorted(events, key=lambda o: (parse_iso(o["createdAtUtc"]), o.get("id") or 0))
    if not both:
        return prev
    out = dict(prev)
    for o in both:
        cam = o["camId"]
        for key in ("latest", "lastSeaweed", "morning"):
            group = out.get(key)
            if not isinstance(group, dict) or not isinstance(group.get("cams"), list):
                continue
            cams = []
            for c in group["cams"]:
                if (c.get("id") == cam and c.get("unconfirmed")
                        and same_claim({"frameSha": c.get("frameSha"), "frameAt": c.get("frameAt"),
                                        "claimedAt": c.get("scoredAt")}, o)):
                    if o["action"] == "publish":
                        c = confirm_held(c, "owner", {"level": o.get("level"), "coveragePct": o.get("coveragePct"),
                                                      "note": o.get("note")})
                    else:
                        c = {k: v for k, v in c.items() if k not in ("unconfirmed", "claim")}
                        c.update({"level": None, "coveragePct": None, "note": None, "ownerRejected": True})
                cams.append(c)
            out[key] = {**group, "cams": cams}
        claims = out.get("pendingClaims")
        entry = claims.get(cam) if isinstance(claims, dict) else None
        if isinstance(entry, dict) and same_claim(entry, o):
            if o["action"] == "reject":
                out["pendingClaims"] = {k: v for k, v in claims.items() if k != cam}
            elif not entry.get("confirmed"):
                out["pendingClaims"] = {**claims, cam: {**entry, "confirmed": True, "confirmedBy": "owner"}}
    return out


# --- disputed cams -------------------------------------------------------------------------

DISPUTE_MIN_FRAMES = 3
DISPUTE_MIN_SPAN = dt.timedelta(minutes=90)
DISPUTE_CLAIMS_KEPT = 8


def is_active_dispute(entry) -> bool:
    return isinstance(entry, dict) and not entry.get("resolvedAt")


def dispute_state(prev_disputed, events: list, now: dt.datetime) -> dict[str, dict]:
    """The feed's `disputedCams` for this tick: {cam id: {since, reason, date, claims, resolvedAt?}}.
    Starts from the previous map's entries made TODAY (beach-local date of `now`), then REPLAYS the
    owner's verdicts (`events`, owner_state()["events"]: ONE stream of rejects and publishes ordered
    by (created time, id)), each against the state the one before left:
      reject  starts a dispute for its cam, unless one is already active; a reject made after an entry
              was resolved starts a fresh one (so Wrong, Right, Wrong ends disputed);
      publish ends an active dispute on that cam that began at or before it (Right, Wrong, Right ends
              not disputed).
    A resolved entry stays as a marker, so a reject already answered is not applied twice. Pure."""
    today = now.date().isoformat()
    out: dict[str, dict] = {}
    if isinstance(prev_disputed, dict):
        for cam, e in prev_disputed.items():
            if isinstance(e, dict) and e.get("date") == today:
                out[cam] = {**e, "claims": list(e.get("claims") or [])}
    for o in sorted(events, key=lambda o: (parse_iso(o["createdAtUtc"]), o.get("id") or 0)):
        e = out.get(o["camId"])
        made = parse_iso(o["createdAtUtc"])
        if o["action"] == "reject":
            if o.get("localDate") not in (None, today):
                continue
            resolved = parse_iso(e.get("resolvedAt")) if e else None
            if e is None or (resolved is not None and made is not None and resolved < made):
                out[o["camId"]] = {"since": o["createdAtUtc"], "reason": "owner", "date": today, "claims": []}
        elif is_active_dispute(e):
            since = parse_iso(e.get("since"))
            if since is not None and made is not None and since <= made:
                e["resolvedAt"] = o["createdAtUtc"]
    return out


def active_disputes(state: dict) -> dict[str, dict]:
    return {cam: e for cam, e in (state or {}).items() if is_active_dispute(e)}


def _claim_time(reading: dict) -> dt.datetime | None:
    return parse_iso(reading.get("frameAt")) or parse_iso(reading.get("scoredAt"))


def record_dispute_claim(entry: dict, reading: dict) -> None:
    """Remember one held moderate+ frame of a disputed cam (distinct frames only, newest
    DISPUTE_CLAIMS_KEPT kept). Mutates `entry`."""
    key = claim_key(reading)
    t = _claim_time(reading)
    if key is None or t is None or any(c.get("key") == key for c in entry["claims"]):
        return
    entry["claims"].append({"key": key, "at": utc_iso(t)})
    del entry["claims"][:-DISPUTE_CLAIMS_KEPT]


def extended_persistence_ok(entry: dict, reading: dict) -> bool:
    """Rule (d): with this read, the disputed cam has claimed moderate+ on at least 3 distinct frames
    spanning at least 90 minutes. Pure."""
    frames = {c["key"]: parse_iso(c.get("at")) for c in entry.get("claims") or [] if c.get("key")}
    key, t = claim_key(reading), _claim_time(reading)
    if key is not None:
        frames[key] = t
    times = [t for t in frames.values() if t is not None]
    return len(frames) >= DISPUTE_MIN_FRAMES and len(times) >= DISPUTE_MIN_FRAMES and max(times) - min(times) >= DISPUTE_MIN_SPAN
