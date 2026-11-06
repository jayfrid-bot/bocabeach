"""Unit tests for scripts/sun_cam_rescore.py. Run from the repo root:

    python3 -m unittest scripts/sun_cam_rescore_test.py -v

No network: the upload and the token are replaced, and frames are empty files with
scores given per file name.
"""

import json
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sun_cam_check as sc  # noqa: E402
import sun_cam_rescore as rs  # noqa: E402

try:
    import PIL  # noqa: F401
except ImportError:  # pragma: no cover
    PIL = None

EVENT = datetime(2026, 10, 6, 11, 15, tzinfo=timezone.utc)
CURRENT = rs.version_key(sc.SUN_CAM_SCORE_VERSION)


def result_with_series(minutes):
    return {"observed_score": 50.0, "series": [{"t": sc.iso_z(EVENT + timedelta(minutes=m))} for m in minutes]}


class ScoredAtTests(unittest.TestCase):
    def test_one_second_after_the_last_series_frame(self):
        got = rs.rescore_scored_at(result_with_series([-35, -10, 0, 25]), EVENT)
        self.assertEqual(got, EVENT + timedelta(minutes=25, seconds=1))

    def test_never_before_the_event(self):
        # The route refuses a scored_at before the event, even when every frame is earlier.
        got = rs.rescore_scored_at(result_with_series([-35, -30]), EVENT)
        self.assertEqual(got, EVENT + timedelta(seconds=1))

    def test_series_order_does_not_matter(self):
        got = rs.rescore_scored_at(result_with_series([25, -35, 0]), EVENT)
        self.assertEqual(got, EVENT + timedelta(minutes=25, seconds=1))


class SkipReasonTests(unittest.TestCase):
    new = {"observed_score": 61.0}
    same = {"observed_score": 61.0}
    moved = {"observed_score": 40.0}
    old_row = {"score": 61.0, "score_version": "2026-10-15.1"}

    def test_changed_only_skips_an_unchanged_event_that_has_a_stored_row(self):
        self.assertEqual(rs.skip_reason(self.old_row, CURRENT, self.new, self.same, True, {}), "the new rules change nothing")

    def test_changed_only_uploads_an_event_with_no_stored_row_at_all(self):
        self.assertIsNone(rs.skip_reason(None, CURRENT, self.new, self.same, True, {}))

    def test_changed_only_uploads_a_changed_event(self):
        self.assertIsNone(rs.skip_reason(self.old_row, CURRENT, self.new, self.moved, True, {}))

    def test_all_uploads_an_unchanged_event(self):
        self.assertIsNone(rs.skip_reason(self.old_row, CURRENT, self.new, self.same, False, {}))

    def test_a_row_already_at_this_version_is_never_uploaded(self):
        row = {"score": 61.0, "score_version": sc.SUN_CAM_SCORE_VERSION}
        self.assertEqual(rs.skip_reason(row, CURRENT, self.new, self.moved, False, {}), "already at this score version")

    def test_an_incomplete_result_is_never_uploaded(self):
        got = rs.skip_reason(None, CURRENT, None, self.same, True, {"reason": "too few frames"})
        self.assertEqual(got, "incomplete under the new rules: too few frames")


class ArgsTests(unittest.TestCase):
    def test_changed_only_is_the_default(self):
        self.assertTrue(rs.parse_args([]).changed_only)
        self.assertTrue(rs.parse_args(["--changed-only"]).changed_only)

    def test_all_opts_out(self):
        self.assertFalse(rs.parse_args(["--all"]).changed_only)

    def test_the_two_flags_exclude_each_other(self):
        import contextlib
        import io

        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            rs.parse_args(["--all", "--changed-only"])


@unittest.skipIf(PIL is None, "Pillow missing")
class MainRunTests(unittest.TestCase):
    """One saved sunrise on ftl-elbo-beach-cam (one beach: fort-lauderdale), run through main()."""

    CAM = "ftl-elbo-beach-cam"
    DAY = date(2026, 10, 6)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.frames_root = root / "frames"
        cam = next(c for c in sc.load_config()["cams"] if c["id"] == self.CAM)
        self.event = sc.sun_times(cam["lat"], cam["lon"], self.DAY)["sunrise"]
        d = self.frames_root / self.DAY.isoformat() / "sunrise" / self.CAM
        d.mkdir(parents=True)
        self.scores = {}
        for t in sc.sample_times(self.event):
            name = sc.frame_name(t)
            (d / name).write_bytes(b"x")
            minutes = (t - self.event).total_seconds() / 60.0
            self.scores[name] = 80.0 if abs(minutes + 5) < 1.3 or abs(minutes + 7.5) < 1.3 else 20.0
        self.last_frame = max(sc.sample_times(self.event))
        self.stored_path = root / "stored.json"
        self.posts = []
        self.saved = (sc.score_file, sc.post_observation, sc.read_token)
        sc.score_file = lambda path, regions: {
            "valid_frac": 0.9, "warm_frac": 0.1, "colorfulness": 40.0, "warm_sat": 0.4, "sky_median_v": 0.6,
            "score": self.scores[Path(path).name],
        }
        sc.post_observation = lambda payload, token: (self.posts.append(payload) or True, "ok")
        sc.read_token = lambda: "test-token"

    def tearDown(self):
        sc.score_file, sc.post_observation, sc.read_token = self.saved
        self.tmp.cleanup()

    def run_main(self, stored_rows, *extra):
        self.stored_path.write_text(json.dumps(stored_rows), encoding="utf-8")
        argv = ["--frames-root", str(self.frames_root), "--stored", str(self.stored_path), "--cams", self.CAM, "--events", "sunrise", *extra]
        import contextlib
        import io

        with contextlib.redirect_stdout(io.StringIO()):
            return rs.main(argv)

    def stored(self, version):
        return [{"slug": "fort-lauderdale", "event_kind": "sunrise", "event_date_local": self.DAY.isoformat(),
                 "cam_id": self.CAM, "observed_score": 80.0, "score_version": version}]

    def test_an_unchanged_event_with_an_old_stored_row_is_not_uploaded_by_default(self):
        self.assertEqual(self.run_main(self.stored("2026-10-15.1")), 0)
        self.assertEqual(self.posts, [])

    def test_an_event_with_no_stored_row_is_uploaded_with_the_earliest_legal_scored_at(self):
        self.assertEqual(self.run_main([]), 0)
        self.assertEqual(len(self.posts), 1)
        p = self.posts[0]
        self.assertEqual(p["slug"], "fort-lauderdale")
        self.assertEqual(p["score_version"], sc.SUN_CAM_SCORE_VERSION)
        scored = sc.parse_iso(p["scored_at"])
        last = max(sc.parse_iso(f["t"]) for f in p["series"])
        # The route's rules: not before the event, not before the last series frame.
        self.assertGreaterEqual(scored, self.event)
        self.assertGreaterEqual(scored, last)
        self.assertEqual(scored, last + timedelta(seconds=1))
        # Long before any run of this tool: a live row of the same version, scored after capture, wins.
        self.assertLess(scored, datetime.now(timezone.utc) - timedelta(days=1))

    def test_all_uploads_the_unchanged_event_too(self):
        self.assertEqual(self.run_main(self.stored("2026-10-15.1"), "--all"), 0)
        self.assertEqual(len(self.posts), 1)

    def test_a_row_at_the_current_version_is_kept_even_with_all(self):
        self.assertEqual(self.run_main(self.stored(sc.SUN_CAM_SCORE_VERSION), "--all"), 0)
        self.assertEqual(self.posts, [])


if __name__ == "__main__":
    unittest.main()
