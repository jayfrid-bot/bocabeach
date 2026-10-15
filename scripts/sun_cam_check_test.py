"""Unit tests for scripts/sun_cam_check.py. Run from the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

Needs Pillow (pip install pillow). No network, no yt-dlp, no ffmpeg.
"""

import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

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


def disc(im, cx, cy, r, rgb):
    from PIL import ImageDraw

    ImageDraw.Draw(im).ellipse([cx - r, cy - r, cx + r, cy + r], fill=rgb)


def glow_frame(size=(640, 360), sun=(320, 200), core=40, glow=90, bands=False):
    """A clear blue sky with a sun: a blown-out white core, an orange glow around it,
    and (optionally) hot-pink cloud bands across the top, far from the sun."""
    im = Image.new("RGB", size, (70, 120, 200))
    disc(im, sun[0], sun[1], glow, (235, 120, 50))
    disc(im, sun[0], sun[1], core, (255, 255, 245))
    if bands:
        for y0, y1 in ((8, 28), (45, 65)):
            im.paste((225, 70, 120), (0, y0, size[0], y1))
    return im


SKY = [[0.0, 0.0, 1.0, 0.7]]


@unittest.skipIf(Image is None, "Pillow missing")
class GlowMaskTests(unittest.TestCase):
    def test_a_clear_sky_with_a_bright_sun_glow_no_longer_scores_as_colorful(self):
        im = glow_frame()
        old = sc.score_image(im, SKY, glow=False)
        new = sc.score_image(im, SKY)
        self.assertGreater(old["score"], 30)  # the old rule counted the glow as warm sky
        self.assertLess(new["score"], 10)
        self.assertLess(new["warm_frac"], 0.02)
        self.assertGreater(new["glow_masked_frac"], 0.08)

    def test_lit_cloud_bands_away_from_the_sun_still_score_high(self):
        im = glow_frame(bands=True)
        new = sc.score_image(im, SKY)
        self.assertGreater(new["score"], 70)
        self.assertGreater(new["warm_frac"], 0.15)
        # the glow beside them is removed, so the clouds alone carry the score
        self.assertLess(sc.score_image(glow_frame(), SKY)["score"], new["score"] / 5)

    def test_the_mask_follows_the_sun_not_the_frame_centre(self):
        left = sc.find_sun(glow_frame(sun=(120, 200)), SKY)
        right = sc.find_sun(glow_frame(sun=(520, 200)), SKY)
        self.assertEqual(left["kind"], "disc")
        self.assertAlmostEqual(left["x"], 120, delta=6)
        self.assertAlmostEqual(left["y"], 200, delta=6)
        self.assertAlmostEqual(right["x"], 520, delta=6)
        self.assertLess(sc.score_image(glow_frame(sun=(120, 200)), SKY)["score"], 10)

    def test_the_radius_scales_with_the_blob_within_the_floor_and_the_cap(self):
        small = sc.find_sun(glow_frame(core=14, glow=16), SKY)
        big = sc.find_sun(glow_frame(core=60, glow=70), SKY)
        self.assertAlmostEqual(sc.glow_radius(small, 640), 0.06 * 640)  # the floor
        self.assertAlmostEqual(sc.glow_radius(big, 640), 2.5 * 60, delta=3)  # 2.5x the equivalent radius
        self.assertAlmostEqual(sc.glow_radius({"r_eq": 1000.0}, 640), 0.25 * 640)  # the cap

    def test_a_tiny_bright_speck_is_not_the_sun(self):
        im = Image.new("RGB", (640, 360), (70, 120, 200))
        disc(im, 300, 50, 3, (255, 255, 250))  # a glint on a cloud edge
        self.assertIsNone(sc.find_sun(im, SKY))
        with_speck = sc.score_image(im, SKY)
        self.assertEqual(with_speck["glow_masked_frac"], 0.0)

    def test_a_sun_below_the_horizon_is_found_as_the_brightest_warm_blob_near_the_horizon(self):
        # No blown-out disc: a saturated gold blob sits on the horizon (the bottom edge of the sky region)
        # inside a wider, dimmer orange wash. Warm sky near the top is a different thing and stays.
        im = Image.new("RGB", (640, 360), (70, 120, 200))
        disc(im, 320, 240, 90, (200, 100, 50))  # dim wash: warm, but V < 0.85
        disc(im, 320, 240, 45, (255, 150, 40))  # the bright core
        im.paste((225, 70, 120), (0, 10, 640, 35))  # hot-pink cloud band, far above
        sun = sc.find_sun(im, SKY)
        self.assertIsNotNone(sun)
        self.assertEqual(sun["kind"], "warm")
        self.assertAlmostEqual(sun["x"], 320, delta=6)
        self.assertAlmostEqual(sun["y"], 240, delta=10)  # a little low: candidates must sit in the horizon band
        old = sc.score_image(im, SKY, glow=False)
        new = sc.score_image(im, SKY)
        self.assertGreater(new["glow_masked_frac"], 0.1)
        self.assertLess(new["warm_frac"], old["warm_frac"] + 1e-9)
        # without the cloud band, the same sunrise glow scores near nothing
        plain = Image.new("RGB", (640, 360), (70, 120, 200))
        disc(plain, 320, 240, 90, (200, 100, 50))
        disc(plain, 320, 240, 45, (255, 150, 40))
        self.assertGreater(sc.score_image(plain, SKY, glow=False)["score"], 20)
        self.assertLess(sc.score_image(plain, SKY)["score"], 8)

    def test_warm_candidates_far_above_the_horizon_are_not_taken_for_the_sun(self):
        im = Image.new("RGB", (640, 360), (70, 120, 200))
        disc(im, 320, 40, 45, (255, 150, 40))  # a bright gold cloud near the top of the sky, nowhere near the horizon
        self.assertIsNone(sc.find_sun(im, SKY))

    def test_no_sun_means_no_mask_and_the_old_score(self):
        im = Image.new("RGB", (160, 90))
        im.paste((200, 100, 60), (0, 0, 80, 90))  # warm, but not bright enough to look like a sun
        im.paste((190, 80, 120), (80, 0, 160, 90))
        a, b = sc.score_image(im, FULL), sc.score_image(im, FULL, glow=False)
        self.assertEqual(a["glow_masked_frac"], 0.0)
        self.assertEqual(a["score"], b["score"])

    def test_masked_pixels_count_against_valid_frac_like_glare(self):
        new = sc.score_image(glow_frame(), SKY)
        old = sc.score_image(glow_frame(), SKY, glow=False)
        self.assertAlmostEqual(old["valid_frac"] - new["valid_frac"], new["glow_masked_frac"], places=3)

    def test_the_series_carries_glow_masked_frac(self):
        event = datetime(2026, 10, 6, 11, 15, tzinfo=timezone.utc)
        frames = []
        for k in range(25):
            t = event + timedelta(seconds=150 * (k - 14))
            frames.append({"t": t, "valid_frac": 0.8, "warm_frac": 0.2, "colorfulness": 50.0, "warm_sat": 0.4, "score": 40.0, "glow_masked_frac": 0.123456})
        result, _info = sc.build_result(frames, event)
        self.assertIsNotNone(result)
        self.assertTrue(all(f["glow_masked_frac"] == 0.1235 for f in result["series"]))

    def test_the_score_version_was_bumped_for_the_new_rule(self):
        self.assertGreater(sc.SUN_CAM_SCORE_VERSION, "2026-10-06.2")

    @unittest.skipUnless(OCT6_DIR.exists(), "the 2026-10-06 Elbo frames are not on this machine")
    def test_the_oct6_elbo_calibration_anchor_survives_the_glow_mask(self):
        cam = next(c for c in sc.load_config()["cams"] if c["id"] == "ftl-elbo-beach-cam")
        peak = sc.score_file(OCT6_DIR / "1105Z.jpg", cam["sky_regions"])
        self.assertTrue(90 <= peak["score"] <= 97, peak["score"])
        self.assertGreater(peak["glow_masked_frac"], 0.0)  # the mask did run on the anchor frame


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
        self.assertEqual(sc.view_for("east", "sunrise"), "solar")
        self.assertEqual(sc.view_for("east", "sunset"), "antisolar")

    def test_view_west_facing_is_the_mirror_image(self):
        self.assertEqual(sc.view_for("west", "sunset"), "solar")
        self.assertEqual(sc.view_for("west", "sunrise"), "antisolar")

    def test_view_rejects_a_facing_that_is_not_east_or_west(self):
        with self.assertRaises(ValueError):
            sc.view_for("north", "sunrise")
        with self.assertRaises(ValueError):
            sc.view_for(90, "sunrise")

    def test_cam_facing_uses_the_registry_value_else_derives_it_from_the_azimuth(self):
        self.assertEqual(sc.cam_facing({"facing": "west", "facing_azimuth_deg": 90}), "west")
        self.assertEqual(sc.cam_facing({"facing_azimuth_deg": 90}), "east")
        self.assertEqual(sc.cam_facing({"facing_azimuth_deg": 179.9}), "east")
        self.assertEqual(sc.cam_facing({"facing_azimuth_deg": 180}), "west")
        self.assertEqual(sc.cam_facing({"facing_azimuth_deg": 270}), "west")
        self.assertEqual(sc.cam_facing({"facing_azimuth_deg": -90}), "west")
        self.assertEqual(sc.cam_facing({"facing": "sideways", "facing_azimuth_deg": 90}), "east")  # an invalid value falls back to the azimuth

    def test_every_registry_cam_has_a_facing_that_agrees_with_its_azimuth(self):
        for cam in sc.load_config()["cams"]:
            derived = "east" if cam["facing_azimuth_deg"] % 360 < 180 else "west"
            self.assertEqual(sc.cam_facing(cam), derived, cam["id"])
            if "facing" in cam:
                self.assertEqual(cam["facing"], derived, cam["id"])

    def test_due_events_label_the_view_by_the_cams_facing(self):
        tz = ZoneInfo("America/New_York")
        east = {"id": "e", "lat": 26.1, "lon": -80.1, "facing_azimuth_deg": 90, "beaches": [{"slug": "x", "lat": 26.1, "lon": -80.1, "distance_mi": 0}]}
        west = {**east, "id": "w", "facing_azimuth_deg": 270, "facing": "west"}
        now = datetime(2026, 10, 6, 15, 0, tzinfo=timezone.utc)
        views = lambda cam: {e["kind"]: e["view"] for e in sc.due_events(cam, now, tz, True) if e["local_date"] == "2026-10-06"}
        self.assertEqual(views(east), {"sunrise": "solar"})  # only the sunrise has happened yet at 15:00Z
        self.assertEqual(views(west), {"sunrise": "antisolar"})
        late = datetime(2026, 10, 7, 0, 30, tzinfo=timezone.utc)
        self.assertEqual({e["kind"]: e["view"] for e in sc.due_events(east, late, tz, True) if e["local_date"] == "2026-10-06"}["sunset"], "antisolar")
        self.assertEqual({e["kind"]: e["view"] for e in sc.due_events(west, late, tz, True) if e["local_date"] == "2026-10-06"}["sunset"], "solar")


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


EVENT = datetime(2026, 10, 6, 11, 15, tzinfo=timezone.utc)


def frame(minutes, score, valid=0.9):
    return {"t": EVENT + timedelta(minutes=minutes), "score": score, "warm_frac": 0.1, "colorfulness": 40.0, "warm_sat": 0.4, "valid_frac": valid}


def grid(scores_by_minute=None, start=-35.0, end=25.0, step=2.5, base=20.0):
    """A full 2.5-minute capture; `scores_by_minute` overrides single frames."""
    out, m = [], start
    while m <= end + 1e-9:
        out.append(frame(m, (scores_by_minute or {}).get(m, base)))
        m += step
    return out


class RobustPeakTests(unittest.TestCase):
    def series(self, pairs):
        return [{"t": sc.iso_z(EVENT + timedelta(minutes=m)), "score": v} for m, v in pairs]

    def test_a_sharp_real_peak_beside_a_lower_frame_is_untouched(self):
        self.assertEqual(sc.robust_peak(self.series([(-7.5, 28.3), (-5, 94.4), (-2.5, 59.3)])), (1, 94.4))

    def test_an_isolated_spike_is_cut_to_twice_its_best_neighbor_and_is_not_the_reported_frame(self):
        idx, value = sc.robust_peak(self.series([(-5, 10.0), (-2.5, 95.0), (0, 12.0)]))
        self.assertEqual((idx, value), (2, 24.0))  # the 12, not the capped 95

    def test_frames_five_minutes_apart_corroborate_each_other(self):
        self.assertEqual(sc.robust_peak(self.series([(-15, 28.3), (-10, 94.4), (-5, 59.3)]))[1], 94.4)

    def test_a_frame_with_no_close_neighbor_does_not_count(self):
        self.assertEqual(sc.robust_peak(self.series([(-20, 99.0), (-10, 40.0), (-7.5, 38.0)])), (1, 40.0))
        self.assertIsNone(sc.robust_peak(self.series([(-20, 99.0), (0, 40.0)])))
        self.assertIsNone(sc.robust_peak([]))

    def test_ties_go_to_the_earliest_frame(self):
        self.assertEqual(sc.robust_peak(self.series([(-5, 50.0), (-2.5, 50.0)]))[0], 0)


class VersionTests(unittest.TestCase):
    def test_the_score_version_is_a_real_date_no_more_than_a_day_ahead(self):
        import re

        m = re.match(r"^(\d{4})-(\d{2})-(\d{2})\.(\d{1,3})$", sc.SUN_CAM_SCORE_VERSION)
        self.assertIsNotNone(m, sc.SUN_CAM_SCORE_VERSION)
        d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))  # raises on a bogus date
        self.assertLessEqual(d, datetime.now(timezone.utc).date() + timedelta(days=1))


class CoverageAndResultTests(unittest.TestCase):
    def test_a_full_capture_is_complete_and_scores_its_robust_peak(self):
        frames = grid({-5.0: 90.0, -7.5: 70.0, -2.5: 55.0})
        result, info = sc.build_result(frames, EVENT)
        self.assertIsNotNone(result)
        self.assertEqual(result["observed_score"], 90.0)
        self.assertEqual(result["peak_frame_iso"], "2026-10-06T11:10:00.000Z")
        self.assertEqual(len(result["series"]), 25)
        self.assertEqual(info["coverage"], {"pre": 10, "around": 8, "post": 7})
        self.assertEqual(result["warm_frac"], 0.1)

    def test_the_series_is_the_scale_the_server_recomputes_from(self):
        # rounding happens BEFORE the peak, so server and client see the same numbers
        frames = grid({-5.0: 90.04, -7.5: 70.06})
        result, _ = sc.build_result(frames, EVENT)
        self.assertEqual(result["observed_score"], 90.0)
        idx, value = sc.robust_peak(result["series"])
        self.assertEqual(value, 90.0)
        self.assertEqual(result["series"][idx]["t"], result["peak_frame_iso"])

    def test_each_bucket_needs_three_usable_frames(self):
        def without(lo, hi):
            return [f for f in grid() if not (lo <= (f["t"] - EVENT).total_seconds() / 60 <= hi)]

        for lo, hi, name in [(-12.4, -12.4, None), (-35, -15, "pre"), (-10, 7.5, "around"), (10, 25, "post")]:
            if name is None:
                continue
            result, info = sc.build_result(without(lo, hi), EVENT)
            self.assertIsNone(result, name)
            self.assertIn("coverage", info["reason"])
        # exactly three in the post bucket is enough
        keep = [f for f in grid() if (f["t"] - EVENT).total_seconds() / 60 <= 8 or (f["t"] - EVENT).total_seconds() / 60 in (10.0, 12.5, 15.0)]
        result, info = sc.build_result(keep, EVENT)
        self.assertIsNotNone(result)
        self.assertEqual(info["coverage"]["post"], 3)
        two = [f for f in keep if (f["t"] - EVENT).total_seconds() / 60 != 15.0]
        self.assertIsNone(sc.build_result(two, EVENT)[0])

    def test_unusable_frames_are_dropped_and_do_not_count_toward_coverage(self):
        frames = grid()
        for f in frames:
            if (f["t"] - EVENT).total_seconds() / 60 > 8:
                f["valid_frac"] = 0.02  # a blown-out or black afterglow
        result, info = sc.build_result(frames, EVENT)
        self.assertIsNone(result)
        self.assertEqual(info["coverage"]["post"], 0)
        self.assertEqual(info["usable"], 18)

    def test_an_artifact_spike_cannot_become_the_event_score(self):
        frames = grid(base=12.0)
        frames[12]["score"] = 95.0  # one glitched frame among 12s
        result, _ = sc.build_result(frames, EVENT)
        self.assertEqual(result["observed_score"], 24.0)

    def test_a_real_edge_peak_whose_neighbors_were_lost_is_incomplete_not_scored_as_20(self):
        # Codex's repro: a real 94 at +25 with +17.5 / +20 / +22.5 lost to 403s. Bucket coverage
        # still passes (10/8/4), but the 94 has no neighbor within 5 min, so the old rule threw it away.
        lost = {17.5, 20.0, 22.5}
        frames = [f for f in grid({25.0: 94.0}, base=20.0) if (f["t"] - EVENT).total_seconds() / 60 not in lost]
        self.assertEqual(sc.coverage_counts([f["t"] for f in frames], EVENT), {"pre": 10, "around": 8, "post": 4})
        result, info = sc.build_result(frames, EVENT)
        self.assertIsNone(result)
        self.assertIn("highest frame has no neighbor", info["reason"])
        self.assertFalse(sc.top_frame_corroborated([{"t": sc.iso_z(f["t"]), "score": f["score"]} for f in frames]))

    def test_the_same_edge_peak_is_fine_when_a_neighbor_survives_within_five_minutes(self):
        frames = [f for f in grid({25.0: 94.0}, base=20.0) if (f["t"] - EVENT).total_seconds() / 60 != 22.5]
        result, _ = sc.build_result(frames, EVENT)
        self.assertIsNotNone(result)
        self.assertEqual(result["observed_score"], 40.0)  # 94 is capped at 2x its neighbor (20), a glitch-safe score
        # ...and a real peak with a high neighbor keeps its value
        frames = [f for f in grid({25.0: 94.0, 20.0: 80.0}, base=20.0) if (f["t"] - EVENT).total_seconds() / 60 != 22.5]
        result, _ = sc.build_result(frames, EVENT)
        self.assertEqual(result["observed_score"], 94.0)

    def test_a_capped_frame_never_lends_its_metadata(self):
        frames = grid(base=12.0)
        for i, f in enumerate(frames):
            f["warm_frac"], f["colorfulness"] = 0.05, 35.0
        frames[12].update(score=95.0, warm_frac=0.9, colorfulness=99.0)  # the glitch frame, with telltale numbers
        result, _ = sc.build_result(frames, EVENT)
        self.assertEqual(result["observed_score"], 24.0)
        self.assertNotEqual(result["peak_frame_iso"], sc.iso_z(frames[12]["t"]))
        self.assertEqual((result["warm_frac"], result["colorfulness"]), (0.05, 35.0))
        self.assertEqual(result["peak_frame_score"], 12.0)

    def test_frames_outside_the_window_stay_out_of_the_series(self):
        frames = grid() + [frame(40, 99.0), frame(-60, 99.0)]
        result, _ = sc.build_result(frames, EVENT)
        self.assertEqual(len(result["series"]), 25)
        self.assertEqual(result["observed_score"], 20.0)

    def test_payload_carries_version_and_scored_at(self):
        result, _ = sc.build_result(grid({-5.0: 90.0}), EVENT)
        cam = next(c for c in sc.load_config()["cams"] if c["id"] == "ftl-elbo-beach-cam")
        when = datetime(2026, 10, 6, 14, 0, tzinfo=timezone.utc)
        payload = sc.payload_for(cam, cam["beaches"][0], "sunrise", "2026-10-06", sc.iso_z(EVENT), "solar", result, when)
        self.assertEqual(payload["scored_at"], "2026-10-06T14:00:00.000Z")
        self.assertRegex(payload["score_version"], r"^\d{4}-\d{2}-\d{2}\.\d+$")
        self.assertEqual(payload["credit"], cam["credit"])


class IncompleteHandlingTests(unittest.TestCase):
    """run_normal against a fake DVR that only holds half the window."""

    def setUp(self):
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.saved = (sc.STATE_FILE, sc.FRAMES_ROOT, sc.TOKEN_FILE, sc.DvrSession, sc.score_file, sc.post_observation, sc.save_frames)
        sc.STATE_FILE = Path(self.tmp.name) / "state.json"
        sc.FRAMES_ROOT = Path(self.tmp.name) / "frames"
        sc.TOKEN_FILE = Path(self.tmp.name) / "token"
        sc.TOKEN_FILE.write_text("t")
        self.posts = []
        outer = self

        class FakeDvr:
            def __init__(self, cam):
                pass

            def open(self):
                return True

            def frame(self, t, workdir):
                if outer.holds(t):
                    p = Path(workdir) / "f.jpg"
                    p.write_bytes(b"x")
                    return p
                return None

        sc.DvrSession = FakeDvr
        sc.score_file = lambda path, regions: {"valid_frac": 0.9, "warm_frac": 0.1, "colorfulness": 40.0, "warm_sat": 0.4, "score": 30.0}
        sc.post_observation = lambda payload, token: (self.posts.append(payload) or True, "ok")
        sc.save_frames = lambda *a, **k: None
        self.cfg = sc.load_config()
        self.cfg["cams"] = [c for c in self.cfg["cams"] if c["id"] == "ftl-elbo-beach-cam"]
        self.rise = sc.sun_times(26.1195, -80.1035, date(2026, 10, 6))["sunrise"]
        self.holds = lambda t: (t - self.rise).total_seconds() / 60 <= 0  # nothing after the event

    def tearDown(self):
        (sc.STATE_FILE, sc.FRAMES_ROOT, sc.TOKEN_FILE, sc.DvrSession, sc.score_file, sc.post_observation, sc.save_frames) = self.saved

    def run_at(self, minutes_after, **flags):
        import argparse

        args = argparse.Namespace(now=sc.iso_z(self.rise + timedelta(minutes=minutes_after)), dry_run=False, force=False, cams=None, json=False, verbose=False)
        for k, v in flags.items():
            setattr(args, k, v)
        return sc.run_normal(args, self.cfg)

    def state(self):
        return sc.load_state()["done"]

    def test_incomplete_is_not_uploaded_and_not_marked_done_while_the_dvr_still_has_it(self):
        self.run_at(60)
        self.assertEqual(self.posts, [])
        self.assertNotIn("fort-lauderdale|sunrise|2026-10-06|ftl-elbo-beach-cam", self.state())

    def test_when_the_dvr_window_is_closing_it_is_marked_incomplete_and_still_not_uploaded(self):
        self.run_at(185)
        self.assertEqual(self.posts, [])
        entry = self.state()["fort-lauderdale|sunrise|2026-10-06|ftl-elbo-beach-cam"]
        self.assertEqual(entry["status"], "incomplete")
        self.assertIn("coverage", entry["reason"])
        # later runs leave it alone
        self.run_at(200)
        self.assertEqual(self.posts, [])

    def test_an_event_that_aged_out_unseen_is_marked_incomplete_without_a_capture(self):
        self.run_at(300)
        self.assertEqual(self.posts, [])
        self.assertEqual(self.state()["fort-lauderdale|sunrise|2026-10-06|ftl-elbo-beach-cam"]["status"], "incomplete")

    def test_dry_run_and_force_never_write_state(self):
        self.run_at(185, dry_run=True)
        self.run_at(185, force=True)
        self.assertEqual(self.state(), {})

    def test_a_complete_capture_uploads_once_and_is_marked_uploaded(self):
        self.holds = lambda t: True
        self.run_at(60)
        self.assertEqual(len(self.posts), 1)
        self.assertEqual(self.posts[0]["slug"], "fort-lauderdale")
        self.assertRegex(self.posts[0]["scored_at"], r"Z$")
        self.assertEqual(self.state()["fort-lauderdale|sunrise|2026-10-06|ftl-elbo-beach-cam"]["status"], "uploaded")
        self.run_at(90)
        self.assertEqual(len(self.posts), 1)  # already done


if __name__ == "__main__":
    unittest.main()
