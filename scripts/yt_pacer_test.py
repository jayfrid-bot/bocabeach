"""Tests for scripts/yt_pacer.py. Run from the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

No network. A fake clock and a fake sleep drive the pacer; a fake `yt-dlp` script on PATH
stands in for the real tool. State lives in a temp directory.
"""

import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import yt_pacer as yp  # noqa: E402


class FakeClock:
    def __init__(self, t=1_000_000.0):
        self.t = t

    def __call__(self):
        return self.t

    def sleep(self, s):
        self.t += s


def make_pacer(tmp, clock=None, **env):
    clock = clock or FakeClock()
    p = yp.Pacer(Path(tmp), clock=clock, sleep=clock.sleep, quiet=True)
    for k, v in env.items():
        setattr(p, k, v)
    return p, clock


class EarliestAllowedTests(unittest.TestCase):
    def test_an_empty_ledger_allows_now(self):
        self.assertEqual(yp.earliest_allowed([], 100.0, "routine"), (100.0, None))

    def test_calls_must_be_min_gap_apart(self):
        t, why = yp.earliest_allowed([100.0], 101.0, "golden", min_gap=4.0)
        self.assertEqual((t, why), (104.0, None))

    def test_the_window_cap_holds_exactly(self):
        # 60 calls inside the window: the 61st must wait until the oldest one leaves it
        calls = [float(i * 5) for i in range(60)]  # 0..295 s
        t, why = yp.earliest_allowed(calls, 300.0, "golden", min_gap=0.0)
        self.assertEqual(t, 0.0 + yp.WINDOW_S)  # the call at t=0 leaves at 900
        self.assertIsNone(why)
        t, _ = yp.earliest_allowed(calls, 900.0, "golden", min_gap=0.0)
        self.assertEqual(t, 900.0)

    def test_routine_stops_at_36_but_golden_goes_on(self):
        calls = [float(i * 10) for i in range(36)]
        r, _ = yp.earliest_allowed(calls, 400.0, "routine", min_gap=0.0)
        g, _ = yp.earliest_allowed(calls, 400.0, "golden", min_gap=0.0)
        s, _ = yp.earliest_allowed(calls, 400.0, "sun", min_gap=0.0)
        self.assertGreater(r, 400.0)
        self.assertEqual(g, 400.0)
        self.assertEqual(s, 400.0)

    def test_sun_stops_at_48(self):
        calls = [float(i * 5) for i in range(48)]
        s, _ = yp.earliest_allowed(calls, 300.0, "sun", min_gap=0.0)
        g, _ = yp.earliest_allowed(calls, 300.0, "golden", min_gap=0.0)
        self.assertGreater(s, 300.0)
        self.assertEqual(g, 300.0)

    def test_a_backoff_refuses_every_tier(self):
        for tier in ("golden", "sun", "routine"):
            t, why = yp.earliest_allowed([], 100.0, tier, backoff_until=500.0)
            self.assertEqual((t, why), (500.0, "backoff"))

    def test_an_ended_backoff_is_ignored(self):
        self.assertEqual(yp.earliest_allowed([], 600.0, "golden", backoff_until=500.0), (600.0, None))

    def test_a_tier_set_to_zero_never_runs(self):
        t, _ = yp.earliest_allowed([], 0.0, "routine", caps={"golden": 60, "sun": 48, "routine": 0})
        self.assertEqual(t, float("inf"))

    def test_no_tier_may_exceed_the_hard_cap(self):
        calls = [float(i * 5) for i in range(60)]
        t, _ = yp.earliest_allowed(calls, 300.0, "golden", caps={"golden": 500, "sun": 500, "routine": 500}, min_gap=0.0)
        self.assertGreater(t, 300.0)


class BotCheckTextTests(unittest.TestCase):
    def test_the_real_message_with_a_curly_apostrophe(self):
        self.assertTrue(yp.detect_bot_check("ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies"))

    def test_the_straight_apostrophe_and_429(self):
        self.assertTrue(yp.detect_bot_check("Sign in to confirm you're not a bot"))
        self.assertTrue(yp.detect_bot_check("ERROR: unable to download: HTTP Error 429: Too Many Requests"))

    def test_ordinary_failures_are_not_a_bot_check(self):
        self.assertFalse(yp.detect_bot_check("ERROR: [youtube] abc: Video unavailable"))
        self.assertFalse(yp.detect_bot_check("ERROR: This live event has ended"))
        self.assertFalse(yp.detect_bot_check(""))

    def test_url_expiry(self):
        self.assertEqual(yp.url_expiry("https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/1792201544/ei/x"), 1792201544.0)
        self.assertIsNone(yp.url_expiry("https://example.com/a.m3u8"))


class AcquireTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_calls_are_spaced_by_the_min_gap(self):
        p, clock = make_pacer(self.tmp.name)
        starts = []
        for _ in range(5):
            g = p.acquire("golden", "c", max_wait_s=60)
            self.assertTrue(g.ok)
            starts.append(clock())
        gaps = [b - a for a, b in zip(starts, starts[1:])]
        self.assertTrue(all(g >= yp.MIN_GAP_S - 1e-9 for g in gaps), gaps)

    def test_never_more_than_60_in_any_15_minutes_even_for_a_hungry_caller(self):
        p, clock = make_pacer(self.tmp.name)
        starts = []
        end = clock() + 3 * 3600
        while clock() < end:
            g = p.acquire("golden", "c", max_wait_s=3600)
            self.assertTrue(g.ok)
            starts.append(clock())
        worst = max(sum(1 for s in starts if t - 900 < s <= t) for t in starts)
        self.assertLessEqual(worst, 60)
        self.assertGreaterEqual(worst, 55)  # and it does use the budget

    def test_routine_cannot_take_the_slots_reserved_for_golden_and_sun(self):
        p, clock = make_pacer(self.tmp.name)
        granted = 0
        for _ in range(100):
            g = p.acquire("routine", "r", max_wait_s=0)
            if not g.ok:
                self.assertEqual(g.reason, "budget")
                break
            granted += 1
            clock.t += 5  # one call every 5 s: the window fills up
        self.assertEqual(granted, 36)
        # golden still gets in right now
        self.assertTrue(p.acquire("golden", "g", max_wait_s=0).ok)

    def test_golden_beats_routine_when_the_window_is_full_of_routine_calls(self):
        p, clock = make_pacer(self.tmp.name)
        for _ in range(36):
            p.acquire("routine", "r", max_wait_s=0)
            clock.t += 5
        self.assertFalse(p.acquire("routine", "r", max_wait_s=0).ok)
        self.assertTrue(p.acquire("golden", "g", max_wait_s=0).ok)

    def test_a_refusal_for_budget_does_not_book_a_call(self):
        p, clock = make_pacer(self.tmp.name)
        for _ in range(36):
            p.acquire("routine", "r", max_wait_s=0)
            clock.t += 5
        before = p.usage()["calls_in_window"]
        p.acquire("routine", "r", max_wait_s=0)
        self.assertEqual(p.usage()["calls_in_window"], before)

    def test_old_calls_leave_the_window(self):
        p, clock = make_pacer(self.tmp.name)
        for _ in range(36):
            p.acquire("routine", "r", max_wait_s=0)
            clock.t += 5
        clock.t += 900
        self.assertEqual(p.usage()["calls_in_window"], 0)
        self.assertTrue(p.acquire("routine", "r", max_wait_s=0).ok)

    def test_threads_share_one_budget(self):
        # real clock, real flock: 8 threads ask for 10 calls each; the window cap is 20
        p = yp.Pacer(Path(self.tmp.name), quiet=True)
        p.caps = {"golden": 20, "sun": 20, "routine": 20}
        p.min_gap = 0.0
        granted = []
        lock = threading.Lock()

        def worker():
            for _ in range(10):
                g = p.acquire("golden", "t", max_wait_s=0)
                with lock:
                    granted.append(g.ok)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sum(granted), 20)

    def test_state_survives_a_corrupt_file(self):
        p, _ = make_pacer(self.tmp.name)
        p.acquire("golden", "c", max_wait_s=0)
        (Path(self.tmp.name) / "state.json").write_text("{not json")
        self.assertTrue(p.acquire("golden", "c", max_wait_s=0).ok)


class BackoffTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name) / "bin"
        self.bin.mkdir()
        self.state = Path(self.tmp.name) / "state"

    def fake_ytdlp(self, body):
        f = self.bin / "yt-dlp"
        f.write_text("#!/bin/bash\n" + body)
        f.chmod(f.stat().st_mode | stat.S_IXUSR)
        self._old_path = os.environ["PATH"]
        os.environ["PATH"] = f"{self.bin}:{self._old_path}"
        self.addCleanup(lambda: os.environ.__setitem__("PATH", self._old_path))

    def test_a_bot_check_backs_off_every_job_for_20_minutes(self):
        self.fake_ytdlp('echo "ERROR: [youtube] x: Sign in to confirm you’re not a bot." >&2\nexit 1\n')
        clock = FakeClock()
        a = yp.Pacer(self.state, clock=clock, sleep=clock.sleep, quiet=True)
        res = a.run(["yt-dlp", "-g", "u"], "golden", "cam-a")
        self.assertEqual(res.status, "bot-check")
        self.assertEqual(res.exit_code, yp.EXIT_BOT_CHECK)
        # a DIFFERENT job (its own Pacer object, same state file) is refused at once
        b = yp.Pacer(self.state, clock=clock, sleep=clock.sleep, quiet=True)
        for tier in ("golden", "sun", "routine"):
            res2 = b.run(["yt-dlp", "-g", "u"], tier, "cam-b")
            self.assertEqual(res2.status, "backoff")
            self.assertEqual(res2.exit_code, yp.EXIT_BACKOFF)
        self.assertTrue(b.in_backoff())
        clock.t += 19 * 60
        self.assertTrue(b.in_backoff())
        clock.t += 61
        self.assertFalse(b.in_backoff())
        self.fake_ytdlp("echo https://example.com/a.m3u8\n")
        self.assertEqual(b.run(["yt-dlp", "-g", "u"], "routine", "cam-b").status, "ok")

    def test_the_backoff_is_logged(self):
        self.fake_ytdlp('echo "Sign in to confirm you\'re not a bot" >&2\nexit 1\n')
        import contextlib
        import io

        clock = FakeClock()
        p = yp.Pacer(self.state, clock=clock, sleep=clock.sleep, quiet=False)
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            p.run(["yt-dlp", "-g", "u"], "routine", "deerfield-beach-cam")
        out = buf.getvalue()
        self.assertIn("BOT CHECK", out)
        self.assertIn("deerfield-beach-cam", out)
        self.assertIn("20 min", out)

    def test_an_ordinary_failure_does_not_back_off(self):
        self.fake_ytdlp('echo "ERROR: Video unavailable" >&2\nexit 1\n')
        p = yp.Pacer(self.state, quiet=True)
        res = p.run(["yt-dlp", "-g", "u"], "routine", "c")
        self.assertEqual(res.status, "failed")
        self.assertFalse(p.in_backoff())

    def test_a_hung_command_is_killed(self):
        self.fake_ytdlp("sleep 30\n")
        p = yp.Pacer(self.state, quiet=True)
        res = p.run(["yt-dlp", "-g", "u"], "routine", "c", timeout_s=1)
        self.assertEqual(res.status, "failed")
        self.assertEqual(res.returncode, 124)

    def test_cli_exit_codes(self):
        self.fake_ytdlp('echo "Sign in to confirm you\'re not a bot" >&2\nexit 1\n')
        os.environ["YTPACE_DIR"] = str(self.state)
        self.addCleanup(lambda: os.environ.pop("YTPACE_DIR", None))
        self.assertEqual(yp.main(["resolve", "--video", "abc", "--cam", "c", "--priority", "golden"]), yp.EXIT_BOT_CHECK)
        self.assertEqual(yp.main(["resolve", "--video", "abc", "--cam", "c", "--priority", "golden"]), yp.EXIT_BACKOFF)
        self.assertEqual(yp.main(["backoff-check"]), 0)


class CacheAndResolveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = Path(self.tmp.name) / "bin"
        self.bin.mkdir()
        self.counter = Path(self.tmp.name) / "calls"
        f = self.bin / "yt-dlp"
        f.write_text(f'#!/bin/bash\necho "$@" >> "{self.counter}"\n'
                     'if [[ "$*" == *--print* ]]; then\n'
                     '  case "$*" in *GOODSURF*) echo "Fort Lauderdale Beach LIVE: Surf, Wind";; *WEATHER*) echo "Weather station";; esac; exit 0\n'
                     'fi\n'
                     'echo "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/9999999999/ei/x"\n')
        f.chmod(f.stat().st_mode | stat.S_IXUSR)
        old = os.environ["PATH"]
        os.environ["PATH"] = f"{self.bin}:{old}"
        self.addCleanup(lambda: os.environ.__setitem__("PATH", old))
        self.clock = FakeClock()
        self.pacer = yp.Pacer(Path(self.tmp.name) / "state", clock=self.clock, sleep=self.clock.sleep, quiet=True)

    def calls(self):
        return len(self.counter.read_text().splitlines()) if self.counter.exists() else 0

    def test_a_resolved_url_is_reused_inside_its_short_life_only(self):
        r1 = yp.resolve_url(self.pacer, "VID1", "cam", "routine")
        self.assertEqual(r1.status, "ok")
        yp.resolve_url(self.pacer, "VID1", "cam", "routine")
        self.assertEqual(self.calls(), 1)  # the second came from the cache
        self.clock.t += yp.URL_TTL_S + 1  # segments stop playing at ~30 s; the cache is shorter
        yp.resolve_url(self.pacer, "VID1", "cam", "routine")
        self.assertEqual(self.calls(), 2)

    def test_the_url_ttl_is_the_measured_one_not_the_six_hour_expire(self):
        self.assertLessEqual(yp.URL_TTL_S, 25)

    def test_a_different_stream_is_a_different_cache_key(self):
        yp.resolve_url(self.pacer, "VID1", "a", "routine")
        yp.resolve_url(self.pacer, "VID2", "b", "routine")
        self.assertEqual(self.calls(), 2)

    def test_cache_entries_expire(self):
        self.pacer.cache_put("k", "v", 10)
        self.assertEqual(self.pacer.cache_get("k"), "v")
        self.clock.t += 11
        self.assertIsNone(self.pacer.cache_get("k"))

    PAGE = '<iframe src="https://www.youtube.com/live_chat?v=WEATHER1"></iframe><iframe src="https://www.youtube.com/live_chat?v=GOODSURF1"></iframe><a href="live_chat?v=WEATHER1">'

    def test_candidate_ids_are_deduped_in_page_order(self):
        self.assertEqual(yp.candidate_ids(self.PAGE), ["WEATHER1", "GOODSURF1"])

    def test_fallback_picks_the_beach_stream_by_title_and_remembers_it(self):
        vid, status = yp.find_fallback_video_id(self.pacer, "ftl", "http://x", "Surf", "routine", fetch=lambda u: self.PAGE)
        self.assertEqual((vid, status), ("GOODSURF1", "ok"))
        self.assertEqual(self.pacer.cache_get("vid:ftl"), "GOODSURF1")
        self.assertEqual(self.calls(), 2)  # one title call per candidate, no extra -g probes
        self.clock.t += 11 * 3600
        self.assertEqual(self.pacer.cache_get("vid:ftl"), "GOODSURF1")  # trusted for 12 hours
        self.clock.t += 2 * 3600
        self.assertIsNone(self.pacer.cache_get("vid:ftl"))

    def test_fallback_with_no_match_forgets_the_old_id(self):
        self.pacer.cache_put("vid:ftl", "STALE", 3600)
        vid, status = yp.find_fallback_video_id(self.pacer, "ftl", "http://x", "Surf", "routine",
                                                fetch=lambda u: "live_chat?v=WEATHER1")
        self.assertEqual((vid, status), (None, "none"))
        self.assertIsNone(self.pacer.cache_get("vid:ftl"))

    def test_fallback_stops_when_the_pacer_is_backing_off(self):
        self.pacer.set_backoff("x", "bot")
        vid, status = yp.find_fallback_video_id(self.pacer, "ftl", "http://x", "Surf", "routine", fetch=lambda u: self.PAGE)
        self.assertEqual((vid, status), (None, "backoff"))
        self.assertEqual(self.calls(), 0)


class CourierNotesTests(unittest.TestCase):
    def test_failures_double_the_cooldown_and_success_clears_it(self):
        with tempfile.TemporaryDirectory() as d:
            p, clock = make_pacer(d)
            p.mark_grab("c", ok=False)
            _, fails = p.courier_notes()
            self.assertEqual(fails["c"]["until"] - clock(), 10 * 60)
            p.mark_grab("c", ok=False)
            _, fails = p.courier_notes()
            self.assertEqual(fails["c"]["until"] - clock(), 20 * 60)
            for _ in range(10):
                p.mark_grab("c", ok=False)
            _, fails = p.courier_notes()
            self.assertEqual(fails["c"]["until"] - clock(), 120 * 60)  # capped at 2 hours
            p.mark_grab("c", ok=True)
            last, fails = p.courier_notes()
            self.assertEqual(last["c"], clock())
            self.assertNotIn("c", fails)


class StatusTests(unittest.TestCase):
    def test_usage_counts_by_tier(self):
        with tempfile.TemporaryDirectory() as d:
            p, clock = make_pacer(d)
            p.acquire("golden", "a", 0)
            clock.t += 5
            p.acquire("routine", "b", 0)
            u = p.usage()
            self.assertEqual(u["calls_in_window"], 2)
            self.assertEqual(u["by_tier"], {"golden": 1, "routine": 1})
            self.assertIsNone(u["backoff_until"])
            json.dumps(u)


if __name__ == "__main__":
    unittest.main()
