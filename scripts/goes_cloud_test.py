"""Unit tests for the IR cloud-top read and the run window in scripts/goes_cloud.py.
Run from the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

No network, no granule files, no h5py: the tests build a synthetic ABI grid
(real GOES-East navigation, painted ACM / ACHA arrays) and check the layer
classification, the DQF rules, and the horizon-path geometry at low sun.
"""

import datetime as dt
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import goes_cloud as gc  # noqa: E402

UTC = dt.timezone.utc
BOCA = {"slug": "boca-raton", "lat": 26.3587, "lon": -80.0686, "timezone": "America/New_York"}

# GOES-East CONUS fixed grid (2 km): the real projection numbers and offsets.
N_ROWS, N_COLS = 1500, 2500
X_OFF, X_SCALE = -0.101332, 5.6e-05
Y_OFF, Y_SCALE = 0.128212, -5.6e-05
HT_SCALE = 0.3052037


def utc(y, mo, d, h=0, mi=0, s=0):
    return dt.datetime(y, mo, d, h, mi, s, tzinfo=UTC)


def make_grid(acm_dqf=0):
    """An all-clear grid: ACM 0, good mask DQF, no cloud-top height."""
    nav = gc.AbiNav(6378137.0, 6356752.31414, 35786023.0, -75.0)
    return gc.IrGrid(
        nav,
        X_OFF,
        X_SCALE,
        Y_OFF,
        Y_SCALE,
        acm=np.zeros((N_ROWS, N_COLS), dtype=np.uint8),
        acm_dqf=np.full((N_ROWS, N_COLS), acm_dqf, dtype=np.uint8),
        ht_raw=np.full((N_ROWS, N_COLS), gc.HT_FILL, dtype=np.uint16),
        ht_dqf=np.full((N_ROWS, N_COLS), 3, dtype=np.uint8),
        ht_scale=HT_SCALE,
    )


def paint(grid, lat, lon, half_km, top_m, acm=3, ht_dqf=0, with_height=True):
    """Fill a square of cloud (half_km each side of lat/lon) with `acm`, a
    cloud-top height `top_m` (metres) and the given ACHA DQF."""
    row, col = grid.pixel(lat, lon)
    r = max(0, int(round(half_km / 2.0)))
    sl = (slice(row - r, row + r + 1), slice(col - r, col + r + 1))
    grid.acm[sl] = acm
    grid.ht_dqf[sl] = ht_dqf
    if with_height:
        grid.ht_raw[sl] = int(round(top_m / HT_SCALE))
    else:
        grid.ht_raw[sl] = gc.HT_FILL


def beach_box(grid, radius_px=7):
    return grid.box(BOCA["lat"], BOCA["lon"], radius_px)


class LayerClassification(unittest.TestCase):
    def test_top_height_bands(self):
        # (cloud top in metres, expected layer). 2000 and 6000 belong to the
        # upper band (Open-Meteo: low up to 2 km, mid 2-6 km, high above 6 km).
        cases = [(300, "low"), (1500, "low"), (1990, "low"), (2010, "mid"), (4000, "mid"), (5990, "mid"), (6010, "high"), (9000, "high"), (14000, "high")]
        for top, layer in cases:
            g = make_grid()
            paint(g, BOCA["lat"], BOCA["lon"], 40, top)
            c = beach_box(g)
            counts = {"low": c.low, "mid": c.mid, "high": c.high}
            self.assertEqual(counts[layer], c.valid, f"top {top} m should be all {layer}: {counts}")
            self.assertEqual(c.cloudy, c.valid)
            self.assertEqual(c.unclassified, 0)

    def test_clear_sky_reads_zero_everywhere(self):
        r = gc.overhead_read(beach_box(make_grid()), 5)
        self.assertEqual((r["lowPct"], r["midPct"], r["highPct"], r["irCloudPct"]), (0.0, 0.0, 0.0, 0.0))
        self.assertIsNone(r["classifiedPct"])  # no cloud, nothing to classify
        self.assertEqual(r["validPixels"], 225)

    def test_mixed_box_shares(self):
        g = make_grid()
        row, col = g.pixel(BOCA["lat"], BOCA["lon"])
        # Left third low deck, middle third cirrus, right third clear.
        g.acm[row - 7 : row + 8, col - 7 : col - 2] = 3
        g.ht_raw[row - 7 : row + 8, col - 7 : col - 2] = int(1200 / HT_SCALE)
        g.ht_dqf[row - 7 : row + 8, col - 7 : col - 2] = 0
        g.acm[row - 7 : row + 8, col - 2 : col + 3] = 3
        g.ht_raw[row - 7 : row + 8, col - 2 : col + 3] = int(10000 / HT_SCALE)
        g.ht_dqf[row - 7 : row + 8, col - 2 : col + 3] = 0
        r = gc.overhead_read(beach_box(g), 5)
        self.assertEqual(r["lowPct"], round(100 * 75 / 225, 1))
        self.assertEqual(r["highPct"], round(100 * 75 / 225, 1))
        self.assertEqual(r["midPct"], 0.0)
        self.assertEqual(r["irCloudPct"], round(100 * 150 / 225, 1))
        self.assertEqual(r["classifiedPct"], 100.0)
        # Layers never overlap: low + mid + high cannot exceed total cloud.
        self.assertLessEqual(r["lowPct"] + r["midPct"] + r["highPct"], r["irCloudPct"] + 0.1)

    def test_mask_levels_cloudy_means_probably_cloudy_or_cloudy(self):
        for acm, expect_cloud in [(0, False), (1, False), (2, True), (3, True)]:
            g = make_grid()
            paint(g, BOCA["lat"], BOCA["lon"], 40, 1000, acm=acm)
            c = beach_box(g)
            self.assertEqual(c.cloudy > 0, expect_cloud, f"ACM {acm}")


class DqfRules(unittest.TestCase):
    def test_bad_mask_dqf_pixels_are_not_counted_at_all(self):
        g = make_grid()
        paint(g, BOCA["lat"], BOCA["lon"], 40, 1000)
        row, col = g.pixel(BOCA["lat"], BOCA["lon"])
        g.acm_dqf[row - 7 : row + 8, col - 7 : col + 1] = 6  # degraded: left half
        c = beach_box(g)
        self.assertEqual(c.total, 225)
        self.assertEqual(c.valid, 15 * 7)
        self.assertEqual(c.low, c.valid)

    def test_too_few_valid_pixels_gives_no_read(self):
        g = make_grid(acm_dqf=6)  # every pixel degraded
        self.assertEqual(beach_box(g).valid, 0)
        self.assertIsNone(gc.overhead_read(beach_box(g), 5))
        self.assertIsNone(gc.overhead_read(None, 5))  # off the grid

    def test_cloud_without_a_usable_height_is_unclassified(self):
        g = make_grid()
        paint(g, BOCA["lat"], BOCA["lon"], 40, 0, with_height=False, ht_dqf=3)
        r = gc.overhead_read(beach_box(g), 5)
        self.assertEqual(r["irCloudPct"], 100.0)
        self.assertEqual(r["unclassifiedPct"], 100.0)
        self.assertEqual((r["lowPct"], r["midPct"], r["highPct"]), (0.0, 0.0, 0.0))
        self.assertEqual(r["classifiedPct"], 0.0)

    def test_acha_dqf_good_and_marginal_count_retrieval_attempted_does_not(self):
        for dqf, counts in [(0, True), (1, True), (2, False), (3, False), (4, False)]:
            g = make_grid()
            paint(g, BOCA["lat"], BOCA["lon"], 40, 1000, ht_dqf=dqf)
            c = beach_box(g)
            self.assertEqual(c.low > 0, counts, f"ACHA DQF {dqf}")
            self.assertEqual(c.unclassified > 0, not counts, f"ACHA DQF {dqf}")

    def test_height_fill_value_is_never_a_height(self):
        g = make_grid()
        paint(g, BOCA["lat"], BOCA["lon"], 40, 0, with_height=False, ht_dqf=0)  # DQF says good, HT is fill
        c = beach_box(g)
        self.assertEqual(c.low + c.mid + c.high, 0)
        self.assertEqual(c.unclassified, c.cloudy)


class RayGeometry(unittest.TestCase):
    def test_ray_height_at_the_horizon(self):
        self.assertEqual(gc.ray_height_m(0.0), 0.0)
        self.assertAlmostEqual(gc.ray_height_m(10.0), 5.9, delta=0.5)  # d^2/2R only
        self.assertAlmostEqual(gc.ray_height_m(110.0), 712, delta=15)
        self.assertAlmostEqual(gc.ray_height_m(150.0), 1324, delta=20)
        d = [gc.ray_height_m(x) for x in gc.IR_PATH_DISTANCES_KM]
        self.assertEqual(d, sorted(d))

    def test_a_higher_sun_lifts_the_ray(self):
        self.assertGreater(gc.ray_height_m(20.0, 3.0), gc.ray_height_m(20.0, 0.0) + 1000)
        self.assertEqual(gc.ray_height_m(10.0, -5.0), 0.0)  # a sun below the horizon never gives a negative height

    def test_offset_toward_the_sun_moves_the_right_way(self):
        g = make_grid()
        r0, c0 = g.pixel(BOCA["lat"], BOCA["lon"])
        lat, lon = gc.offset_latlon(BOCA["lat"], BOCA["lon"], 50.0, 260.3)  # sunset azimuth
        r1, c1 = g.pixel(lat, lon)
        self.assertLess(c1, c0)  # west = left on the fixed grid
        self.assertGreater(r1, r0)  # a touch south of west = down
        self.assertAlmostEqual(c0 - c1, 50.0 / 2.0 * 1.0, delta=4)  # ~2 km pixels
        lat, lon = gc.offset_latlon(BOCA["lat"], BOCA["lon"], 50.0, 99.7)  # sunrise azimuth
        self.assertGreater(g.pixel(lat, lon)[1], c0)

    def test_low_deck_toward_the_sunset_blocks_but_not_the_antisolar_side(self):
        g = make_grid()
        az = 260.3
        lat, lon = gc.offset_latlon(BOCA["lat"], BOCA["lon"], 35.0, az)
        paint(g, lat, lon, 8, 1500)  # a 1.5 km-top low deck ~35 km west, 16 km wide
        toward = gc.path_read(g, BOCA["lat"], BOCA["lon"], az, 3, 5)
        away = gc.path_read(g, BOCA["lat"], BOCA["lon"], (az + 180) % 360, 3, 5)
        self.assertGreater(toward["beamLowPct"], 8.0)
        self.assertEqual(toward["beamMidHighPct"], 0.0)
        self.assertEqual(toward["beamSamples"], 7)
        self.assertEqual(away["beamLowPct"], 0.0)

    def test_shallow_deck_far_away_stays_under_the_ray_but_near_by_it_blocks(self):
        # Top 300 m: the ray is only ~6 m high at 10 km, but 1324 m at 150 km.
        near, far = make_grid(), make_grid()
        az = 260.3
        lat, lon = gc.offset_latlon(BOCA["lat"], BOCA["lon"], 10.0, az)
        paint(near, lat, lon, 6, 300)
        lat, lon = gc.offset_latlon(BOCA["lat"], BOCA["lon"], 150.0, az)
        paint(far, lat, lon, 6, 300)
        far_read = gc.path_read(far, BOCA["lat"], BOCA["lon"], az, 3, 5)
        near_read = gc.path_read(near, BOCA["lat"], BOCA["lon"], az, 3, 5)
        self.assertGreater(near_read["beamLowPct"], 0.0)
        self.assertGreater(near_read["beamLowPct"], far_read["beamLowPct"])
        # The far deck sits below the ray at its distance: low cloud, not blocking.
        self.assertEqual(far_read["beamLowPct"], 0.0)
        # A deck whose top clears the ray at 150 km (1.5 km > 1.3 km) does block.
        tall = make_grid()
        paint(tall, lat, lon, 6, 1600)
        self.assertGreater(gc.path_read(tall, BOCA["lat"], BOCA["lon"], az, 3, 5)["beamLowPct"], 0.0)

    def test_mid_and_high_deck_toward_the_sun_is_canvas_not_blocker(self):
        g = make_grid()
        az = 260.3
        for d_km, top in [(55.0, 9000), (80.0, 4500)]:
            lat, lon = gc.offset_latlon(BOCA["lat"], BOCA["lon"], d_km, az)
            paint(g, lat, lon, 12, top)
        r = gc.path_read(g, BOCA["lat"], BOCA["lon"], az, 3, 5)
        self.assertEqual(r["beamLowPct"], 0.0)
        self.assertGreater(r["beamMidHighPct"], 20.0)

    def test_path_off_the_grid_or_masked_returns_null_not_a_guess(self):
        r = gc.path_read(make_grid(acm_dqf=6), BOCA["lat"], BOCA["lon"], 260.3, 3, 5)
        self.assertEqual((r["beamLowPct"], r["beamMidHighPct"], r["beamSamples"]), (None, None, 0))
        # A point east of the CONUS sector: every box is off the grid.
        r = gc.path_read(make_grid(), 30.0, -55.0, 90.0, 3, 5)
        self.assertEqual(r["beamSamples"], 0)
        self.assertIsNone(r["beamLowPct"])


class SunEvents(unittest.TestCase):
    def test_sunset_event_uses_the_azimuth_at_the_event(self):
        ev = gc.sun_events_near(BOCA["lat"], BOCA["lon"], "America/New_York", utc(2026, 10, 15, 22, 0))
        self.assertEqual(set(ev), {"sunset"})
        self.assertEqual(ev["sunset"]["eventIso"], "2026-10-15T22:52:20Z")
        self.assertAlmostEqual(ev["sunset"]["azDeg"], 260.3, delta=0.3)

    def test_sunrise_event(self):
        ev = gc.sun_events_near(BOCA["lat"], BOCA["lon"], "America/New_York", utc(2026, 10, 15, 11, 30))
        self.assertEqual(set(ev), {"sunrise"})
        self.assertAlmostEqual(ev["sunrise"]["azDeg"], 99.7, delta=0.3)

    def test_no_event_when_the_granule_is_hours_from_one(self):
        self.assertEqual(gc.sun_events_near(BOCA["lat"], BOCA["lon"], "America/New_York", utc(2026, 10, 15, 17, 0)), {})

    def test_after_midnight_utc_still_finds_this_evenings_sunset(self):
        # 00:10Z on the 16th is 8:10 PM EDT on the 15th: sunset (22:52Z) is 78 min back.
        ev = gc.sun_events_near(BOCA["lat"], BOCA["lon"], "America/New_York", utc(2026, 10, 16, 0, 10))
        self.assertEqual(ev["sunset"]["eventIso"], "2026-10-15T22:52:20Z")

    def test_beach_read_carries_event_paths_and_quality(self):
        g = make_grid()
        az = 260.3
        lat, lon = gc.offset_latlon(BOCA["lat"], BOCA["lon"], 35.0, az)
        paint(g, lat, lon, 8, 1500)
        read = gc.ir_beach_read(g, BOCA, utc(2026, 10, 15, 22, 35), 5, 7, 3)
        self.assertEqual(read["validPixels"], 225)
        self.assertEqual(set(read["events"]), {"sunset"})
        e = read["events"]["sunset"]
        self.assertGreater(e["beamLowPct"], 0.0)
        self.assertEqual(e["antiMidHighPct"], 0.0)
        self.assertEqual(e["beamSamples"], 7)
        # Clear overhead, deck out toward the sun.
        self.assertEqual(read["irCloudPct"], 0.0)

    def test_beach_off_the_grid_has_no_read(self):
        waikiki = {"slug": "waikiki", "lat": 21.28, "lon": -157.83, "timezone": "Pacific/Honolulu"}
        self.assertIsNone(gc.ir_beach_read(make_grid(), waikiki, utc(2026, 10, 15, 22, 0), 5, 7, 3))


class RunWindow(unittest.TestCase):
    # Boca 2026-10-15: sunrise 11:19:37Z, sunset 22:52:20Z. Window = 10:04:37Z .. 23:37:20Z.
    LA = {"slug": "santa-monica", "lat": 34.01, "lon": -118.5, "timezone": "America/Los_Angeles"}

    def test_a_beachs_window_is_sunrise_minus_75_to_sunset_plus_45(self):
        wins = gc.beach_windows(BOCA, utc(2026, 10, 15, 15, 0))
        self.assertEqual(len(wins), 3)  # yesterday, today, tomorrow
        start, end = wins[1]
        self.assertEqual(start.replace(microsecond=0), utc(2026, 10, 15, 10, 4, 37))
        self.assertEqual(end.replace(microsecond=0), utc(2026, 10, 15, 23, 37, 20))

    def test_states_across_the_day(self):
        cases = [
            (utc(2026, 10, 15, 10, 0), "night"),
            (utc(2026, 10, 15, 10, 10), "day"),  # inside the 75 min before sunrise
            (utc(2026, 10, 15, 11, 19), "day"),
            (utc(2026, 10, 15, 22, 52), "day"),
            (utc(2026, 10, 15, 23, 30), "day"),  # inside the 45 min after sunset
            (utc(2026, 10, 15, 23, 40), "dusk"),
            (utc(2026, 10, 15, 23, 56), "dusk"),
            (utc(2026, 10, 15, 23, 58), "night"),
        ]
        for now, want in cases:
            self.assertEqual(gc.window_state(now, [BOCA]), want, now.isoformat())

    def test_across_zones_the_night_between_eastern_sunset_and_sunrise_stays_night(self):
        # The bug: after Eastern midnight but before Pacific midnight the code paired
        # tomorrow's Eastern sunset with today's Pacific sunrise and read "day".
        # Boca's window ends 2026-10-16 ~23:37Z the day before and starts 10:04Z; LA's runs
        # ~13:20Z .. 02:20Z. Between LA's end and Boca's start nothing is open.
        for now in (utc(2026, 10, 16, 4, 0), utc(2026, 10, 16, 6, 59), utc(2026, 10, 16, 8, 0)):
            self.assertEqual(gc.window_state(now, [BOCA, self.LA]), "night", now.isoformat())
        # ...and it is day when either beach's window is open.
        self.assertEqual(gc.window_state(utc(2026, 10, 16, 1, 0), [BOCA, self.LA]), "day")  # LA's evening
        self.assertEqual(gc.window_state(utc(2026, 10, 16, 10, 30), [BOCA, self.LA]), "day")  # Boca's morning

    def test_dusk_is_the_twenty_minutes_after_any_windows_end(self):
        la_end = gc.beach_windows(self.LA, utc(2026, 10, 15, 20, 0))[1][1]
        self.assertEqual(gc.window_state(la_end + dt.timedelta(minutes=10), [self.LA]), "dusk")
        self.assertEqual(gc.window_state(la_end + dt.timedelta(minutes=25), [self.LA]), "night")
        self.assertEqual(gc.window_state(la_end + dt.timedelta(minutes=10), [BOCA, self.LA]), "dusk")

    def _day_hours(self, beaches, day):
        t0 = utc(day.year, day.month, day.day)
        return sum(5 for m in range(0, 1440, 5) if gc.window_state(t0 + dt.timedelta(minutes=m), beaches) == "day") / 60

    def test_total_daily_coverage_is_bounded(self):
        # One zone: a long June day plus the 2 h of margin stays under 17 h.
        self.assertLess(self._day_hours([BOCA], dt.date(2026, 6, 21)), 17)
        self.assertLess(self._day_hours([BOCA], dt.date(2026, 10, 15)), 15)
        # Boca + Los Angeles: the zones overlap, so the union is longer, but never ~24 h
        # (the cross-zone date mixing gave ~23 h on 2026-06-21) and the night gap survives.
        both = self._day_hours([BOCA, self.LA], dt.date(2026, 6, 21))
        self.assertLess(both, 20)
        self.assertGreater(24 - both, 4)

    def test_every_configured_beach_still_leaves_a_night(self):
        beaches = gc.load_beaches()
        for day in (dt.date(2026, 6, 21), dt.date(2026, 10, 16), dt.date(2026, 12, 21)):
            hours = self._day_hours(beaches, day)
            self.assertLess(hours, 22, f"{day}: {hours} h")
            self.assertGreater(24 - hours, 2, f"{day}: {hours} h")
        # The two dates the reviewer flagged are night at 04:00Z / 06:59Z on 2026-10-16.
        for t in (utc(2026, 10, 16, 4, 0), utc(2026, 10, 16, 6, 59)):
            self.assertEqual(gc.window_state(t, beaches), "night", t.isoformat())

    def test_beaches_outside_the_conus_sector_do_not_stretch_the_window(self):
        waikiki = {"slug": "waikiki", "lat": 21.28, "lon": -157.83, "timezone": "Pacific/Honolulu"}
        self.assertEqual(gc.beach_windows(waikiki, utc(2026, 10, 15, 15, 0)), [])
        now = utc(2026, 10, 15, 15, 0)
        self.assertEqual(gc.run_windows([BOCA, waikiki], now), gc.run_windows([BOCA], now))

    def test_overlapping_windows_merge(self):
        merged = gc.run_windows([BOCA, self.LA], utc(2026, 10, 15, 15, 0))
        for (_a, a_end), (b_start, _b) in zip(merged, merged[1:]):
            self.assertLess(a_end, b_start)

    def test_unknown_when_no_beach_gives_a_window(self):
        self.assertEqual(gc.run_windows([], utc(2026, 10, 15, 15, 0)), [])
        self.assertEqual(gc.window_state(utc(2026, 10, 15, 15, 0), []), "unknown")

    def test_the_configured_beaches_load_with_timezones(self):
        beaches = {b["slug"]: b for b in gc.load_beaches()}
        self.assertEqual(beaches["boca-raton"]["timezone"], "America/New_York")
        self.assertEqual(beaches["gulf-shores"]["timezone"], "America/Chicago")


class Cadence(unittest.TestCase):
    def test_fast_within_90_minutes_of_an_event_either_side_slow_otherwise(self):
        # Boca sunset 22:52:20Z, sunrise 11:19:37Z.
        cases = [
            (utc(2026, 10, 15, 21, 20), "slow"),  # 92 min before sunset: just outside the band
            (utc(2026, 10, 15, 21, 30), "fast"),  # 82 min before
            (utc(2026, 10, 15, 22, 52), "fast"),
            (utc(2026, 10, 16, 0, 15), "fast"),  # 83 min after
            (utc(2026, 10, 16, 0, 30), "slow"),  # 98 min after
            (utc(2026, 10, 15, 16, 0), "slow"),  # midday
            (utc(2026, 10, 15, 11, 0), "fast"),
            (utc(2026, 10, 15, 9, 40), "slow"),
        ]
        for now, want in cases:
            self.assertEqual(gc.cadence_state(now, [BOCA]), want, now.isoformat())

    def test_any_beach_in_any_zone_makes_it_fast(self):
        la = {"slug": "santa-monica", "lat": 34.01, "lon": -118.5, "timezone": "America/Los_Angeles"}
        # 00:40Z on the 16th is 5:40 PM PDT: Los Angeles is ~20 min before sunset, Boca is in the dark.
        self.assertEqual(gc.cadence_state(utc(2026, 10, 16, 0, 40), [BOCA, la]), "fast")
        self.assertEqual(gc.cadence_state(utc(2026, 10, 16, 0, 40), [BOCA]), "slow")

    def test_beaches_outside_the_conus_sector_are_ignored(self):
        waikiki = {"slug": "waikiki", "lat": 21.28, "lon": -157.83, "timezone": "Pacific/Honolulu"}
        self.assertEqual(gc.cadence_state(utc(2026, 10, 16, 3, 50), [waikiki]), "slow")


class ScanPairing(unittest.TestCase):
    def test_newest_scan_present_in_both_products(self):
        t = lambda m: utc(2026, 10, 15, 20, m)  # noqa: E731
        masks = {t(41): "m41", t(46): "m46", t(51): "m51"}
        heights = {t(41): "h41", t(46): "h46"}  # the newest mask has no height yet
        self.assertEqual(gc.newest_common_scan(masks, heights), (t(46), "m46", "h46"))
        self.assertIsNone(gc.newest_common_scan(masks, {}))


if __name__ == "__main__":
    unittest.main()
