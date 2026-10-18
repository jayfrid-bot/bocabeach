#!/usr/bin/env python3
"""Dry run: the day's yt-dlp call timeline, before and after the pacing layer.

    python3 scripts/courier_plan.py                       # today's cams, both models
    python3 scripts/courier_plan.py --extra 35            # + 35 cams (18 Atlantic, 17 Gulf)
    python3 scripts/courier_plan.py --extra 35 --model new --timeline
    python3 scripts/courier_plan.py --date 2026-06-21 --extra 35

It runs the REAL scheduling rules (scripts/courier_schedule.py: which cam is due,
golden stride) and the REAL pacer rule (scripts/yt_pacer.py: earliest_allowed) over a
simulated day, with the real sunrise and sunset times of each cam. Nothing touches the
network, the state file or the server.

Three models:
  today   what is LOADED on the home server on 2026-10-17: the legacy code without the
          golden job (launchctl shows only camcourier and suncam).
  legacy  the code on main before the pacer: the hourly :07 run grabs every cam, the
          golden run grabs EVERY cam every 10 minutes while ANY of the four original
          beaches is in a window, the sun-cam check re-issues the manifest every 18 s
          (3 yt-dlp -J calls per cam-event). No cap, no cache.
  new     the pacing layer: routine runs every 5 minutes take a few due cams, golden
          runs take only the cams whose own beach is in a window (stride widens when
          many cams share a window), the sun-cam check uses one call per cam-event, and
          every call waits for a slot under the 60-per-15-minutes cap.

Assumptions (stated, not hidden): every stream works and every grab succeeds; a courier
cam takes 6 s (resolve, ffmpeg, upload); a sun-cam event takes 30 s (new) or 50 s
(legacy); the Mac's clock is America/New_York; the legacy golden job is counted as
installed (on the home server today it is NOT loaded; "today" below says both). The
sun-cam launchd job fires at :16 and :46 (seen in the server log).
"""

from __future__ import annotations

import argparse
import heapq
import json
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import courier_schedule as cs  # noqa: E402
import golden_now  # noqa: E402
import sun_cam_check as sc  # noqa: E402
import yt_pacer as yp  # noqa: E402

ET = ZoneInfo("America/New_York")
COURIER_CAM_S = 6.0  # resolve + ffmpeg + upload for one cam
SUN_EVENT_S_NEW = 30.0
SUN_EVENT_S_LEGACY = 50.0  # measured in the server log: 47-52 s for 25 frames
LEGACY_J_CALLS = 3  # initial issue + a refresh every 18 s over ~50 s
LEGACY_J_SPACING_S = 17.0
SUN_RUN_MINUTES = (16, 46)
LEGACY_GOLDEN_FIRE_HOURS = (6, 7, 8, 16, 17, 18, 19, 20)  # plus 21:00 and 21:10
LIMIT_15MIN = 150  # where YouTube starts answering "not a bot"
TARGET_15MIN = 60

# Representative spots for cams that do not exist yet: (name, lat, lon, tz)
ATLANTIC = [("atl-sarasota-ish", 27.0, -80.1, "America/New_York"), ("atl-cocoa", 28.4, -80.6, "America/New_York"),
            ("atl-jax", 30.3, -81.4, "America/New_York"), ("atl-savannah", 32.0, -80.9, "America/New_York"),
            ("atl-myrtle", 33.7, -78.9, "America/New_York"), ("atl-obx", 35.2, -75.5, "America/New_York"),
            ("atl-palmbeach", 26.7, -80.0, "America/New_York")]
GULF = [("gulf-clearwater", 27.9, -82.8, "America/New_York"), ("gulf-naples", 26.1, -81.8, "America/New_York"),
        ("gulf-panama-city", 30.2, -85.8, "America/Chicago"), ("gulf-destin", 30.4, -86.5, "America/Chicago"),
        ("gulf-gulf-shores", 30.3, -87.7, "America/Chicago"), ("gulf-galveston", 29.3, -94.8, "America/Chicago"),
        ("gulf-corpus", 27.8, -97.1, "America/Chicago")]


@dataclass
class Call:
    t: float
    job: str  # courier-routine, courier-golden, suncam
    cam: str
    priority: str
    kind: str  # "-g" or "-J"


@dataclass
class Result:
    model: str
    calls: List[Call] = field(default_factory=list)
    dropped: int = 0
    skipped_runs: int = 0
    runs: Dict[str, int] = field(default_factory=dict)
    sun_events: int = 0
    hls_fetches: int = 0  # playlist fetches (googlevideo, not the yt-dlp path); informational


def synthetic_cams(n_extra: int) -> List[cs.Cam]:
    n_atl = round(n_extra * 18 / 35)
    out = []
    for i in range(n_extra):
        pool = ATLANTIC if i < n_atl else GULF
        name, lat, lon, tz = pool[i % len(pool)]
        out.append(cs.Cam(f"{name}-{i + 1}", f"SYN{i:08d}", f"{name}-{i + 1}", tz, lat, lon, None, True))
    return out


def day_bounds(day: date) -> Tuple[float, float]:
    start = datetime(day.year, day.month, day.day, tzinfo=ET)
    end = datetime.combine(day + timedelta(days=1), datetime.min.time(), tzinfo=ET)
    return start.timestamp(), end.timestamp()


def sun_events_for(cam: cs.Cam, day: date) -> List[Tuple[str, float]]:
    out = []
    for off in (-1, 0, 1):
        t = sc.sun_times(cam.lat, cam.lon, day + timedelta(days=off))
        for kind in ("sunrise", "sunset"):
            if t.get(kind):
                out.append((f"{day + timedelta(days=off)}|{kind}", t[kind].timestamp()))
    return out


# ---------------------------------------------------------------------------
# Event-driven simulation. A "run" is a list of steps; each step asks for one
# yt-dlp call, then occupies the run for `dur` seconds.
# ---------------------------------------------------------------------------


@dataclass
class Run:
    job: str
    cams: List[Any]  # cs.Cam, or (cam, event key) for the sun-cam check
    priority: str
    kind: str
    dur: float
    n_calls: int = 1
    spacing: float = 0.0
    i: int = 0
    first_req: float = 0.0


def simulate(model: str, day: date, courier_cams: List[cs.Cam], sun_cams: List[cs.Cam], beaches: Dict[str, dict]) -> Result:
    res = Result(model)
    lo, hi = day_bounds(day)
    new = model == "new"
    golden_installed = model != "today"  # "today" = what is loaded on the server: no golden job
    caps = dict(yp.TIER_CAPS)
    ledger: List[float] = []  # pacer ledger (new model only)
    last_grab: Dict[str, float] = {}
    fails: Dict[str, Dict[str, float]] = {}
    sun_done: set = set()
    busy_until = {"courier": 0.0, "sun": 0.0}
    heap: List[Tuple[float, int, str, Any]] = []
    seq = 0

    def push(t: float, what: str, payload: Any) -> None:
        nonlocal seq
        seq += 1
        heapq.heappush(heap, (t, seq, what, payload))

    # --- launchd fire times -------------------------------------------------
    t = lo
    while t < hi:
        loc = datetime.fromtimestamp(t, ET)
        h, m = loc.hour, loc.minute
        if new:
            if m % 5 == 3:
                push(t, "start", ("courier-routine", None))
            if m % 10 == 0:
                push(t, "start", ("courier-golden", None))
        else:
            if m == 7:
                push(t, "start", ("courier-routine", None))
            if golden_installed and m % 10 == 0 and (h in LEGACY_GOLDEN_FIRE_HOURS or (h == 21 and m in (0, 10))):
                push(t, "start", ("courier-golden", None))
        if m in SUN_RUN_MINUTES:
            push(t, "start", ("suncam", None))
        t += 60

    def steps_for_start(job: str, now: float) -> Optional[Run]:
        loc = datetime.fromtimestamp(now, ET)
        now_dt = datetime.fromtimestamp(now, timezone.utc)
        if job == "courier-routine":
            if not (6 <= loc.hour <= 20):
                return None
            due = cs.routine_due(courier_cams, now, last_grab, fails) if new else list(courier_cams)
            return Run(job, due, "routine", "-g", COURIER_CAM_S) if due else None
        if job == "courier-golden":
            if new:
                due = cs.golden_due(courier_cams, now_dt, last_grab, fails)
            else:
                hit = golden_now.golden_hit(golden_now.COURIER_SLUGS, now_dt, beaches)
                due = list(courier_cams) if hit else []
            return Run(job, due, "golden", "-g", COURIER_CAM_S) if due else None
        # suncam: every cam-event that ended 25 min .. 3.5 h ago and is not done
        items = []
        for cam in sun_cams:
            for key, ev in sun_events_for(cam, day):
                age = (now - ev) / 60.0
                k = f"{cam.id}|{key}"
                if sc.MIN_AGE_MIN <= age <= sc.MAX_AGE_MIN and k not in sun_done:
                    items.append((cam, k))
        if not items:
            return None
        if new:
            return Run(job, items, "sun", "-J", SUN_EVENT_S_NEW, 1, 0.0)
        return Run(job, items, "sun", "-J", SUN_EVENT_S_LEGACY, LEGACY_J_CALLS, LEGACY_J_SPACING_S)

    def lock_name(job: str) -> str:
        return "sun" if job == "suncam" else "courier"

    while heap:
        t, _, what, payload = heapq.heappop(heap)
        if t >= hi + 3600:
            break
        if what == "start":
            job = payload[0]
            lk = lock_name(job)
            if t < busy_until[lk]:
                res.skipped_runs += 1
                continue
            run = steps_for_start(job, t)
            if run is None:
                continue
            res.runs[job] = res.runs.get(job, 0) + 1
            busy_until[lk] = float("inf")
            run.first_req = t
            push(t, "step", run)
        elif what == "step":
            run: Run = payload
            lk = lock_name(run.job)
            if run.i >= len(run.cams):
                busy_until[lk] = t
                continue
            item = run.cams[run.i]
            cam = item[0] if isinstance(item, tuple) else item
            if new:
                cal = [c for c in ledger if c > t - yp.WINDOW_S]
                g, why = yp.earliest_allowed(cal, t, run.priority, caps=caps)
                max_wait = yp.DEFAULT_MAX_WAIT_S[run.priority]
                if g > t:
                    if g - run.first_req > max_wait:
                        res.dropped += 1
                        run.i += 1
                        run.first_req = t
                        push(t, "step", run)
                    else:
                        push(g, "step", run)
                    continue
                ledger.append(t)
            res.calls.append(Call(t, run.job, cam.id, run.priority, run.kind))
            # the rest of this cam's calls (legacy sun-cam: refreshes every 17 s)
            for k in range(1, run.n_calls):
                res.calls.append(Call(t + k * run.spacing, run.job, cam.id, run.priority, run.kind))
            if run.job == "suncam":
                sun_done.add(item[1])
                res.sun_events += 1
                res.hls_fetches += run.n_calls
            else:
                last_grab[cam.id] = t + run.dur
                fails.pop(cam.id, None)
            run.i += 1
            run.first_req = t + run.dur
            push(t + run.dur, "step", run)
    res.calls.sort(key=lambda c: c.t)
    return res


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def rolling_peak(times: List[float], window_s: float) -> Tuple[int, float]:
    """(most calls in any window of window_s seconds, the end time of that window)."""
    best, best_t, j = 0, 0.0, 0
    for i, t in enumerate(times):
        while times[j] <= t - window_s:
            j += 1
        if i - j + 1 > best:
            best, best_t = i - j + 1, t
    return best, best_t


def hhmm(t: float) -> str:
    return datetime.fromtimestamp(t, ET).strftime("%H:%M")


def summarize(res: Result) -> Dict[str, Any]:
    times = [c.t for c in res.calls]
    p15, t15 = rolling_peak(times, 900)
    p60, t60 = rolling_peak(times, 3600)
    by_job: Dict[str, int] = {}
    for c in res.calls:
        by_job[c.job] = by_job.get(c.job, 0) + 1
    return {
        "model": res.model, "calls_per_day": len(times), "by_job": by_job,
        "peak_15min": p15, "peak_15min_ends": hhmm(t15) if times else "-",
        "peak_hour": p60, "peak_hour_ends": hhmm(t60) if times else "-",
        "dropped": res.dropped, "skipped_runs": res.skipped_runs, "sun_events": res.sun_events,
        "hls_playlist_fetches_from_sun": res.hls_fetches,
    }


def verdict(peak15: int) -> str:
    if peak15 > LIMIT_15MIN:
        return f"OVER the ~{LIMIT_15MIN} limit: YouTube would block this IP"
    if peak15 > TARGET_15MIN:
        return f"under the limit but over the {TARGET_15MIN} target"
    return f"within the {TARGET_15MIN} target"


def print_summary(label: str, s: Dict[str, Any]) -> None:
    print(f"  [{s['model']}] {label}")
    print(f"      yt-dlp calls per day : {s['calls_per_day']}   " + ", ".join(f"{k} {v}" for k, v in sorted(s['by_job'].items())))
    print(f"      busiest hour         : {s['peak_hour']} calls (ends {s['peak_hour_ends']} ET)")
    print(f"      busiest 15 minutes   : {s['peak_15min']} calls (ends {s['peak_15min_ends']} ET)  -> {verdict(s['peak_15min'])}")
    if s["model"] == "new":
        print(f"      refused for budget   : {s['dropped']} calls   runs skipped by the run lock: {s['skipped_runs']}")
    print(f"      sun-cam events       : {s['sun_events']}   playlist fetches from sun-cam sessions: {s['hls_playlist_fetches_from_sun']}")


def print_timeline(res: Result, around: Optional[float], span_s: float = 900.0, everything: bool = False) -> None:
    calls = res.calls
    if not everything:
        if around is None:
            _, around = rolling_peak([c.t for c in calls], span_s)
        calls = [c for c in calls if around - span_s < c.t <= around]
        print(f"      timeline of the busiest 15 minutes ({hhmm(around - span_s)}-{hhmm(around)} ET), {len(calls)} calls:")
    for c in calls:
        print(f"        {datetime.fromtimestamp(c.t, ET).strftime('%H:%M:%S')}  {c.job:15s} {c.priority:8s} yt-dlp {c.kind}  {c.cam}")


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Dry run of the courier's yt-dlp call timeline.")
    ap.add_argument("--date", help="local date YYYY-MM-DD (default today, America/New_York)")
    ap.add_argument("--extra", type=int, default=0, help="extra cams to add to the courier AND the sun-cam check")
    ap.add_argument("--extra-sun", type=int, help="of those, how many also go in the sun-cam check (default all)")
    ap.add_argument("--model", choices=["new", "legacy", "today", "all", "both"], default="all")
    ap.add_argument("--timeline", action="store_true", help="also list the calls of the busiest 15 minutes")
    ap.add_argument("--timeline-all", action="store_true", help="list every call of the day")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)

    day = date.fromisoformat(a.date) if a.date else datetime.now(ET).date()
    reg = cs.load_registry()
    base = cs.grabbable(reg)
    sun_base = [c for c in base if c.sun]
    extra = synthetic_cams(a.extra)
    n_sun_extra = a.extra if a.extra_sun is None else min(a.extra_sun, a.extra)
    courier_cams = base + extra
    sun_cams = sun_base + extra[:n_sun_extra]
    beaches = golden_now.load_beaches()
    label = f"{day}: {len(courier_cams)} courier cams ({len(base)} real + {len(extra)} planned), {len(sun_cams)} sun cams"

    models = ["today", "legacy", "new"] if a.model in ("all", "both") else [a.model]
    out = []
    print(f"PLAN {label}")
    for m in models:
        res = simulate(m, day, courier_cams, sun_cams, beaches)
        s = summarize(res)
        out.append(s)
        if not a.json:
            print_summary(m, s)
            if a.timeline or a.timeline_all:
                print_timeline(res, None, everything=a.timeline_all)
    if a.json:
        print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
