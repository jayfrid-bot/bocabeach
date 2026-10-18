#!/usr/bin/env python3
"""Which cams does the courier grab right now? (data-driven, no cam list in shell)

The cam list comes from config, not from the shell script:

  config/archive-cams.json   every cam whose source kind is "direct" is a courier
                             cam (its beach gives the time zone and coordinates)
  config/vision-cams.json    same rule; adds a cam the archive does not list
  config/sun-cams.json       YouTube video id and the "fallback" page (Elbo Room)
  config/courier-cams.json   video ids for cams that are not sun cams, and a skip list

Add a cam to those files and the courier picks it up on the next run. Nothing in
scripts/cam_courier_local.sh names a cam.

Two kinds of run (scripts/cam_courier_local.sh asks for one of them):

  routine   (the plist fires every 5 minutes)  A cam is due when its last good
            frame is at least 57 minutes old. At most ceil(cams / 12) + 1 cams are
            taken per run, the most overdue first. So the cams spread over the hour
            by themselves, and a cold start is not one burst.
  golden    (the plist fires every 10 minutes) A cam is due while ITS OWN beach is
            inside a golden window (sunrise -20/+40 min, sunset -40/+20 min). The
            stride is 10 minutes while the in-window cams fit the golden share of
            the call budget (24 cams), then 20 minutes, then 30. Only the cams
            whose window is open are grabbed, not every cam.

A cam that fails starts a cooldown (10 min, doubling, up to 2 hours) so a dead
stream does not eat the budget. A good frame clears it. Both the last-frame times
and the cooldowns live in the pacer's state file (scripts/yt_pacer.py).

COMMAND LINE
  courier_schedule.py due --mode routine|golden|all [--now ISO] [--no-state]
        print "cam|youtube_id|fallback_page|fallback_title" per due cam ("-" = none)
  courier_schedule.py mark --cam ID --ok | --fail      record a result
  courier_schedule.py list                             every courier cam found
  courier_schedule.py check                            exit 1 when a cam cannot be grabbed
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from zoneinfo import ZoneInfo
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import golden_now  # noqa: E402
import yt_pacer  # noqa: E402

# --- The numbers ---------------------------------------------------------------
ROUTINE_MIN_AGE_MIN = 57  # a cam is due again this long after its last good frame
ROUTINE_TICK_MIN = 5  # the routine plist fires this often
GOLDEN_TICK_MIN = 10  # the golden plist fires this often
GOLDEN_BASE_STRIDE_MIN = 10  # one frame per cam per golden slot, when the budget allows it
GOLDEN_CALL_BUDGET = 36  # golden's planned share of the 60 calls per 15 min
GOLDEN_MAX_STRIDE_MIN = 30
GOLDEN_GRACE_MIN = 1.5  # a run that fires a little early still counts as due


@dataclass(frozen=True)
class Cam:
    id: str
    youtube_id: Optional[str]
    slug: str  # the beach whose golden windows apply
    timezone: str
    lat: Optional[float]
    lon: Optional[float]
    fallback: Optional[Dict[str, str]] = None
    sun: bool = False  # also listed in config/sun-cams.json

    @property
    def beach(self) -> Dict[str, Any]:
        return {"lat": self.lat, "lon": self.lon, "timezone": self.timezone}


@dataclass
class Registry:
    cams: List[Cam] = field(default_factory=list)
    problems: List[str] = field(default_factory=list)


def _load(path: Path) -> Any:
    with open(path) as fh:
        return json.load(fh)


def load_registry(config_dir: Optional[Path] = None) -> Registry:
    cdir = Path(config_dir or os.environ.get("COURIER_CONFIG_DIR") or ROOT / "config")
    reg = Registry()
    archive = _load(cdir / "archive-cams.json").get("cams", [])
    vision = _load(cdir / "vision-cams.json")
    sun_doc = _load(cdir / "sun-cams.json")
    extra_path = cdir / "courier-cams.json"
    extra = _load(extra_path) if extra_path.exists() else {}
    ids: Dict[str, str] = dict(extra.get("youtube_ids", {}))
    skip = set(extra.get("skip", []))
    sun_by_id = {c["id"]: c for c in sun_doc.get("cams", [])}
    beaches: Dict[str, Dict[str, Any]] = {}
    for c in archive:
        beaches.setdefault(c["slug"], {"lat": c.get("lat"), "lon": c.get("lon"), "timezone": c.get("timezone")})
    seen: Dict[str, Cam] = {}

    def add(cam_id: str, slug: str, tz: str, lat: Any, lon: Any) -> None:
        if cam_id in seen or cam_id in skip:
            return
        sun = sun_by_id.get(cam_id)
        yid = (sun or {}).get("youtube_id") or ids.get(cam_id)
        if sun and cam_id in ids and ids[cam_id] != sun.get("youtube_id"):
            reg.problems.append(f"{cam_id}: video id differs between sun-cams.json and courier-cams.json")
        if not yid:
            reg.problems.append(f"{cam_id}: no YouTube video id (add it to config/sun-cams.json or config/courier-cams.json)")
        if lat is None or lon is None:
            reg.problems.append(f"{cam_id}: no coordinates for beach {slug}")
        seen[cam_id] = Cam(cam_id, yid, slug, tz, lat, lon, (sun or {}).get("fallback"), sun is not None)

    for c in archive:
        if c.get("source", {}).get("kind") == "direct":
            add(c["id"], c["slug"], c.get("timezone") or "America/New_York", c.get("lat"), c.get("lon"))
    for slug, doc in vision.items():
        b = beaches.get(slug, {})
        for c in doc.get("cams", []):
            if c.get("source", {}).get("kind") == "direct":
                add(c["id"], slug, doc.get("timezone") or b.get("timezone") or "America/New_York", b.get("lat"), b.get("lon"))
    for c in sun_doc.get("cams", []):
        b = c["beaches"][0] if c.get("beaches") else {}
        add(c["id"], b.get("slug", c["id"]), sun_doc.get("timezone", "America/New_York"),
            c.get("lat", b.get("lat")), c.get("lon", b.get("lon")))
    reg.cams = list(seen.values())
    return reg


def grabbable(reg: Registry) -> List[Cam]:
    return [c for c in reg.cams if c.youtube_id and c.lat is not None and c.lon is not None]


# --- Pure scheduling rules --------------------------------------------------------


def routine_run_cap(n_cams: int) -> int:
    """Most cams one routine run may take: enough to cover the hour, plus one."""
    return max(2, math.ceil(n_cams * ROUTINE_TICK_MIN / 60) + 1)


def golden_stride_min(n_active: int) -> int:
    """Minutes between frames of one cam inside a golden window. 10 while the active
    cams fit the golden call budget (1.5 calls per cam per 15 min), then the next
    multiple of the run interval that does."""
    if n_active <= 0:
        return GOLDEN_BASE_STRIDE_MIN
    need = n_active * 15.0 / GOLDEN_BASE_STRIDE_MIN
    mult = max(1, math.ceil(need / GOLDEN_CALL_BUDGET))
    return min(GOLDEN_BASE_STRIDE_MIN * mult, GOLDEN_MAX_STRIDE_MIN)


def golden_run_cap(n_active: int) -> int:
    stride = golden_stride_min(n_active)
    return max(1, math.ceil(n_active * GOLDEN_TICK_MIN / stride))


def in_cooldown(cam_id: str, fails: Dict[str, Dict[str, float]], now: float) -> bool:
    return float(fails.get(cam_id, {}).get("until", 0)) > now


def daylight_eastern(now: float) -> bool:
    """The routine gate: 06:00-20:59 America/New_York. The cams are dark at night."""
    return 6 <= datetime.fromtimestamp(now, ZoneInfo("America/New_York")).hour <= 20


def routine_due(cams: List[Cam], now: float, last_grab: Dict[str, float], fails: Dict[str, Dict[str, float]]) -> List[Cam]:
    if not daylight_eastern(now):
        return []
    cand = []
    for c in cams:
        if in_cooldown(c.id, fails, now):
            continue
        last = last_grab.get(c.id)
        age = math.inf if last is None else (now - last) / 60.0
        if age >= ROUTINE_MIN_AGE_MIN:
            cand.append((age, c))
    cand.sort(key=lambda t: (-t[0], t[1].id))
    return [c for _, c in cand[: routine_run_cap(len(cams))]]


def golden_active(cams: List[Cam], now_dt: datetime) -> List[Tuple[Cam, str]]:
    """Cams whose own beach is inside a golden window right now, with the window kind."""
    out = []
    for c in cams:
        try:
            for kind, start, end in golden_now.windows_for(c.beach, now_dt):
                if start <= now_dt < end:
                    out.append((c, kind))
                    break
        except Exception:  # noqa: BLE001 - a cam with bad data is skipped, not fatal
            continue
    return out


def golden_due(cams: List[Cam], now_dt: datetime, last_grab: Dict[str, float], fails: Dict[str, Dict[str, float]]) -> List[Cam]:
    now = now_dt.timestamp()
    active = [c for c, _ in golden_active(cams, now_dt)]
    stride = golden_stride_min(len(active))
    cand = []
    for c in active:
        if in_cooldown(c.id, fails, now):
            continue
        last = last_grab.get(c.id)
        age = math.inf if last is None else (now - last) / 60.0
        if age >= stride - GOLDEN_GRACE_MIN:
            cand.append((age, c))
    cand.sort(key=lambda t: (-t[0], t[1].id))
    return [c for _, c in cand[: golden_run_cap(len(active))]]


# --- Worker registry cross-check -----------------------------------------------------


def worker_registry_ids(path: Optional[Path] = None) -> Dict[str, str]:
    """{cam id: video id} from workers/uw-frame/src/lib/schedule.ts. The worker's
    /ingest answers 404 for a cam that is not listed there."""
    p = Path(path or ROOT / "workers/uw-frame/src/lib/schedule.ts")
    text = p.read_text()
    return dict(re.findall(r'id:\s*"([^"]+)",\s*videoId:\s*"([^"]+)"', text))


def check(reg: Registry, worker_ids: Optional[Dict[str, str]]) -> List[str]:
    errors = list(reg.problems)
    if worker_ids is not None:
        for c in reg.cams:
            if c.id not in worker_ids:
                errors.append(f"{c.id}: not in workers/uw-frame/src/lib/schedule.ts CAMERA_REGISTRY (and CameraId); POST /ingest would answer 404")
            elif c.youtube_id and worker_ids[c.id] != c.youtube_id:
                errors.append(f"{c.id}: video id {c.youtube_id} here, {worker_ids[c.id]} in the worker registry")
    return errors


# --- Command line -----------------------------------------------------------------------


def _line(c: Cam) -> str:
    fb = c.fallback or {}
    return "|".join([c.id, c.youtube_id or "-", fb.get("page") or "-", fb.get("title_contains") or "-"])


def _now(a: argparse.Namespace) -> datetime:
    if getattr(a, "now", None):
        dt = datetime.fromisoformat(a.now.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def _cmd_due(a: argparse.Namespace) -> int:
    reg = load_registry()
    cams = grabbable(reg)
    for p in reg.problems:
        print(f"courier_schedule: {p}", file=sys.stderr)
    now_dt = _now(a)
    if a.mode == "all":
        due = cams
    else:
        if a.no_state:
            last, fails = {}, {}
        else:
            last, fails = yt_pacer.Pacer(quiet=True).courier_notes()
        due = golden_due(cams, now_dt, last, fails) if a.mode == "golden" else routine_due(cams, now_dt.timestamp(), last, fails)
    for c in due:
        print(_line(c))
    if a.mode == "golden":
        act = golden_active(cams, now_dt)
        if act:
            print(f"courier_schedule: golden: {len(act)} cam(s) in a window, stride {golden_stride_min(len(act))} min, {len(due)} due",
                  file=sys.stderr)
    return 0


def _cmd_mark(a: argparse.Namespace) -> int:
    yt_pacer.Pacer(quiet=True).mark_grab(a.cam, ok=a.ok)
    return 0


def _cmd_list(a: argparse.Namespace) -> int:
    reg = load_registry()
    for c in reg.cams:
        print(f"{c.id:28s} {c.youtube_id or '-':13s} {c.slug:18s} {c.timezone:18s} {'sun ' if c.sun else '    '}{'fallback' if c.fallback else ''}")
    for p in reg.problems:
        print(f"PROBLEM {p}", file=sys.stderr)
    return 0


def _cmd_check(a: argparse.Namespace) -> int:
    reg = load_registry()
    errors = check(reg, worker_registry_ids())
    for e in errors:
        print(f"ERROR {e}", file=sys.stderr)
    print(f"{len(reg.cams)} courier cam(s), {len(errors)} problem(s)")
    return 1 if errors else 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Which cams does the courier grab right now?")
    sub = ap.add_subparsers(dest="sub", required=True)
    p = sub.add_parser("due")
    p.add_argument("--mode", choices=["routine", "golden", "all"], required=True)
    p.add_argument("--now")
    p.add_argument("--no-state", action="store_true", help="ignore last-frame times and cooldowns")
    p.set_defaults(fn=_cmd_due)
    p = sub.add_parser("mark")
    p.add_argument("--cam", required=True)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--ok", action="store_true", default=None)
    g.add_argument("--fail", dest="ok", action="store_false")
    p.set_defaults(fn=_cmd_mark)
    sub.add_parser("list").set_defaults(fn=_cmd_list)
    sub.add_parser("check").set_defaults(fn=_cmd_check)
    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
