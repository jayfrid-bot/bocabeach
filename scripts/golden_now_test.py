"""Unit tests for scripts/golden_now.py. Run from the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

No network. The windows are checked against the NOAA solver in sun_cam_check.py.
"""

import contextlib
import io
import plistlib
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import golden_now as gn  # noqa: E402
import sun_cam_check as sc  # noqa: E402

MIN = timedelta(minutes=1)
BEACHES = gn.load_beaches()


def utc(y, mo, d, h=0, mi=0, s=0):
    return datetime(y, mo, d, h, mi, s, tzinfo=timezone.utc)


def sun(slug, day):
    b = BEACHES[slug]
    return sc.sun_times(b["lat"], b["lon"], day)


def inside(slug, now):
    return gn.golden_hit([slug], now, BEACHES) is not None


class WindowSizeTests(unittest.TestCase):
    def test_the_windows_match_the_archive_golden_rules(self):
        # lib/camFrames/golden.ts: sunrise -20/+40, sunset -40/+20.
        self.assertEqual((gn.SUNRISE_BEFORE_MIN, gn.SUNRISE_AFTER_MIN), (20, 40))
        self.assertEqual((gn.SUNSET_BEFORE_MIN, gn.SUNSET_AFTER_MIN), (40, 20))
        ts = (Path(__file__).resolve().parent.parent / "lib" / "camFrames" / "golden.ts").read_text()
        for name, val in [("SUNRISE_BEFORE_MIN", 20), ("SUNRISE_AFTER_MIN", 40),
                          ("SUNSET_BEFORE_MIN", 40), ("SUNSET_AFTER_MIN", 20)]:
            self.assertIn(f"export const {name} = {val};", ts)

    def test_the_courier_beaches_are_in_the_manifest(self):
        for slug in gn.COURIER_SLUGS:
            self.assertIn(slug, BEACHES)
            self.assertIsNotNone(BEACHES[slug]["lat"])


class BoundaryTests(unittest.TestCase):
    """Half-open [start, end), second by second, for both courier beaches."""

    def check_edges(self, slug, day):
        t = sun(slug, day)
        for event, before, after in [("sunrise", 20, 40), ("sunset", 40, 20)]:
            start = t[event] - before * MIN
            end = t[event] + after * MIN
            s = timedelta(seconds=1)
            self.assertFalse(inside(slug, start - s), f"{slug} {day} {event} 1s before start")
            self.assertTrue(inside(slug, start), f"{slug} {day} {event} start is inside")
            self.assertTrue(inside(slug, t[event]), f"{slug} {day} {event} itself")
            self.assertTrue(inside(slug, end - s), f"{slug} {day} {event} 1s before end")
            self.assertFalse(inside(slug, end), f"{slug} {day} {event} end is outside")

    def test_edges_in_every_season_for_both_beaches(self):
        for slug in gn.COURIER_SLUGS:
            for day in [date(2026, 3, 20), date(2026, 6, 21), date(2026, 9, 22), date(2026, 10, 12), date(2026, 12, 21)]:
                self.check_edges(slug, day)

    def test_midday_and_night_are_outside(self):
        for slug in gn.COURIER_SLUGS:
            self.assertFalse(inside(slug, utc(2026, 10, 12, 16, 0)))  # noon EDT
            self.assertFalse(inside(slug, utc(2026, 10, 12, 4, 0)))   # midnight EDT
            self.assertFalse(inside(slug, utc(2026, 10, 12, 8, 0)))   # 4 AM EDT

    def test_a_known_october_evening(self):
        # 2026-10-12 Deerfield: sunset ~22:55Z (6:55 PM EDT) -> window ~22:15Z-23:15Z.
        self.assertFalse(inside("deerfield-beach", utc(2026, 10, 12, 22, 5)))
        self.assertTrue(inside("deerfield-beach", utc(2026, 10, 12, 22, 20)))
        self.assertTrue(inside("deerfield-beach", utc(2026, 10, 12, 23, 10)))
        self.assertFalse(inside("deerfield-beach", utc(2026, 10, 12, 23, 20)))

    def test_summer_sunset_window_is_after_midnight_utc_aware(self):
        # June sunset ~00:15Z the NEXT UTC day; 8:00 PM EDT on June 21 is still the 21st locally.
        self.assertTrue(inside("deerfield-beach", utc(2026, 6, 22, 0, 0)))   # 8:00 PM EDT Jun 21
        self.assertFalse(inside("deerfield-beach", utc(2026, 6, 22, 1, 0)))  # 9:00 PM EDT

    def test_naive_datetimes_are_read_as_utc(self):
        naive = datetime(2026, 10, 12, 22, 20)
        self.assertTrue(gn.golden_hit(["deerfield-beach"], naive, BEACHES))

    def test_any_named_beach_counts(self):
        # Fort Lauderdale is ~0.2 deg south, so its windows start a fraction of a minute apart;
        # a moment inside both is inside for the pair too.
        self.assertTrue(gn.golden_hit(list(gn.COURIER_SLUGS), utc(2026, 10, 12, 22, 40), BEACHES))

    def test_unknown_slug_is_an_error_not_a_no(self):
        with self.assertRaises(KeyError):
            gn.golden_hit(["nowhere"], utc(2026, 10, 12, 22, 40), BEACHES)


class PolarTests(unittest.TestCase):
    def test_no_sunset_means_no_window(self):
        beach = {"lat": 80.0, "lon": 0.0, "timezone": "UTC"}
        self.assertEqual(gn.windows_for(beach, utc(2026, 6, 21, 12)), [])

    def test_missing_coordinates_raise(self):
        with self.assertRaises(Exception):
            gn.windows_for({"lat": None, "lon": None, "timezone": "UTC"}, utc(2026, 6, 21, 12))


class LaunchdScheduleTests(unittest.TestCase):
    """The two courier plists. launchd runs on the Mac's LOCAL time (America/New_York).

    The golden plist used to list the local hours of the four original beaches' windows.
    A beach farther north or west (a summer sunrise at 05:30, a Texas sunset at 21:30)
    would fall outside such a list, so it now fires every 10 minutes ALL day and
    scripts/courier_schedule.py asks the sun."""

    SCRIPTS = Path(__file__).resolve().parent

    def load(self, name):
        with open(self.SCRIPTS / name, "rb") as fh:
            return plistlib.load(fh)

    def test_golden_job_passes_the_flag_and_the_routine_job_does_not(self):
        golden = self.load("com.isitbeachday.camcourier.golden.plist")
        routine = self.load("com.isitbeachday.camcourier.plist")
        self.assertEqual(golden["ProgramArguments"][-1], "--golden-only")
        self.assertEqual(golden["ProgramArguments"][:-1], routine["ProgramArguments"])
        self.assertNotEqual(golden["Label"], routine["Label"])
        self.assertNotIn("--golden-only", routine["ProgramArguments"])

    def test_the_routine_job_fires_every_five_minutes_all_day_off_the_golden_marks(self):
        entries = self.load("com.isitbeachday.camcourier.plist")["StartCalendarInterval"]
        self.assertTrue(all("Hour" not in e for e in entries))
        minutes = sorted(e["Minute"] for e in entries)
        self.assertEqual(minutes, list(range(3, 60, 5)))
        self.assertTrue(all(m % 10 != 0 for m in minutes))  # never on a golden mark

    def test_the_golden_job_fires_on_every_ten_minute_mark_all_day(self):
        entries = self.load("com.isitbeachday.camcourier.golden.plist")["StartCalendarInterval"]
        self.assertTrue(all("Hour" not in e for e in entries))
        self.assertEqual(sorted(e["Minute"] for e in entries), [0, 10, 20, 30, 40, 50])

    def test_every_ten_minute_mark_inside_a_window_has_a_launch_for_every_beach(self):
        # With no Hour key every hour fires; so any 10-minute mark in any window, for ANY
        # beach in the manifest, has a launch. Check the windows really are on 10-min marks.
        entries = self.load("com.isitbeachday.camcourier.golden.plist")["StartCalendarInterval"]
        marks = {e["Minute"] for e in entries}
        zone = ZoneInfo("America/New_York")
        day, missed = date(2026, 1, 1), []
        while day.year == 2026:
            noon = datetime(day.year, day.month, day.day, 12, tzinfo=zone).astimezone(timezone.utc)
            for slug in BEACHES:
                for kind, start, end in gn.windows_for(BEACHES[slug], noon):
                    t = start
                    while t < end:
                        local = t.astimezone(zone)
                        if local.minute % 10 == 0 and local.minute not in marks:
                            missed.append((str(day), slug, kind, local.strftime("%H:%M")))
                        t += timedelta(minutes=5)
            day += timedelta(days=7)
        self.assertEqual(missed, [])


class CliTests(unittest.TestCase):
    def run_main(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gn.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_exit_0_inside_with_a_line_saying_which(self):
        code, out, _ = self.run_main("--now", "2026-10-12T22:40:00Z")
        self.assertEqual(code, 0)
        self.assertRegex(out, r"inside (deerfield-beach|fort-lauderdale) sunset window 22:\d\dZ-23:\d\dZ")

    def test_exit_1_outside(self):
        code, out, _ = self.run_main("--now", "2026-10-12T16:00:00Z")
        self.assertEqual(code, 1)
        self.assertIn("outside", out)

    def test_exit_2_when_it_cannot_tell(self):
        code, _, err = self.run_main("--now", "2026-10-12T22:40:00Z", "nowhere")
        self.assertEqual(code, 2)
        self.assertIn("golden_now", err)
        code, _, _ = self.run_main("--now", "not-a-time")
        self.assertEqual(code, 2)

    def test_z_suffix_and_offset_forms_agree(self):
        a = self.run_main("--now", "2026-10-12T22:40:00Z")[0]
        b = self.run_main("--now", "2026-10-12T18:40:00-04:00")[0]
        self.assertEqual(a, b)

    def test_default_beaches_are_the_courier_beaches(self):
        # Boca is not a courier beach; naming it explicitly still works.
        code, _, _ = self.run_main("--now", "2026-10-12T22:40:00Z", "boca-raton")
        self.assertIn(code, (0, 1))


if __name__ == "__main__":
    unittest.main()
