#!/usr/bin/env python3
"""One shared pacer for every yt-dlp call on the home server.

WHY: YouTube answers "Sign in to confirm you're not a bot" when one IP makes too
many yt-dlp calls in a short time (about 150 calls in 15 minutes from the home
IP). The answer lasts about 10 minutes and it breaks EVERY job on that IP: the
cam courier, the golden-hour courier and the sun-cam check. Three separate
programs share that IP, so the limit has to be kept in ONE place they all use.
That place is this file.

HOW IT WORKS
  * A ledger of recent calls lives in one JSON file (see STATE_DIR) behind an
    flock. Every program asks `acquire()` before it starts a yt-dlp call.
  * HARD CAP: at most 60 calls in any rolling 15 minutes, all programs together.
    The cap has three tiers, so sunrise and sunset work beats routine work:
        golden   60   golden-hour courier shots (fresh frames, cannot wait)
        sun      48   sun-cam DVR sessions (can wait, the DVR keeps 4 hours)
        routine  36   the hourly shore reads
    A routine call is allowed only while fewer than 36 calls are in the window,
    so 24 slots stay free for golden and sun work.
  * SPACING: calls start at least 4 seconds apart, so a burst of cams is never a
    burst of requests.
  * BACKOFF: when a yt-dlp call answers with the bot check (or HTTP 429), the
    pacer writes a backoff mark. For the next 20 minutes `acquire()` refuses
    every call from every program. The line is logged.
  * CACHE: a tiny key/value cache with a time to live. It holds (a) the HLS URL
    a call just resolved, for 20 seconds, and (b) the video id that last worked
    for a cam whose stream id changes (Elbo Room), for 12 hours.

WHAT THE URL CACHE CAN AND CANNOT DO (measured 2026-10-16, android_vr client):
  The URL in a yt-dlp answer says it lives 6 hours (`/expire/<epoch>/`). Its
  SEGMENTS do not: they play for about 25 seconds after yt-dlp issued the URL
  and answer 403 after about 30 seconds, even when the playlist is fetched again
  and even for the newest segments. So a frame grab needs a fresh yt-dlp call
  once per grab, and the cache TTL is 20 seconds, not 6 hours. The savings come
  from grabbing fewer times (see scripts/courier_schedule.py) and from taking
  many DVR frames from ONE call (see DvrSession.prefetch in sun_cam_check.py).

COMMAND LINE (the shell courier uses this; stdlib only, Python 3.9+):
  yt_pacer.py resolve  --video ID --cam CAM [--priority P] [--max-wait S]
        print the HLS URL for a stream (cache, else one paced `yt-dlp -g`)
  yt_pacer.py fallback --cam CAM --page URL --title-contains WORD [--priority P]
        find the cam's CURRENT video id from its web page; remember it 12 h
  yt_pacer.py exec     --priority P --label L [--timeout S] -- CMD ARGS...
        run any command (yt-dlp) under the pacer
  yt_pacer.py status [--json]      calls in the window, per tier, backoff
  yt_pacer.py backoff-check        exit 0 if a backoff is active, else 1
  yt_pacer.py cache-get KEY | cache-put KEY VALUE --ttl S
Exit codes of resolve / fallback / exec:
  0 ok   1 the call itself failed   75 refused: backoff   76 refused: over budget
  77 the call ran and hit the bot check (backoff has just been set)
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

# --- The numbers (every one can be overridden by an environment variable) ----
WINDOW_S = 900  # the rolling window the cap is measured over: 15 minutes
TIER_CAPS: Dict[str, int] = {"golden": 60, "sun": 48, "routine": 36}
HARD_CAP = 60  # no tier may ever exceed this
MIN_GAP_S = 4.0  # least time between two call starts, all programs together
BACKOFF_S = 1200  # 20 minutes of silence after a bot check
URL_TTL_S = 20  # HLS URL cache: its segments play ~25 s, 403 at ~30 s (measured)
VIDEO_ID_TTL_S = 12 * 3600  # how long a rediscovered stream id is trusted
LEDGER_KEEP_S = 2 * 3600  # how much call history the state file keeps
DEFAULT_MAX_WAIT_S = {"golden": 300.0, "sun": 900.0, "routine": 120.0}

EXIT_BACKOFF = 75
EXIT_BUDGET = 76
EXIT_BOT_CHECK = 77

BOT_CHECK_RE = re.compile(
    r"confirm you.{0,8}re not a bot|sign in to confirm|HTTP Error 429|Too Many Requests",
    re.IGNORECASE,
)

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


def default_state_dir() -> Path:
    return Path(
        os.environ.get(
            "YTPACE_DIR",
            str(Path.home() / "Library/Application Support/isitbeachday/ytpace"),
        )
    )


def iso_z(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str, clock: Callable[[], float] = time.time) -> None:
    print(f"{iso_z(clock())} pacer: {msg}", file=sys.stderr, flush=True)


# ===========================================================================
# The pure rule: when may the next call start?
# ===========================================================================


def earliest_allowed(
    calls: List[float],
    now: float,
    priority: str,
    *,
    caps: Optional[Dict[str, int]] = None,
    window: float = WINDOW_S,
    min_gap: float = MIN_GAP_S,
    backoff_until: float = 0.0,
) -> Tuple[float, Optional[str]]:
    """(time, reason). `time` is the earliest instant a `priority` call may start,
    never before `now`. `reason` is "backoff" when a backoff mark is still active
    (then `time` is the end of the backoff), else None.

    `calls` holds the start times of calls already allowed. A call fits when
    fewer than cap(priority) calls started in the window before it."""
    caps = caps or TIER_CAPS
    cap = min(caps.get(priority, caps["routine"]), HARD_CAP)
    if backoff_until > now:
        return backoff_until, "backoff"
    if cap <= 0:
        return float("inf"), None  # a tier set to 0 never gets a call
    ordered = sorted(calls)
    t = now
    if ordered:
        t = max(t, ordered[-1] + min_gap)
    n = len(ordered)
    if n >= cap:
        # the (n - cap + 1) newest calls may stay; every older one must have left the window
        t = max(t, ordered[n - cap] + window)
    return t, None


def detect_bot_check(text: str) -> bool:
    return bool(BOT_CHECK_RE.search(text or ""))


def url_expiry(url: str) -> Optional[float]:
    m = re.search(r"/expire/(\d+)", url or "")
    return float(m.group(1)) if m else None


# ===========================================================================
# State file: a ledger, a backoff mark, a cache, the courier's per-cam notes
# ===========================================================================


class PaceState:
    """One JSON file under an flock. `with state.locked() as doc:` gives the dict;
    it is written back (atomically) when the block ends without an error."""

    def __init__(self, directory: Optional[Path] = None):
        self.dir = Path(directory) if directory else default_state_dir()
        self.path = self.dir / "state.json"
        self.lock_path = self.dir / "lock"

    @contextlib.contextmanager
    def locked(self) -> Iterator[Dict[str, Any]]:
        self.dir.mkdir(parents=True, exist_ok=True)
        with open(self.lock_path, "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                doc = self._read()
                yield doc
                self._write(doc)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def snapshot(self) -> Dict[str, Any]:
        with self.locked() as doc:
            return json.loads(json.dumps(doc))

    def _read(self) -> Dict[str, Any]:
        try:
            doc = json.loads(self.path.read_text())
            if not isinstance(doc, dict):
                raise ValueError("state is not an object")
        except (OSError, ValueError):
            doc = {}
        doc.setdefault("calls", [])  # [[start_epoch, priority, label], ...]
        doc.setdefault("backoff", None)  # {"until": epoch, "set_at": epoch, "reason": str}
        doc.setdefault("cache", {})  # key -> {"value": str, "expires": epoch}
        doc.setdefault("last_grab", {})  # cam id -> epoch of the last good frame
        doc.setdefault("fails", {})  # cam id -> {"n": int, "until": epoch}
        return doc

    def _write(self, doc: Dict[str, Any]) -> None:
        tmp = self.path.with_name(f".state.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(doc, separators=(",", ":")))
        os.replace(tmp, self.path)


@dataclass
class Grant:
    ok: bool
    reason: Optional[str] = None  # "backoff" or "budget" when ok is False
    waited: float = 0.0
    until: Optional[float] = None  # when a backoff ends


@dataclass
class RunResult:
    status: str  # "ok", "failed", "backoff", "budget", "bot-check"
    returncode: int
    stdout: str = ""
    stderr: str = ""

    @property
    def exit_code(self) -> int:
        return {"backoff": EXIT_BACKOFF, "budget": EXIT_BUDGET, "bot-check": EXIT_BOT_CHECK}.get(
            self.status, self.returncode
        )


class Pacer:
    def __init__(
        self,
        state_dir: Optional[Path] = None,
        *,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        quiet: bool = False,
    ):
        self.state = PaceState(state_dir)
        self.clock = clock
        self.sleep = sleep
        self.quiet = quiet
        self.caps = dict(TIER_CAPS)
        self.window = _env_float("YTPACE_WINDOW_S", WINDOW_S)
        self.min_gap = _env_float("YTPACE_MIN_GAP_S", MIN_GAP_S)
        self.backoff_s = _env_float("YTPACE_BACKOFF_S", BACKOFF_S)
        for tier in self.caps:
            self.caps[tier] = min(int(_env_float(f"YTPACE_CAP_{tier.upper()}", self.caps[tier])), HARD_CAP)

    def _say(self, msg: str) -> None:
        if not self.quiet:
            log(msg, self.clock)

    # --- the gate -----------------------------------------------------------

    def acquire(self, priority: str, label: str = "", max_wait_s: Optional[float] = None) -> Grant:
        """Wait (up to max_wait_s) for permission to start one yt-dlp call, and
        book it. Refuses at once during a backoff, or when the wait would be too long."""
        if priority not in self.caps:
            priority = "routine"
        if max_wait_s is None:
            max_wait_s = DEFAULT_MAX_WAIT_S[priority]
        started = self.clock()
        while True:
            with self.state.locked() as doc:
                now = self.clock()
                self._prune(doc, now)
                bo = doc.get("backoff")
                until = float(bo["until"]) if bo else 0.0
                calls = [c[0] for c in doc["calls"] if c[0] > now - self.window]
                t, reason = earliest_allowed(
                    calls, now, priority, caps=self.caps, window=self.window,
                    min_gap=self.min_gap, backoff_until=until,
                )
                if reason == "backoff":
                    return Grant(False, "backoff", now - started, until)
                if t <= now:
                    doc["calls"].append([now, priority, label])
                    return Grant(True, None, now - started)
                if t - started > max_wait_s:
                    slot = "never (this tier is set to 0)" if t == float("inf") else f"in {int(t - now)} s"
                    self._say(f"{priority} call for {label or '?'} refused: {len(calls)} calls in the last "
                              f"{int(self.window / 60)} min, next slot {slot}, would wait past {int(max_wait_s)} s")
                    return Grant(False, "budget", now - started)
                wait = min(t - now, 5.0)
            self.sleep(max(wait, 0.05))

    def _prune(self, doc: Dict[str, Any], now: float) -> None:
        doc["calls"] = [c for c in doc["calls"] if c[0] > now - LEDGER_KEEP_S]
        bo = doc.get("backoff")
        if bo and float(bo["until"]) <= now:
            doc["backoff"] = None
        doc["cache"] = {k: v for k, v in doc["cache"].items() if float(v["expires"]) > now}

    # --- backoff -------------------------------------------------------------

    def set_backoff(self, label: str, detail: str) -> float:
        with self.state.locked() as doc:
            now = self.clock()
            until = now + self.backoff_s
            cur = doc.get("backoff")
            if cur and float(cur["until"]) > until:
                until = float(cur["until"])
            doc["backoff"] = {"until": until, "set_at": now, "reason": f"{label}: {detail[:160]}"}
        self._say(f"BOT CHECK from {label or '?'}: every yt-dlp job backs off for {int(self.backoff_s / 60)} min, until {iso_z(until)}")
        return until

    def backoff_until(self) -> float:
        with self.state.locked() as doc:
            self._prune(doc, self.clock())
            bo = doc.get("backoff")
            return float(bo["until"]) if bo else 0.0

    def in_backoff(self) -> bool:
        return self.backoff_until() > self.clock()

    # --- cache ----------------------------------------------------------------

    def cache_get(self, key: str) -> Optional[str]:
        with self.state.locked() as doc:
            ent = doc["cache"].get(key)
            if ent and float(ent["expires"]) > self.clock():
                return str(ent["value"])
            doc["cache"].pop(key, None)
            return None

    def cache_put(self, key: str, value: str, ttl_s: float) -> None:
        with self.state.locked() as doc:
            doc["cache"][key] = {"value": value, "expires": self.clock() + ttl_s}

    def cache_drop(self, key: str) -> None:
        with self.state.locked() as doc:
            doc["cache"].pop(key, None)

    # --- running yt-dlp -------------------------------------------------------

    def run(
        self,
        cmd: List[str],
        priority: str,
        label: str,
        timeout_s: float = 60.0,
        max_wait_s: Optional[float] = None,
    ) -> RunResult:
        """Run one yt-dlp command under the pacer. Never raises for a refusal."""
        grant = self.acquire(priority, label, max_wait_s)
        if not grant.ok:
            return RunResult(grant.reason or "budget", 1, "", f"pacer refused ({grant.reason})")
        try:
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True
            )
        except OSError as exc:
            return RunResult("failed", 127, "", str(exc))
        try:
            out, err = proc.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(proc.pid, signal.SIGKILL)
            out, err = proc.communicate()
            return RunResult("failed", 124, out or "", (err or "") + "\ntimed out")
        if detect_bot_check(err) or detect_bot_check(out):
            self.set_backoff(label, (err or out).strip().splitlines()[-1] if (err or out).strip() else "bot check")
            return RunResult("bot-check", proc.returncode or 1, out, err)
        return RunResult("ok" if proc.returncode == 0 else "failed", proc.returncode, out, err)

    # --- per-cam notes the courier keeps in the same file -------------------

    def mark_grab(self, cam: str, ok: bool, *, base_min: float = 10.0, max_min: float = 120.0) -> None:
        """A good frame resets the cam; a failure starts (or doubles) its cooldown."""
        with self.state.locked() as doc:
            now = self.clock()
            if ok:
                doc["last_grab"][cam] = now
                doc["fails"].pop(cam, None)
            else:
                n = int(doc["fails"].get(cam, {}).get("n", 0)) + 1
                wait = min(base_min * (2 ** (n - 1)), max_min) * 60
                doc["fails"][cam] = {"n": n, "until": now + wait}

    def courier_notes(self) -> Tuple[Dict[str, float], Dict[str, Dict[str, float]]]:
        with self.state.locked() as doc:
            return dict(doc["last_grab"]), {k: dict(v) for k, v in doc["fails"].items()}

    # --- reporting -------------------------------------------------------------

    def usage(self) -> Dict[str, Any]:
        with self.state.locked() as doc:
            now = self.clock()
            self._prune(doc, now)
            recent = [c for c in doc["calls"] if c[0] > now - self.window]
            by_tier: Dict[str, int] = {}
            for c in recent:
                by_tier[c[1]] = by_tier.get(c[1], 0) + 1
            bo = doc.get("backoff")
            return {
                "now": iso_z(now),
                "window_min": int(self.window / 60),
                "calls_in_window": len(recent),
                "by_tier": by_tier,
                "caps": dict(self.caps),
                "calls_last_hour": len([c for c in doc["calls"] if c[0] > now - 3600]),
                "backoff_until": iso_z(float(bo["until"])) if bo else None,
                "backoff_reason": bo.get("reason") if bo else None,
            }


# ===========================================================================
# Resolving a stream, and finding a cam's new video id
# ===========================================================================


def ytdlp_get_url_cmd(video_id: str) -> List[str]:
    return [
        "yt-dlp", "-g", "--no-warnings", "--socket-timeout", "20",
        "-f", "best[height<=720]/best",
        f"https://www.youtube.com/watch?v={video_id}",
    ]


def resolve_url(pacer: Pacer, video_id: str, cam: str, priority: str, max_wait_s: Optional[float] = None) -> RunResult:
    """The HLS URL for a stream. A URL issued in the last URL_TTL_S seconds is
    reused; otherwise one paced `yt-dlp -g` call."""
    key = f"url:{video_id}"
    hit = pacer.cache_get(key)
    if hit:
        return RunResult("ok", 0, hit + "\n", "")
    res = pacer.run(ytdlp_get_url_cmd(video_id), priority, cam, timeout_s=45, max_wait_s=max_wait_s)
    if res.status == "ok":
        first = (res.stdout.strip().splitlines() or [""])[0]
        if first.startswith("http"):
            ttl = URL_TTL_S
            exp = url_expiry(first)
            if exp:
                ttl = max(0.0, min(ttl, exp - pacer.clock() - 60))
            pacer.cache_put(key, first, ttl)
        else:
            res = RunResult("failed", 1, res.stdout, res.stderr + "\nno URL in yt-dlp output")
    return res


def candidate_ids(page_html: str) -> List[str]:
    """Video ids in a cam page's embedded live-chat links, first-seen order."""
    seen: List[str] = []
    for cand in re.findall(r"live_chat\?v=([A-Za-z0-9_-]{6,})", page_html):
        if cand not in seen:
            seen.append(cand)
    return seen


def find_fallback_video_id(
    pacer: Pacer,
    cam: str,
    page_url: str,
    title_contains: str,
    priority: str,
    fetch: Optional[Callable[[str], str]] = None,
) -> Tuple[Optional[str], str]:
    """Rediscover a cam's CURRENT stream id from its own web page.

    Returns (video_id, status). status is "ok", "none" (no candidate matched or
    the page failed), or "backoff" / "budget" / "bot-check" when the pacer stopped
    the search. The id of a match is remembered for VIDEO_ID_TTL_S, so later runs
    start with it and skip this search (callers read `vid:<cam>` from the cache and
    call this only after that id failed). One paced `--print title` call per
    candidate (the caller's own `-g` then proves the stream plays)."""
    pacer.cache_drop(f"vid:{cam}")  # the remembered id just failed, or we would not be here
    try:
        if fetch:
            html = fetch(page_url)
        else:
            req = urllib.request.Request(page_url, headers={"User-Agent": UA})
            html = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - best effort
        log(f"{cam}: fallback page fetch failed: {exc}")
        return None, "none"
    for cand in candidate_ids(html):
        res = pacer.run(
            ["yt-dlp", "--no-warnings", "--socket-timeout", "15", "--print", "%(title)s",
             f"https://www.youtube.com/watch?v={cand}"],
            priority, cam, timeout_s=40,
        )
        if res.status in ("backoff", "budget", "bot-check"):
            return None, res.status
        if res.status == "ok" and title_contains in res.stdout:
            pacer.cache_put(f"vid:{cam}", cand, VIDEO_ID_TTL_S)
            log(f"{cam}: fallback video id -> {cand} (title: {res.stdout.strip()[:80]})")
            return cand, "ok"
    log(f"{cam}: no stream with \"{title_contains}\" in its title found on {page_url}")
    return None, "none"


# ===========================================================================
# Command line
# ===========================================================================


def _cmd_resolve(a: argparse.Namespace) -> int:
    pacer = Pacer()
    res = resolve_url(pacer, a.video, a.cam, a.priority, a.max_wait)
    if res.status == "ok":
        sys.stdout.write(res.stdout)
        return 0
    sys.stderr.write((res.stderr or "").rstrip()[-600:] + "\n")
    return res.exit_code or 1


def _cmd_fallback(a: argparse.Namespace) -> int:
    pacer = Pacer()
    vid, status = find_fallback_video_id(pacer, a.cam, a.page, a.title_contains, a.priority)
    if vid:
        print(vid)
        return 0
    return {"backoff": EXIT_BACKOFF, "budget": EXIT_BUDGET, "bot-check": EXIT_BOT_CHECK}.get(status, 1)


def _cmd_exec(a: argparse.Namespace) -> int:
    if not a.cmd:
        print("exec needs a command after --", file=sys.stderr)
        return 2
    pacer = Pacer()
    res = pacer.run(a.cmd, a.priority, a.label, timeout_s=a.timeout, max_wait_s=a.max_wait)
    sys.stdout.write(res.stdout)
    sys.stderr.write(res.stderr)
    return res.exit_code


def _cmd_status(a: argparse.Namespace) -> int:
    u = Pacer(quiet=True).usage()
    if a.json:
        print(json.dumps(u, indent=2))
        return 0
    print(f"{u['calls_in_window']} yt-dlp calls in the last {u['window_min']} min "
          f"(cap {HARD_CAP}; by tier {u['by_tier'] or 'none'}); {u['calls_last_hour']} in the last hour")
    print(f"backoff: {('until ' + u['backoff_until'] + ' (' + str(u['backoff_reason']) + ')') if u['backoff_until'] else 'none'}")
    return 0


def _cmd_backoff_check(a: argparse.Namespace) -> int:
    pacer = Pacer(quiet=True)
    until = pacer.backoff_until()
    if until > pacer.clock():
        print(f"backing off until {iso_z(until)}")
        return 0
    return 1


def _cmd_cache_get(a: argparse.Namespace) -> int:
    v = Pacer(quiet=True).cache_get(a.key)
    if v is None:
        return 1
    print(v)
    return 0


def _cmd_cache_put(a: argparse.Namespace) -> int:
    Pacer(quiet=True).cache_put(a.key, a.value, a.ttl)
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="sub", required=True)

    def add_prio(p: argparse.ArgumentParser) -> None:
        p.add_argument("--priority", choices=sorted(TIER_CAPS), default="routine")
        p.add_argument("--max-wait", type=float, default=None, help="seconds to wait for a slot (default per tier)")

    p = sub.add_parser("resolve", help="print the HLS URL for a stream")
    p.add_argument("--video", required=True)
    p.add_argument("--cam", required=True)
    add_prio(p)
    p.set_defaults(fn=_cmd_resolve)

    p = sub.add_parser("fallback", help="find a cam's current video id from its web page")
    p.add_argument("--cam", required=True)
    p.add_argument("--page", required=True)
    p.add_argument("--title-contains", default="")
    add_prio(p)
    p.set_defaults(fn=_cmd_fallback)

    p = sub.add_parser("exec", help="run a command under the pacer")
    p.add_argument("--label", default="exec")
    p.add_argument("--timeout", type=float, default=60.0)
    add_prio(p)
    p.add_argument("cmd", nargs=argparse.REMAINDER)
    p.set_defaults(fn=_cmd_exec)

    p = sub.add_parser("status")
    p.add_argument("--json", action="store_true")
    p.set_defaults(fn=_cmd_status)

    p = sub.add_parser("backoff-check")
    p.set_defaults(fn=_cmd_backoff_check)

    p = sub.add_parser("cache-get")
    p.add_argument("key")
    p.set_defaults(fn=_cmd_cache_get)

    p = sub.add_parser("cache-put")
    p.add_argument("key")
    p.add_argument("value")
    p.add_argument("--ttl", type=float, required=True)
    p.set_defaults(fn=_cmd_cache_put)

    args = ap.parse_args(argv)
    if getattr(args, "cmd", None) and args.cmd and args.cmd[0] == "--":
        args.cmd = args.cmd[1:]
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
