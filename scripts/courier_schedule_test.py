"""Tests for scripts/courier_schedule.py. Run from the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

No network, no state file of the real machine (a temp YTPACE_DIR is used where needed).
"""

import json
import math
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import courier_schedule as cs  # noqa: E402
import golden_now  # noqa: E402
import sun_cam_check as sc  # noqa: E402

REAL = cs.load_registry()


def utc(y, mo, d, h=0, mi=0, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc)


def mkcam(i, lat=26.3, lon=-80.07, tz="America/New_York"):
    return cs.Cam(f"cam-{i:02d}", f"VID{i:08d}", f"beach-{i}", tz, lat, lon, None, True)


class RegistryTests(unittest.TestCase):
    def test_every_cam_on_main_is_found_with_an_id(self):
        ids = {c.id for c in REAL.cams}
        self.assertEqual(
            ids,
            {"deerfield-beach-cam", "deerfield-surf-cam", "deerfield-pier-cam", "deerfield-spinner-uw",
             "ftl-elbo-beach-cam", "fort-myers-beach-cam", "pensacola-sria-west-cam"},
        )
        self.assertEqual(REAL.problems, [])
        self.assertTrue(all(c.youtube_id for c in REAL.cams))

    def test_the_ids_match_what_the_shell_script_used_to_hold(self):
        old = {"deerfield-spinner-uw": "SHfAtWHr9Ks", "deerfield-beach-cam": "rdeoEeJ00xA", "deerfield-surf-cam": "hIeFPNHfuoY",
               "deerfield-pier-cam": "H33wtprQqSM", "ftl-elbo-beach-cam": "1j1lgppb0PY", "fort-myers-beach-cam": "nj9jdOXXhEo",
               "pensacola-sria-west-cam": "HKIc6CYlMzI"}
        self.assertEqual({c.id: c.youtube_id for c in REAL.cams}, old)

    def test_elbo_keeps_its_fallback_page(self):
        elbo = next(c for c in REAL.cams if c.id == "ftl-elbo-beach-cam")
        self.assertEqual(elbo.fallback["page"], "https://www.elboroom.com/beach-cam/")
        self.assertEqual(elbo.fallback["title_contains"], "Surf")

    def test_pensacola_is_on_central_time(self):
        self.assertEqual(next(c for c in REAL.cams if c.id == "pensacola-sria-west-cam").timezone, "America/Chicago")

    def test_the_repo_config_passes_the_check(self):
        # same check a CI run does: ids found, and every cam is in the uw-frame worker registry
        self.assertEqual(cs.check(REAL, cs.worker_registry_ids()), [])

    def test_a_cam_added_to_config_is_picked_up_with_no_code_change(self):
        with tempfile.TemporaryDirectory() as d:
            cdir = Path(d)
            for name in ("archive-cams.json", "vision-cams.json", "sun-cams.json", "courier-cams.json"):
                (cdir / name).write_text((cs.ROOT / "config" / name).read_text())
            arch = json.loads((cdir / "archive-cams.json").read_text())
            arch["cams"].append({
                "slug": "new-beach", "id": "new-beach-cam", "name": "New", "attribution": None, "timezone": "America/Chicago",
                "lat": 29.3, "lon": -94.8,
                "source": {"kind": "direct", "url": "https://uw-frame.example/frame?cam=new-beach-cam", "meta": None},
            })
            arch["cams"].append({"slug": "new-beach", "id": "a-feed-cam", "name": "Feed", "attribution": None,
                                 "timezone": "America/Chicago", "lat": 29.3, "lon": -94.8,
                                 "source": {"kind": "feed", "base": "http://x", "view": "s1"}})
            (cdir / "archive-cams.json").write_text(json.dumps(arch))
            sun = json.loads((cdir / "sun-cams.json").read_text())
            sun["cams"].append({"id": "new-beach-cam", "youtube_id": "NEWID123456", "lat": 29.3, "lon": -94.8,
                                "beaches": [{"slug": "new-beach", "lat": 29.3, "lon": -94.8}], "sky_regions": [[0, 0, 1, 1]]})
            (cdir / "sun-cams.json").write_text(json.dumps(sun))
            reg = cs.load_registry(cdir)
            new = [c for c in reg.cams if c.id == "new-beach-cam"]
            self.assertEqual(len(new), 1)
            self.assertEqual((new[0].youtube_id, new[0].timezone, new[0].slug), ("NEWID123456", "America/Chicago", "new-beach"))
            self.assertNotIn("a-feed-cam", [c.id for c in reg.cams])  # a "feed" cam is not a courier cam
            self.assertEqual(reg.problems, [])

    def test_a_direct_cam_with_no_video_id_is_reported_and_not_grabbed(self):
        with tempfile.TemporaryDirectory() as d:
            cdir = Path(d)
            for name in ("archive-cams.json", "vision-cams.json", "sun-cams.json", "courier-cams.json"):
                (cdir / name).write_text((cs.ROOT / "config" / name).read_text())
            arch = json.loads((cdir / "archive-cams.json").read_text())
            arch["cams"].append({"slug": "x", "id": "no-id-cam", "name": "N", "attribution": None, "timezone": "America/New_York",
                                 "lat": 30.0, "lon": -81.0, "source": {"kind": "direct", "url": "u", "meta": None}})
            (cdir / "archive-cams.json").write_text(json.dumps(arch))
            reg = cs.load_registry(cdir)
            self.assertTrue(any("no-id-cam" in p and "video id" in p for p in reg.problems))
            self.assertNotIn("no-id-cam", [c.id for c in cs.grabbable(reg)])
            self.assertTrue(cs.check(reg, None))

    def test_a_cam_missing_from_the_worker_registry_fails_the_check(self):
        errs = cs.check(REAL, {"deerfield-beach-cam": "rdeoEeJ00xA"})
        self.assertTrue(any("pensacola-sria-west-cam" in e and "404" in e for e in errs))


class RoutineTests(unittest.TestCase):
    NOON = utc(2026, 10, 17, 16, 3).timestamp()  # 12:03 EDT

    def test_the_gate_is_6_to_21_eastern(self):
        cams = [mkcam(1)]
        self.assertEqual(len(cs.routine_due(cams, utc(2026, 10, 17, 10, 3).timestamp(), {}, {})), 1)  # 06:03 EDT
        self.assertEqual(cs.routine_due(cams, utc(2026, 10, 17, 9, 58).timestamp(), {}, {}), [])  # 05:58 EDT
        self.assertEqual(len(cs.routine_due(cams, utc(2026, 10, 18, 0, 58).timestamp(), {}, {})), 1)  # 20:58 EDT
        self.assertEqual(cs.routine_due(cams, utc(2026, 10, 18, 1, 3).timestamp(), {}, {}), [])  # 21:03 EDT

    def test_a_cold_start_does_not_take_every_cam_at_once(self):
        cams = [mkcam(i) for i in range(42)]
        due = cs.routine_due(cams, self.NOON, {}, {})
        self.assertEqual(len(due), cs.routine_run_cap(42))
        self.assertLessEqual(len(due), 5)

    def test_run_cap_covers_the_hour(self):
        for n in (1, 7, 20, 42, 80):
            self.assertGreaterEqual(cs.routine_run_cap(n) * 12, n)

    def test_fresh_cams_are_not_due_and_overdue_ones_go_first(self):
        cams = [mkcam(i) for i in range(4)]
        last = {"cam-00": self.NOON - 10 * 60, "cam-01": self.NOON - 58 * 60, "cam-02": self.NOON - 90 * 60}
        due = [c.id for c in cs.routine_due(cams, self.NOON, last, {})]
        self.assertEqual(due, ["cam-03", "cam-02"])  # never grabbed first, then most overdue; cap is 2 for 4 cams; cam-01 waits

    def test_a_cam_in_cooldown_is_skipped(self):
        cams = [mkcam(1)]
        self.assertEqual(cs.routine_due(cams, self.NOON, {}, {"cam-01": {"n": 1, "until": self.NOON + 60}}), [])
        self.assertEqual(len(cs.routine_due(cams, self.NOON, {}, {"cam-01": {"n": 1, "until": self.NOON - 1}})), 1)

    def test_over_a_day_every_cam_is_grabbed_about_hourly_and_no_run_takes_more_than_the_cap(self):
        cams = [mkcam(i) for i in range(42)]
        last, grabs = {}, {c.id: [] for c in cams}
        t = utc(2026, 10, 17, 10, 3).timestamp()  # 06:03 EDT
        biggest = 0
        while t < utc(2026, 10, 18, 1, 0).timestamp():
            due = cs.routine_due(cams, t, last, {})
            biggest = max(biggest, len(due))
            for c in due:
                last[c.id] = t + 30
                grabs[c.id].append(t)
            t += 300
        self.assertLessEqual(biggest, cs.routine_run_cap(42))
        for cid, ts in grabs.items():
            gaps = [(b - a) / 60 for a, b in zip(ts, ts[1:])]
            self.assertGreaterEqual(len(ts), 13, cid)  # 06:00-21:00 is 15 h; hourly-ish
            self.assertTrue(all(55 <= g <= 75 for g in gaps), (cid, gaps))

    def test_the_routine_load_is_spread_over_the_hour(self):
        cams = [mkcam(i) for i in range(42)]
        last, per_tick = {}, {}
        t = utc(2026, 10, 17, 10, 3).timestamp()
        while t < utc(2026, 10, 17, 22, 0).timestamp():
            due = cs.routine_due(cams, t, last, {})
            for c in due:
                last[c.id] = t + 30
            per_tick[t] = len(due)
            t += 300
        steady = [n for tt, n in per_tick.items() if tt > utc(2026, 10, 17, 12, 0).timestamp()]
        self.assertLessEqual(max(steady), 5)
        self.assertGreaterEqual(sum(1 for n in steady if n > 0), len(steady) * 0.6)


class GoldenTests(unittest.TestCase):
    def test_stride_widens_with_the_number_of_cams_in_a_window(self):
        self.assertEqual(cs.golden_stride_min(0), 10)
        self.assertEqual(cs.golden_stride_min(7), 10)
        self.assertEqual(cs.golden_stride_min(24), 10)
        self.assertEqual(cs.golden_stride_min(25), 20)
        self.assertEqual(cs.golden_stride_min(42), 20)
        self.assertEqual(cs.golden_stride_min(49), 30)
        self.assertEqual(cs.golden_stride_min(400), 30)

    def test_the_golden_calls_stay_inside_the_golden_budget(self):
        for n in range(1, 49):
            stride = cs.golden_stride_min(n)
            self.assertLessEqual(n * 15.0 / stride, cs.GOLDEN_CALL_BUDGET + 1e-9, n)

    def test_only_cams_whose_own_beach_is_in_a_window_are_due(self):
        cams = REAL.cams
        # 22:30Z on 2026-10-17 = 18:30 EDT: Deerfield (sunset ~18:09 EDT) is in its window; Pensacola (sunset ~17:30 CDT=18:30 EDT) too?
        now = utc(2026, 10, 17, 22, 30)
        active = {c.id for c, _ in cs.golden_active(cams, now)}
        self.assertIn("deerfield-beach-cam", active)
        # 15:00Z = 11:00 EDT: nobody
        self.assertEqual(cs.golden_active(cams, utc(2026, 10, 17, 15, 0)), [])
        self.assertEqual(cs.golden_due(cams, utc(2026, 10, 17, 15, 0), {}, {}), [])

    def test_the_old_golden_job_grabbed_every_cam_this_one_grabs_only_the_active_ones(self):
        # 12:30Z = 08:30 EDT: Deerfield's sunrise window (06:xx-07:xx EDT) is over, Pensacola's is open
        now = utc(2026, 10, 17, 13, 10)  # 08:10 EDT = 07:10 CDT
        beaches = golden_now.load_beaches()
        old_hit = golden_now.golden_hit(golden_now.COURIER_SLUGS, now, beaches)
        due = {c.id for c in cs.golden_due(REAL.cams, now, {}, {})}
        if old_hit:
            self.assertLess(len(due), len(REAL.cams))
            self.assertTrue(due)
            for cid in due:
                cam = next(c for c in REAL.cams if c.id == cid)
                self.assertTrue(cs.golden_active([cam], now))

    def test_a_cam_grabbed_a_minute_ago_is_not_due_again(self):
        now = utc(2026, 10, 17, 22, 30)
        cams = [c for c in REAL.cams if c.slug == "deerfield-beach"]
        last = {c.id: now.timestamp() - 60 for c in cams}
        self.assertEqual(cs.golden_due(cams, now, last, {}), [])
        last = {c.id: now.timestamp() - 9.6 * 60 for c in cams}  # a run that fired a little early still counts
        self.assertEqual(len(cs.golden_due(cams, now, last, {})), len(cams))

    def test_with_42_cams_in_one_window_a_run_takes_half_and_the_next_run_the_rest(self):
        cams = [mkcam(i) for i in range(42)]
        now = utc(2026, 10, 17, 22, 30)
        last = {}
        first = cs.golden_due(cams, now, last, {})
        self.assertEqual(len(first), 21)
        for c in first:
            last[c.id] = now.timestamp() + 60
        second = cs.golden_due(cams, now + timedelta(minutes=10), last, {})
        self.assertEqual(len(second), 21)
        self.assertEqual({c.id for c in first} & {c.id for c in second}, set())
        for c in second:
            last[c.id] = (now + timedelta(minutes=10)).timestamp() + 60
        third = cs.golden_due(cams, now + timedelta(minutes=20), last, {})
        self.assertEqual({c.id for c in third}, {c.id for c in first})  # a 20-minute stride

    def test_a_dead_cam_in_cooldown_is_left_alone(self):
        now = utc(2026, 10, 17, 22, 30)
        cams = [c for c in REAL.cams if c.slug == "deerfield-beach"]
        fails = {cams[0].id: {"n": 3, "until": now.timestamp() + 600}}
        self.assertNotIn(cams[0].id, {c.id for c in cs.golden_due(cams, now, {}, fails)})

    def test_a_cam_outside_the_old_plist_hours_gets_its_window(self):
        # A Carolina cam in June: sunrise ~06:00 EDT, window opens ~05:40, before the old plist's hour 6
        cam = mkcam(1, lat=35.2, lon=-75.5)
        now = utc(2026, 6, 21, 9, 50)  # 05:50 EDT
        self.assertEqual(len(cs.golden_due([cam], now, {}, {})), 1)


class CommandLineTests(unittest.TestCase):
    def test_due_prints_pipe_lines_and_dash_for_none(self):
        import contextlib
        import io
        import os

        with tempfile.TemporaryDirectory() as d:
            os.environ["YTPACE_DIR"] = d
            self.addCleanup(lambda: os.environ.pop("YTPACE_DIR", None))
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                cs.main(["due", "--mode", "all"])
            rows = [l.split("|") for l in buf.getvalue().splitlines()]
            self.assertEqual(len(rows), 7)
            self.assertTrue(all(len(r) == 4 for r in rows))
            elbo = next(r for r in rows if r[0] == "ftl-elbo-beach-cam")
            self.assertEqual(elbo[2:], ["https://www.elboroom.com/beach-cam/", "Surf"])
            self.assertEqual(next(r for r in rows if r[0] == "deerfield-beach-cam")[2:], ["-", "-"])

    def test_mark_then_due_respects_the_state(self):
        import contextlib
        import io
        import os

        with tempfile.TemporaryDirectory() as d:
            os.environ["YTPACE_DIR"] = d
            self.addCleanup(lambda: os.environ.pop("YTPACE_DIR", None))
            now = "2026-10-17T16:03:00Z"
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                cs.main(["due", "--mode", "routine", "--now", now])
            first = [l.split("|")[0] for l in buf.getvalue().splitlines()]
            self.assertEqual(len(first), cs.routine_run_cap(7))
            # mark ok with the real clock; "now" in the test is in the past, so the cams look fresh-in-the-future
            for cid in first:
                cs.main(["mark", "--cam", cid, "--ok"])
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                cs.main(["due", "--mode", "routine", "--now", now])
            second = [l.split("|")[0] for l in buf.getvalue().splitlines()]
            self.assertFalse(set(first) & set(second))


if __name__ == "__main__":
    unittest.main()
