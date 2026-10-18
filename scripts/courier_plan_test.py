"""Tests for scripts/courier_plan.py (the dry-run call timeline). Run from the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

No network. The simulation uses the real scheduling rules and the real pacer rule.
"""

import contextlib
import io
import json
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import courier_plan as cp  # noqa: E402
import courier_schedule as cs  # noqa: E402
import golden_now  # noqa: E402

REG = cs.load_registry()
BASE = cs.grabbable(REG)
SUN_BASE = [c for c in BASE if c.sun]
BEACHES = golden_now.load_beaches()
# The seven cams the courier held before the Gulf and Atlantic additions (2026-10-16/17).
ORIGINAL_IDS = {"deerfield-beach-cam", "deerfield-surf-cam", "deerfield-pier-cam", "deerfield-spinner-uw",
                "ftl-elbo-beach-cam", "fort-myers-beach-cam", "pensacola-sria-west-cam"}
# The planning envelope the pacer was sized for: those seven plus 35 planned cams.
PLANNED_TOTAL = 7 + 35
DAYS = [date(2026, 3, 20), date(2026, 6, 21), date(2026, 9, 22), date(2026, 10, 16), date(2026, 12, 21)]


def run(model, day, extra=0):
    ex = cp.synthetic_cams(extra)
    return cp.simulate(model, day, BASE + ex, SUN_BASE + ex, BEACHES)


class PlanTests(unittest.TestCase):
    def test_the_new_model_stays_at_or_under_60_calls_in_any_15_minutes_at_plus_35_cams_all_year(self):
        for day in DAYS:
            s = cp.summarize(run("new", day, 35))
            self.assertLessEqual(s["peak_15min"], cp.TARGET_15MIN, f"{day}: {s}")

    def test_the_new_model_with_todays_cams_stays_under_the_target_all_year(self):
        for day in DAYS:
            self.assertLessEqual(cp.summarize(run("new", day))["peak_15min"], cp.TARGET_15MIN, day)

    def test_the_new_model_with_the_original_seven_cams_is_well_under_the_target(self):
        orig = [c for c in BASE if c.id in ORIGINAL_IDS]
        self.assertEqual({c.id for c in orig}, ORIGINAL_IDS)
        for day in DAYS:
            res = cp.simulate("new", day, orig, [c for c in orig if c.sun], BEACHES)
            self.assertLessEqual(cp.summarize(res)["peak_15min"], 30)

    def test_the_legacy_model_at_plus_35_is_far_over_the_target(self):
        for day in DAYS:
            self.assertGreater(cp.summarize(run("legacy", day, 35))["peak_15min"], 100)

    def test_the_new_model_makes_fewer_calls_than_legacy_at_every_size(self):
        for extra in (0, 10, 35):
            new = cp.summarize(run("new", date(2026, 10, 16), extra))["calls_per_day"]
            old = cp.summarize(run("legacy", date(2026, 10, 16), extra))["calls_per_day"]
            self.assertLess(new, old)

    def test_the_pacer_rule_holds_in_the_simulated_ledger(self):
        res = run("new", date(2026, 6, 21), 35)
        times = sorted(c.t for c in res.calls)
        peak, _ = cp.rolling_peak(times, 900)
        self.assertLessEqual(peak, 60)
        gaps = [b - a for a, b in zip(times, times[1:])]
        self.assertGreaterEqual(min(gaps), 3.99)  # the 4 s spacing

    def test_the_sun_cam_check_costs_one_call_per_cam_event_in_the_new_model_and_three_in_legacy(self):
        new = run("new", date(2026, 10, 16))
        old = run("legacy", date(2026, 10, 16))
        self.assertEqual(new.sun_events, old.sun_events)
        n_new = sum(1 for c in new.calls if c.job == "suncam")
        n_old = sum(1 for c in old.calls if c.job == "suncam")
        self.assertEqual(n_new, new.sun_events)
        self.assertEqual(n_old, 3 * old.sun_events)

    def test_every_sun_event_is_still_served(self):
        # every sun cam x sunrise + sunset on a normal day, with or without the pacer
        self.assertEqual(run("new", date(2026, 10, 16)).sun_events, 2 * len(SUN_BASE))

    def test_the_today_model_has_no_golden_calls(self):
        s = cp.summarize(run("today", date(2026, 10, 16)))
        self.assertNotIn("courier-golden", s["by_job"])

    def test_todays_server_load_matches_what_the_log_shows(self):
        # the server's logs (7 cams then): every cam x 15 daylight hours of -g, plus ~3 -J per
        # working cam-event (2 events per sun cam)
        s = cp.summarize(run("today", date(2026, 10, 16)))
        self.assertEqual(s["by_job"]["courier-routine"], len(BASE) * 15)
        self.assertEqual(s["by_job"]["suncam"], 3 * 2 * len(SUN_BASE))

    def test_golden_only_grabs_cams_in_a_window(self):
        res = run("new", date(2026, 10, 16))
        golden = [c for c in res.calls if c.job == "courier-golden"]
        self.assertTrue(golden)
        self.assertLess(len(golden), len(BASE) * 6 * 4)  # far below "every cam, every 10 min, all four hours"

    def test_a_larger_set_never_starves_sunrise_work_for_routine_work(self):
        # at the planned envelope, every sun event is served and hardly a call is refused
        extra = max(0, PLANNED_TOTAL - len(BASE))
        res = run("new", date(2026, 10, 16), extra)
        self.assertEqual(res.sun_events, 2 * (len(SUN_BASE) + extra))
        self.assertLessEqual(res.dropped, 6)
        # 35 cams past today's set: routine calls may be refused, sun events still all served
        res = run("new", date(2026, 10, 16), 35)
        self.assertEqual(res.sun_events, 2 * (len(SUN_BASE) + 35))

    def test_synthetic_cams_are_split_between_the_coasts(self):
        cams = cp.synthetic_cams(35)
        self.assertEqual(len(cams), 35)
        self.assertEqual(sum(1 for c in cams if c.id.startswith("atl-")), 18)
        self.assertEqual(sum(1 for c in cams if c.id.startswith("gulf-")), 17)


class CliTests(unittest.TestCase):
    def test_the_dry_run_prints_both_plans_and_a_timeline(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            cp.main(["--date", "2026-10-16", "--extra", "35", "--model", "new", "--timeline"])
        out = buf.getvalue()
        self.assertIn(f"{len(BASE) + 35} courier cams ({len(BASE)} real + 35 planned)", out)
        self.assertIn("busiest 15 minutes", out)
        self.assertIn("within the 60 target", out)
        self.assertIn("yt-dlp -g", out)

    def test_json_output(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            cp.main(["--date", "2026-10-16", "--json"])
        data = json.loads(buf.getvalue().split("\n", 1)[1])
        self.assertEqual([d["model"] for d in data], ["today", "legacy", "new"])


if __name__ == "__main__":
    unittest.main()
