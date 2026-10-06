"""Unit tests for scripts/sun_cam_check.py. Run from the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

Needs Pillow (pip install pillow). No network, no yt-dlp, no ffmpeg.
"""

import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sun_cam_check as sc  # noqa: E402

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

FULL = [[0.0, 0.0, 1.0, 1.0]]
OCT6_DIR = Path.home() / "Projects/bocabeach-sunframes/2026-10-06/sunrise/ftl-elbo-beach-cam"


def solid(rgb, size=(160, 90)):
    return Image.new("RGB", size, rgb)


@unittest.skipIf(Image is None, "Pillow missing")
class ScoringTests(unittest.TestCase):
    def test_plain_and_empty_skies_score_near_zero(self):
        for rgb in [(128, 128, 128), (90, 120, 180), (0, 0, 0), (255, 255, 255), (200, 205, 215)]:
            self.assertLess(sc.score_image(solid(rgb), FULL)["score"], 8, rgb)

    def test_blue_sky_is_not_warm(self):
        m = sc.score_image(solid((70, 120, 200)), FULL)
        self.assertEqual(m["warm_frac"], 0.0)
        self.assertEqual(m["warm_sat"], 0.0)

    def test_hot_pink_orange_sky_scores_high(self):
        im = Image.new("RGB", (160, 90))
        im.paste((235, 110, 70), (0, 0, 80, 90))   # orange
        im.paste((220, 90, 130), (80, 0, 160, 90))  # pink
        m = sc.score_image(im, FULL)
        self.assertGreater(m["warm_frac"], 0.95)
        self.assertGreater(m["score"], 70)

    def test_sun_glare_and_black_pixels_are_ignored(self):
        im = Image.new("RGB", (160, 90), (0, 0, 0))
        im.paste((255, 255, 250), (0, 0, 80, 90))  # blown-out sun halo
        m = sc.score_image(im, FULL)
        self.assertEqual(m["valid_frac"], 0.0)
        self.assertEqual(m["score"], 0.0)

    def test_a_mostly_dark_frame_is_down_weighted(self):
        warm = (235, 110, 70)
        full = Image.new("RGB", (160, 90), warm)
        dim = Image.new("RGB", (160, 90), (0, 0, 0))
        dim.paste(warm, (0, 0, 16, 90))  # 10% valid
        self.assertGreater(sc.score_image(full, FULL)["score"], 2.5 * sc.score_image(dim, FULL)["score"])

    def test_regions_limit_what_is_scored(self):
        im = Image.new("RGB", (160, 90), (70, 120, 200))
        im.paste((235, 110, 70), (0, 45, 160, 90))  # warm only in the bottom half
        self.assertEqual(sc.score_image(im, [[0.0, 0.0, 1.0, 0.5]])["warm_frac"], 0.0)
        self.assertGreater(sc.score_image(im, [[0.0, 0.5, 1.0, 1.0]])["warm_frac"], 0.9)

    def test_combine_score_is_bounded_and_monotonic(self):
        self.assertEqual(sc.combine_score(0, 0, 0, 1), 0.0)
        top = sc.combine_score(1, 200, 1, 1)
        self.assertAlmostEqual(top, 100.0, places=6)
        self.assertLess(sc.combine_score(0.1, 50, 0.4, 1), sc.combine_score(0.2, 50, 0.4, 1))
        self.assertLess(sc.combine_score(0.2, 40, 0.4, 1), sc.combine_score(0.2, 60, 0.4, 1))

    @unittest.skipUnless(OCT6_DIR.exists(), "the 2026-10-06 Elbo frames are not on this machine")
    def test_oct6_elbo_sunrise_is_the_calibration_anchor(self):
        cam = next(c for c in sc.load_config()["cams"] if c["id"] == "ftl-elbo-beach-cam")
        scores = {p.name: sc.score_file(p, cam["sky_regions"])["score"] for p in OCT6_DIR.glob("*.jpg")}
        peak_name = max(scores, key=scores.get)
        self.assertEqual(peak_name, "1105Z.jpg")
        self.assertTrue(90 <= scores[peak_name] <= 97, scores[peak_name])
        for plain in ("1145Z.jpg", "1150Z.jpg", "1155Z.jpg"):  # 7:45-7:55 AM, high sun, white haze
            self.assertLess(scores[plain], 10, plain)


class SolarTests(unittest.TestCase):
    # Reference values from lib/sources/sun.ts computeSunTimes (same algorithm, same constants).
    REF = [
        (26.1195, -80.1035, date(2026, 10, 6), "2026-10-06T11:15:11.868Z", "2026-10-06T23:01:43.981Z"),
        (26.3587, -80.0686, date(2026, 10, 6), "2026-10-06T11:15:09.672Z", "2026-10-06T23:01:29.428Z"),
        (26.3165, -80.0742, date(2026, 12, 21), "2026-12-21T12:03:52.139Z", "2026-12-21T22:33:05.948Z"),
        (26.3587, -80.0686, date(2027, 6, 21), "2027-06-21T10:28:19.269Z", "2027-06-22T00:15:52.337Z"),
    ]

    def test_matches_the_apps_own_solar_times_to_the_millisecond(self):
        for lat, lon, d, rise, set_ in self.REF:
            t = sc.sun_times(lat, lon, d)
            self.assertEqual(sc.iso_z(t["sunrise"]), rise)
            self.assertEqual(sc.iso_z(t["sunset"]), set_)

    def test_view_east_facing(self):
        t = sc.sun_times(26.12, -80.10, date(2026, 10, 6))
        self.assertEqual(sc.view_for(90, t["sunrise_az"]), "solar")
        self.assertEqual(sc.view_for(90, t["sunset_az"]), "antisolar")
        self.assertEqual(sc.view_for(270, t["sunset_az"]), "solar")


class TimelineTests(unittest.TestCase):
    PLAYLIST = "\n".join(
        [
            "#EXTM3U",
            "#EXT-X-PROGRAM-DATE-TIME:2026-10-06T10:00:00.100+00:00",
            "#EXTINF:5.0,", "https://cdn/a0.ts",
            "#EXTINF:5.0,", "https://cdn/a1.ts",
            "#EXT-X-DISCONTINUITY",
            "#EXT-X-PROGRAM-DATE-TIME:2026-10-06T10:01:00.000Z",
            "#EXTINF:5.0,", "https://cdn/b0.ts",
            "#EXTINF:5.0,", "https://cdn/b1.ts",
        ]
    )

    def setUp(self):
        self.tl = sc.HlsTimeline.parse(self.PLAYLIST)

    def at(self, s):
        return sc.parse_iso(s)

    def test_times_each_segment_from_the_latest_tag(self):
        starts = [sc.iso_z(s[0]) for s in self.tl.segments]
        self.assertEqual(starts, ["2026-10-06T10:00:00.100Z", "2026-10-06T10:00:05.100Z", "2026-10-06T10:01:00.000Z", "2026-10-06T10:01:05.000Z"])

    def test_locates_the_containing_segment_and_refuses_gaps_and_outside(self):
        self.assertEqual(self.tl.locate(self.at("2026-10-06T10:00:07Z"))[2], "https://cdn/a1.ts")
        self.assertEqual(self.tl.locate(self.at("2026-10-06T10:01:06Z"))[2], "https://cdn/b1.ts")
        self.assertIsNone(self.tl.locate(self.at("2026-10-06T10:00:30Z")))  # the gap between the two tags
        self.assertIsNone(self.tl.locate(self.at("2026-10-06T09:00:00Z")))
        self.assertIsNone(self.tl.locate(self.at("2026-10-06T11:00:00Z")))

    def test_segments_before_the_first_tag_are_dropped(self):
        tl = sc.HlsTimeline.parse("#EXTINF:5.0,\nhttps://cdn/x.ts\n#EXT-X-PROGRAM-DATE-TIME:2026-10-06T10:00:00Z\n#EXTINF:5.0,\nhttps://cdn/y.ts")
        self.assertEqual([s[2] for s in tl.segments], ["https://cdn/y.ts"])


class WindowTests(unittest.TestCase):
    def test_sample_times_cover_minus_35_to_plus_25_every_2_5_minutes(self):
        ev = datetime(2026, 10, 6, 11, 15, tzinfo=timezone.utc)
        ts = sc.sample_times(ev)
        self.assertEqual(len(ts), 25)
        self.assertEqual(ts[0], ev - timedelta(minutes=35))
        self.assertEqual(ts[-1], ev + timedelta(minutes=25))
        self.assertEqual(ts[1] - ts[0], timedelta(seconds=150))

    def test_due_events_uses_the_25_minute_to_3_5_hour_window(self):
        cam = next(c for c in sc.load_config()["cams"] if c["id"] == "ftl-elbo-beach-cam")
        tz = sc.ZoneInfo("America/New_York")
        rise = sc.sun_times(cam["lat"], cam["lon"], date(2026, 10, 6))["sunrise"]

        def kinds(minutes_after):
            now = rise + timedelta(minutes=minutes_after)
            return [(e["local_date"], e["kind"]) for e in sc.due_events(cam, now, tz, False)]

        self.assertNotIn(("2026-10-06", "sunrise"), kinds(20))   # window not closed yet
        self.assertIn(("2026-10-06", "sunrise"), kinds(26))
        self.assertIn(("2026-10-06", "sunrise"), kinds(209))
        self.assertNotIn(("2026-10-06", "sunrise"), kinds(212))  # the DVR no longer holds the start

    def test_build_result_needs_enough_frames_and_picks_the_peak(self):
        t0 = datetime(2026, 10, 6, 11, 0, tzinfo=timezone.utc)
        frames = [
            {"t": t0 + timedelta(minutes=i), "score": s, "warm_frac": 0.1, "colorfulness": 40.0, "warm_sat": 0.4}
            for i, s in enumerate([10.0, 55.5, 30.0])
        ]
        self.assertIsNone(sc.build_result(frames, 10))  # 3 of 10 is under the 60% floor
        r = sc.build_result(frames, 4)
        self.assertEqual(r["observed_score"], 55.5)
        self.assertEqual(r["peak_frame_iso"], "2026-10-06T11:01:00.000Z")
        self.assertEqual(len(r["series"]), 3)


if __name__ == "__main__":
    unittest.main()
