"""Unit tests for the webcam-archive half of scripts/cam_seaweed.py. Run from
the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

No network, no ffmpeg, no vision providers: every outside call is patched.
"""

import base64
import contextlib
import datetime as dt
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cam_seaweed as cs  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "config" / "archive-cams.json"

# The eleven cams the owner chose to archive (2026-10-11).
EXPECTED_IDS = {
    "boca-inlet", "boca-inlet-jetty", "boca-inlet-north", "boca-inlet-surf",
    "boca-south", "boca-south-surf", "deerfield-beach-cam", "deerfield-pier-cam",
    "deerfield-spinner-uw", "deerfield-surf-cam", "ftl-elbo-beach-cam",
}


def jpeg(size=20_000):
    return b"\xff\xd8\xff\xe0" + b"\x00" * (size - 6) + b"\xff\xd9"


def iso_ago(minutes):
    t = dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=minutes)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload if isinstance(payload, bytes) else json.dumps(payload).encode()

    def read(self, n=-1):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@contextlib.contextmanager
def env(**kw):
    """Set (or with None, remove) env vars for a block."""
    old = {k: os.environ.get(k) for k in kw}
    try:
        for k, v in kw.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class WithManifest(unittest.TestCase):
    """Points the script at the real manifest and replaces the pre-check GET.

    self.filled_by_slug[slug] = {slot ISO: {cam ids}} is what the pre-check
    answers for that beach ({} by default = nothing filled); None makes it fail.
    self.golden_by_slug[slug] = [(start, end), ...] are the golden-hour windows
    it reports for the beach (none by default).
    self.filled_calls records every beach asked about."""

    def setUp(self):
        self.filled_by_slug = {}
        self.golden_by_slug = {}
        self.filled_calls = []

        def fake_filled(slug):
            self.filled_calls.append(slug)
            slots = self.filled_by_slug.get(slug, {})
            if slots is None:
                return None
            return {"slots": slots, "current": None, "golden": self.golden_by_slug.get(slug, [])}

        # The low-sun gate (LOW_SUN_DEG) reads the sun at the REAL clock these tests
        # score frames at; -90 turns it off so no test depends on the time of day.
        # LowSunGateTests below turn it back on with fixed instants.
        for p in (mock.patch.object(cs, "ARCHIVE_CAMS_PATH", str(MANIFEST_PATH)),
                  mock.patch.object(cs, "LOW_SUN_DEG", -90.0),
                  mock.patch.object(cs, "fetch_filled_slots", fake_filled)):
            p.start()
            self.addCleanup(p.stop)

    def fill(self, slug, cam_ids, frame_at=None):
        """Mark cams as already filled for the slot `frame_at` (default: this hour) falls in."""
        self.filled_by_slug.setdefault(slug, {}).setdefault(cs._slot_utc_of(frame_at), set()).update(cam_ids)


class ArchiveSetTests(WithManifest):
    def test_archive_set_is_exactly_the_eleven_configured_cams(self):
        ids = [c["id"] for c in cs.load_archive_cams()]
        self.assertEqual(set(ids), EXPECTED_IDS)
        self.assertEqual(len(ids), 11)
        self.assertEqual(len(set(ids)), 11, "no cam listed twice")

    def test_archive_set_matches_config_locations_ts(self):
        # Cam ids are the only `id:` keys in locations.ts. The TypeScript test
        # (lib/camFrames/manifest.test.ts) checks the full file; this one proves
        # the Python side reads the same eleven.
        text = (ROOT / "config" / "locations.ts").read_text(encoding="utf-8")
        ts_ids = set(re.findall(r'^\s+id: "([a-z0-9-]+)",', text, flags=re.M))
        self.assertEqual(ts_ids, EXPECTED_IDS)
        self.assertEqual({c["id"] for c in cs.load_archive_cams()}, ts_ids)

    def test_every_entry_has_what_fetch_still_needs(self):
        for c in cs.load_archive_cams():
            src = c["source"]
            if src["kind"] == "feed":
                self.assertTrue(src["base"].startswith("http") and src["view"])
            else:
                self.assertEqual(src["kind"], "direct")
                self.assertTrue(src["url"].startswith("https://"))
                self.assertTrue(src["meta"].startswith("https://"))

    def test_the_vision_loop_misses_four_of_them(self):
        registry = json.loads((ROOT / "config" / "vision-cams.json").read_text(encoding="utf-8"))
        vision = {c["id"] for e in registry.values() for c in e["cams"]}
        self.assertEqual(
            EXPECTED_IDS - vision,
            {"boca-inlet", "boca-inlet-north", "boca-inlet-jetty", "deerfield-spinner-uw"},
        )

    def test_spinner_constants_name_a_manifest_cam(self):
        self.assertIn((cs.UW_ARCHIVE_SLUG, cs.UW_ARCHIVE_CAM_ID), cs.archive_keys())

    def test_missing_or_broken_manifest_is_empty_not_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            bad = Path(d) / "bad.json"
            bad.write_text("{not json", encoding="utf-8")
            for path in (str(Path(d) / "nope.json"), str(bad)):
                with mock.patch.object(cs, "ARCHIVE_CAMS_PATH", path), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(cs.load_archive_cams(), [])


class ArchiveFrameTests(unittest.TestCase):
    def post(self, img=None, frame_at=None, token="tok-unit", urlopen=None, **kw):
        urlopen = urlopen or mock.Mock(return_value=FakeResponse({"stored": True}))
        with env(INGEST_TOKEN=token), mock.patch.object(cs.urllib.request, "urlopen", urlopen), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            status = cs.archive_frame("boca-raton", "boca-south", jpeg() if img is None else img, frame_at, **kw)
        return status, urlopen

    def test_no_token_means_silence_and_no_network(self):
        out, err = io.StringIO(), io.StringIO()
        urlopen = mock.Mock()
        with env(INGEST_TOKEN=None), mock.patch.object(cs.urllib.request, "urlopen", urlopen), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            status = cs.archive_frame("boca-raton", "boca-south", jpeg())
        self.assertEqual(status, "no-token")
        urlopen.assert_not_called()
        self.assertEqual(out.getvalue() + err.getvalue(), "", "must skip silently")

    def test_blank_token_counts_as_unset(self):
        status, urlopen = self.post(token="   ")
        self.assertEqual(status, "no-token")
        urlopen.assert_not_called()

    def test_posts_the_raw_jpeg_with_bearer_auth_and_a_15s_timeout(self):
        img = jpeg(30_000)
        status, urlopen = self.post(img=img, frame_at=iso_ago(5))
        self.assertEqual(status, "stored")
        (req,), kwargs = urlopen.call_args
        self.assertEqual(kwargs["timeout"], 15)
        self.assertEqual(req.get_method(), "POST")
        self.assertEqual(req.data, img)
        self.assertEqual(req.get_header("Authorization"), "Bearer tok-unit")
        self.assertEqual(req.get_header("Content-type"), "image/jpeg")
        self.assertTrue(req.full_url.startswith("https://app.isitbeachday.com/api/cam-frames?"))
        self.assertIn("slug=boca-raton", req.full_url)
        self.assertIn("cam=boca-south", req.full_url)
        self.assertIn("frameAt=", req.full_url)

    def test_omits_frameat_when_unknown(self):
        _, urlopen = self.post(frame_at=None)
        (req,), _ = urlopen.call_args
        self.assertNotIn("frameAt", req.full_url)

    def test_default_url_and_override(self):
        self.assertEqual(cs.ARCHIVE_URL, os.environ.get("ARCHIVE_URL", "https://app.isitbeachday.com/api/cam-frames"))
        with mock.patch.object(cs, "ARCHIVE_URL", "http://localhost:3000/api/cam-frames"):
            _, urlopen = self.post()
        (req,), _ = urlopen.call_args
        self.assertTrue(req.full_url.startswith("http://localhost:3000/api/cam-frames?slug="))

    def test_never_prints_the_token(self):
        out, err = io.StringIO(), io.StringIO()
        urlopen = mock.Mock(side_effect=urllib.error.HTTPError("u", 401, "no", {}, io.BytesIO(b"tok-unit")))
        with env(INGEST_TOKEN="tok-unit"), mock.patch.object(cs.urllib.request, "urlopen", urlopen), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            cs.archive_frame("boca-raton", "boca-south", jpeg())
        self.assertNotIn("tok-unit", out.getvalue() + err.getvalue())

    def test_server_answers_map_to_short_statuses(self):
        for answer, want in [
            ({"stored": True, "key": "k"}, "stored"),
            ({"stored": False, "reason": "slot-taken"}, "slot-taken"),
            ({"stored": False, "reason": "unchanged"}, "unchanged"),
            ({"stored": False}, "not-stored"),
        ]:
            status, _ = self.post(urlopen=mock.Mock(return_value=FakeResponse(answer)))
            self.assertEqual(status, want)

    def test_best_effort_every_failure_is_swallowed(self):
        failures = [
            urllib.error.HTTPError("u", 401, "unauthorized", {}, io.BytesIO(b"{}")),
            urllib.error.HTTPError("u", 403, "disabled", {}, io.BytesIO(b"{}")),
            urllib.error.HTTPError("u", 503, "down", {}, io.BytesIO(b"{}")),
            urllib.error.URLError("no route"),
            TimeoutError("timed out"),
            ConnectionResetError("reset"),
            OSError("boom"),
            ValueError("weird"),
        ]
        for exc in failures:
            status, _ = self.post(urlopen=mock.Mock(side_effect=exc))
            self.assertIn(status.split("-")[0], ("http", "error"), exc)

    def test_http_errors_report_the_code(self):
        exc = urllib.error.HTTPError("u", 404, "nf", {}, io.BytesIO(b"{}"))
        status, _ = self.post(urlopen=mock.Mock(side_effect=exc))
        self.assertEqual(status, "http-404")

    def test_unreadable_reply_is_an_error_not_a_crash(self):
        status, _ = self.post(urlopen=mock.Mock(return_value=FakeResponse(b"<html>not json</html>")))
        self.assertEqual(status, "error")

    def test_skips_without_sending_what_the_server_would_refuse(self):
        for img in [b"", b"<html>" * 5000, b"\x89PNG" + b"\x00" * 20_000, jpeg(100), jpeg(cs.ARCHIVE_MAX_BYTES + 1), None, "text"]:
            status, urlopen = self.post(img=img if img is not None else b"")
            self.assertEqual(status, "skipped", repr(img)[:30])
            urlopen.assert_not_called()

    def test_accepts_the_size_bounds_exactly(self):
        for size in (cs.ARCHIVE_MIN_BYTES, cs.ARCHIVE_MAX_BYTES):
            status, urlopen = self.post(img=jpeg(size))
            self.assertEqual(status, "stored")
            urlopen.assert_called_once()

    def test_skips_a_frame_whose_own_time_is_too_old_but_sends_a_fresh_or_unknown_one(self):
        status, urlopen = self.post(frame_at=iso_ago(cs.ARCHIVE_FRAME_MAX_AGE_MIN + 10))
        self.assertEqual(status, "skipped")
        urlopen.assert_not_called()
        status, _ = self.post(frame_at=iso_ago(30))
        self.assertEqual(status, "stored")
        status, _ = self.post(frame_at="garbage-time")  # the server decides about an unreadable time
        self.assertEqual(status, "stored")


class FetchStillTests(unittest.TestCase):
    FEED = {"s4": {"mr": "pics/s4/a_.jpg", "hr": "pics/s4/a.jpg", "timestamp": 1791667472},
            "s8": {"mr": "pics/s8/b_.jpg", "timestamp": 1791666925}}

    def fake_get(self, calls):
        def _get(url, timeout=25):
            calls.append(url)
            if url.endswith("latest.json"):
                return json.dumps(self.FEED).encode()
            return b"IMG:" + url.encode()
        return _get

    def test_feed_cam_reports_the_latest_json_timestamp_as_frameat(self):
        calls, info = [], {}
        cam = {"id": "boca-south", "source": {"kind": "feed", "base": "http://x/boca", "view": "s4"}}
        with mock.patch.object(cs, "_get", self.fake_get(calls)):
            img = cs.fetch_still(cam, info)
        self.assertEqual(img, b"IMG:http://x/boca/pics/s4/a_.jpg")
        self.assertEqual(info["frameAt"], "2026-10-10T21:24:32Z")

    def test_old_call_style_still_works(self):
        cam = {"id": "x", "source": {"kind": "feed", "base": "http://x/boca", "view": "s4"}}
        with mock.patch.object(cs, "_get", self.fake_get([])):
            self.assertEqual(cs.fetch_still(cam), b"IMG:http://x/boca/pics/s4/a_.jpg")

    def test_direct_cam_leaves_frameat_to_its_meta(self):
        info = {}
        cam = {"id": "d", "source": {"kind": "direct", "url": "https://u/frame?cam=d"}}
        with mock.patch.object(cs, "_get", self.fake_get([])):
            cs.fetch_still(cam, info)
        self.assertNotIn("frameAt", info)

    def test_missing_timestamp_gives_none_not_an_error(self):
        info = {}
        feed = {"s4": {"mr": "p.jpg"}}
        cam = {"id": "x", "source": {"kind": "feed", "base": "http://x/b", "view": "s4"}}
        with mock.patch.object(cs, "_get", lambda url, timeout=25: json.dumps(feed).encode() if url.endswith("json") else b"i"):
            cs.fetch_still(cam, info)
        self.assertIsNone(info["frameAt"])

    def test_cams_on_one_feed_share_one_latest_json_download(self):
        calls, cache = [], {}
        with mock.patch.object(cs, "_get", self.fake_get(calls)):
            for view in ("s4", "s8"):
                cs.fetch_still({"id": view, "source": {"kind": "feed", "base": "http://x/boca", "view": view}}, {}, cache)
        self.assertEqual(sum(1 for u in calls if u.endswith("latest.json")), 1)

    def test_unix_conversion(self):
        self.assertEqual(cs._iso_utc_from_unix(0), None)
        self.assertEqual(cs._iso_utc_from_unix(None), None)
        self.assertEqual(cs._iso_utc_from_unix(True), None)
        self.assertEqual(cs._iso_utc_from_unix("1791667472"), None)
        self.assertEqual(cs._iso_utc_from_unix(1791667472000), "2026-10-10T21:24:32Z")  # milliseconds


class CaptureBeachTests(WithManifest):
    """capture_beach: fetch_still -> archive_frame -> assess, in that order."""

    FEED_CAM = {"id": "boca-south", "name": "South", "source": {"kind": "feed", "base": "http://x", "view": "s4"}}
    COURIER_CAM = {"id": "ftl-elbo-beach-cam", "name": "Elbo",
                   "source": {"kind": "direct", "url": "https://u/frame", "meta": "https://u/meta"}}

    def run_capture(self, slug, cams, *, assess=None, frame_at_info="fresh", meta=None, token="tok", attempted=None, archive=None, gap_state=None, prev=None):
        order = []
        self.out = io.StringIO()
        self.err = io.StringIO()
        self.sleeps = []
        if frame_at_info == "fresh":  # the default: a live feed frame. Pass None for "no timestamp".
            frame_at_info = iso_ago(2)

        def fake_fetch(cam, info=None, feed_cache=None):
            order.append("fetch")
            if info is not None and frame_at_info:
                info["frameAt"] = frame_at_info
            return jpeg()

        def fake_archive(s, c, img, frame_at=None):
            order.append(("archive", s, c, frame_at))
            return "stored"

        def fake_assess(img):
            order.append("assess")
            return {"level": "none", "coveragePct": 0, "crowd": "quiet", "crowdPct": 5, "people": 2, "provider": "t"}

        now = dt.datetime.now(ZONE)
        patches = [
            mock.patch.object(cs, "fetch_still", fake_fetch),
            mock.patch.object(cs, "archive_frame", fake_archive),
            mock.patch.object(cs, "assess", assess or fake_assess),
            mock.patch.object(cs, "_get", lambda url, timeout=25: json.dumps(meta or {}).encode()),
            mock.patch.object(cs.time, "sleep", lambda s: self.sleeps.append(s)),
        ]
        with env(INGEST_TOKEN=token), contextlib.ExitStack() as st, \
                contextlib.redirect_stdout(self.out), contextlib.redirect_stderr(self.err):
            for p in patches:
                st.enter_context(p)
            result = cs.capture_beach(slug, cams, now, gap_state if gap_state is not None else {"called": False}, prev or {}, attempted, archive)
        return result, order

    def test_order_is_fetch_then_assess_then_the_upload(self):
        # The read never waits for the upload: the still is queued and uploaded
        # after the beach's reads.
        result, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(5))
        self.assertEqual(order[:2], ["fetch", "assess"])
        self.assertEqual(order[2][:3], ("archive", "boca-raton", "boca-south"))
        self.assertEqual(len(order), 3)
        self.assertEqual(len(result["cams"]), 1)

    def test_a_frame_clef_calls_unreadable_is_skipped_and_records_no_frame_sha(self):
        def assess(img):
            raise cs.UnreadableFrame("unreadable per clef (p=0.97)")

        dark_cam = dict(self.FEED_CAM, id="boca-south")
        ok_cam = dict(self.FEED_CAM, id="boca-south-surf")
        calls = []

        def mixed(img):
            calls.append(1)
            if len(calls) == 1:
                return assess(img)
            return {"level": "none", "coveragePct": 0, "crowd": "quiet", "crowdPct": 5, "people": 2, "provider": "t"}

        result, order = self.run_capture("boca-raton", [dark_cam, ok_cam], frame_at_info=iso_ago(5), assess=mixed)
        self.assertIn("boca-south: skipped (unreadable per clef)", self.out.getvalue())
        self.assertNotIn("warn", self.err.getvalue())
        ids = [c["id"] for c in result["cams"]]
        self.assertEqual(ids, ["boca-south-surf"], "the dark cam has no reading")
        shas = {c["id"]: c.get("frameSha") for c in result["cams"]}
        self.assertTrue(shas["boca-south-surf"])
        self.assertNotIn("boca-south", shas)
        # Both stills are still archived: the archive keeps its own rules.
        self.assertEqual(sum(1 for o in order if isinstance(o, tuple)), 2)

    def test_when_every_cam_is_unreadable_the_beach_gets_no_new_capture(self):
        def assess(img):
            raise cs.UnreadableFrame("dark")

        result, _ = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(5), assess=assess)
        self.assertIsNone(result)
        self.assertIn("skipped (unreadable per clef)", self.out.getvalue())

    def test_a_later_readable_frame_of_the_skipped_cam_is_read(self):
        # The dark frame recorded no sha, so the same cam's next frame is not "already scored".
        prev = {"frameShas": {"boca-south": "oldsha"}}

        def dark(img):
            raise cs.UnreadableFrame("dark")

        self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(5), assess=dark, prev=prev)
        result, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(5), prev=prev)
        self.assertIn("assess", order)
        self.assertEqual([c["id"] for c in result["cams"]], ["boca-south"])

    def test_every_read_finishes_before_any_upload_starts(self):
        cams = [dict(self.FEED_CAM, id=i) for i in ("boca-south", "boca-south-surf", "boca-inlet-surf")]
        _, order = self.run_capture("boca-raton", cams, frame_at_info=iso_ago(5))
        kinds = ["archive" if isinstance(o, tuple) else o for o in order]
        self.assertEqual(kinds, ["fetch", "assess"] * 3 + ["archive"] * 3)

    def test_a_slow_upload_does_not_delay_the_read(self):
        started = {}

        def slow_archive(s, c, img, frame_at=None):
            started["t"] = time.monotonic()
            threading.Event().wait(0.4)  # not time.sleep: other tests patch that
            return "stored"

        reads = []
        with env(INGEST_TOKEN="tok"), mock.patch.object(cs, "fetch_still", lambda cam, info=None, feed_cache=None: (info.update(frameAt=iso_ago(2)), jpeg())[1]), \
                mock.patch.object(cs, "archive_frame", slow_archive), \
                mock.patch.object(cs, "assess", lambda img: reads.append(time.monotonic()) or {"level": "none", "provider": "t"}), \
                mock.patch.object(cs.time, "sleep", lambda s: None), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            cs.capture_beach("boca-raton", [self.FEED_CAM], dt.datetime.now(ZONE), {"called": False}, {})
        self.assertEqual(len(reads), 1)
        self.assertLessEqual(reads[0], started["t"])  # the read ran before the upload began

    def test_cams_whose_hour_is_already_filled_are_read_but_not_uploaded(self):
        run = cs.ArchiveRun()
        run.filled = {"boca-raton": {"slots": {cs._slot_utc_of(None): {"boca-south"}}, "golden": []}}
        with env(INGEST_TOKEN="tok"):
            result, order = self.run_capture("boca-raton", [self.FEED_CAM], archive=run)
        self.assertEqual(order, ["fetch", "assess"])
        self.assertEqual(len(result["cams"]), 1)

    def test_a_filled_slot_is_judged_by_the_frames_own_hour(self):
        # The cam's CURRENT hour is filled, but this frame is from the hour before: still uploaded.
        run = cs.ArchiveRun()
        old = iso_ago(70)
        run.filled = {"boca-raton": {"slots": {cs._slot_utc_of(None): {"boca-south"}}, "golden": []}}
        _, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=old, archive=run)
        if cs._slot_utc_of(old) != cs._slot_utc_of(None):
            self.assertEqual(sum(1 for o in order if isinstance(o, tuple)), 1)

    def test_feed_timestamp_is_what_gets_archived(self):
        stamp = iso_ago(5)
        _, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=stamp)
        self.assertEqual(order[2][3], stamp)

    def test_courier_cam_archives_with_its_meta_grabbed_time(self):
        grabbed = iso_ago(20)
        result, order = self.run_capture(
            "fort-lauderdale", [self.COURIER_CAM], meta={"ok": True, "grabbedAtUtc": grabbed})
        self.assertEqual(order, ["fetch", "assess", ("archive", "fort-lauderdale", "ftl-elbo-beach-cam", grabbed)])
        self.assertEqual(result["cams"][0]["frameAt"], grabbed)

    def test_the_frame_is_archived_even_when_the_vision_read_fails(self):
        def boom(img):
            raise RuntimeError("all vision providers failed")
        result, order = self.run_capture("boca-raton", [self.FEED_CAM], assess=boom)
        self.assertIsNone(result)
        self.assertEqual([o for o in order if o != "fetch"][0][0], "archive")

    def test_cams_the_vision_loop_fetches_are_marked_attempted(self):
        attempted = set()
        self.run_capture("boca-raton", [self.FEED_CAM], attempted=attempted)
        self.assertEqual(attempted, {("boca-raton", "boca-south")})

    def test_a_failed_fetch_is_still_marked_attempted(self):
        attempted = set()
        with env(INGEST_TOKEN="tok"), mock.patch.object(cs, "fetch_still", side_effect=RuntimeError("down")), \
                mock.patch.object(cs.time, "sleep", lambda s: None), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = cs.capture_beach("boca-raton", [self.FEED_CAM], dt.datetime.now(ZONE), {"called": False}, {}, attempted)
        self.assertIsNone(result)
        self.assertEqual(attempted, {("boca-raton", "boca-south")})

    def test_a_cam_that_is_not_in_the_archive_is_read_but_not_archived(self):
        stray = {"id": "stray-cam", "name": "Stray", "source": {"kind": "feed", "base": "http://x", "view": "s1"}}
        result, order = self.run_capture("boca-raton", [stray])
        self.assertEqual(order, ["fetch", "assess"])
        self.assertEqual(len(result["cams"]), 1)

    def test_no_token_means_no_archive_call_but_the_read_is_unchanged(self):
        # archive_frame is patched here, so prove the gate sits BEFORE it.
        result, order = self.run_capture("boca-raton", [self.FEED_CAM], token=None)
        self.assertEqual(order, ["fetch", "assess"])
        self.assertEqual(len(result["cams"]), 1)

    def test_skipped_courier_cam_is_neither_fetched_nor_marked_attempted(self):
        attempted = set()
        stale = {"ok": True, "grabbedAtUtc": iso_ago(cs.DIRECT_FRAME_MAX_AGE_MIN + 30)}
        result, order = self.run_capture("fort-lauderdale", [self.COURIER_CAM], meta=stale, attempted=attempted)
        self.assertIsNone(result)
        self.assertEqual(order, [])
        self.assertEqual(attempted, set(), "archive_pass gets to look at it")


class CaptureUwTests(WithManifest):
    def run_uw(self, assess_raises=False, token="tok"):
        archived, attempted = [], set()
        grabbed = iso_ago(10)

        def fake_archive(s, c, img, frame_at=None):
            archived.append((s, c, frame_at))
            return "stored"

        def fake_assess(img, *a, **k):
            if assess_raises:
                raise RuntimeError("no providers")
            return {"level": "clear", "pct": 80, "note": "n", "provider": "t"}

        with env(INGEST_TOKEN=token), \
                mock.patch.object(cs, "fetch_uw_frame_timed", lambda: (jpeg(), grabbed)), \
                mock.patch.object(cs, "archive_frame", fake_archive), \
                mock.patch.object(cs, "assess_uw", fake_assess), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            out = cs.capture_uw(dt.datetime.now(ZONE), attempted)
        return out, archived, attempted, grabbed

    def test_spinner_is_archived_on_its_own_fetch_path(self):
        out, archived, attempted, grabbed = self.run_uw()
        self.assertEqual(archived, [("deerfield-beach", "deerfield-spinner-uw", grabbed)])
        self.assertEqual(attempted, {("deerfield-beach", "deerfield-spinner-uw")})
        self.assertEqual(out["level"], "clear")

    def test_an_unreadable_spinner_frame_gives_no_reading_and_is_still_archived(self):
        archived = []
        out = io.StringIO()

        def dark(img, *a, **k):
            raise cs.UnreadableFrame("dark")

        with env(INGEST_TOKEN="tok"), \
                mock.patch.object(cs, "fetch_uw_frame_timed", lambda: (jpeg(), iso_ago(10))), \
                mock.patch.object(cs, "archive_frame", lambda s, c, img, frame_at=None: archived.append(c) or "stored"), \
                mock.patch.object(cs, "assess_uw", dark), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(cs.capture_uw(dt.datetime.now(ZONE), set()))
        self.assertIn("skipped (unreadable per clef)", out.getvalue())
        self.assertEqual(archived, ["deerfield-spinner-uw"])

    def test_spinner_is_archived_even_when_the_read_fails(self):
        out, archived, _, _ = self.run_uw(assess_raises=True)
        self.assertIsNone(out)
        self.assertEqual(len(archived), 1)

    def test_fetch_uw_frame_timed_returns_the_courier_time(self):
        grabbed = iso_ago(5)

        def fake_get(url, timeout=25):
            return json.dumps({"ok": True, "grabbedAtUtc": grabbed}).encode() if url.endswith("/meta") else jpeg()

        with mock.patch.object(cs, "_get", fake_get), contextlib.redirect_stdout(io.StringIO()):
            frame, frame_at = cs.fetch_uw_frame_timed()
            self.assertEqual(cs.fetch_uw_frame(), frame)
        self.assertEqual(frame_at, grabbed)
        self.assertEqual(frame[:3], b"\xff\xd8\xff")


class ArchivePassBase(WithManifest):
    def run_pass(self, attempted, token="tok", meta_by_url=None, fail_ids=()):
        fetched, archived = [], []
        meta_by_url = meta_by_url or {}

        def fake_fetch(cam, info=None, feed_cache=None):
            if cam["id"] in fail_ids:
                raise RuntimeError("cam down")
            fetched.append(cam["id"])
            if info is not None and cam["source"]["kind"] == "feed":
                info["frameAt"] = "2026-10-11T14:05:09Z"
            return jpeg()

        def fake_archive(s, c, img, frame_at=None):
            archived.append((c, frame_at))
            return "stored"

        def fake_get(url, timeout=25):
            m = meta_by_url.get(url, {"ok": True, "grabbedAtUtc": iso_ago(15)})
            if m is None:
                raise RuntimeError("meta down")
            return json.dumps(m).encode()

        with env(INGEST_TOKEN=token), mock.patch.object(cs, "fetch_still", fake_fetch), \
                mock.patch.object(cs, "archive_frame", fake_archive), mock.patch.object(cs, "_get", fake_get), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            out = cs.archive_pass(attempted)
        return out, fetched, archived


class ArchivePassTests(ArchivePassBase):
    def test_with_nothing_attempted_it_covers_all_eleven_cams(self):
        out, fetched, archived = self.run_pass(set())
        self.assertEqual(set(fetched), EXPECTED_IDS)
        self.assertEqual(len(fetched), 11)
        self.assertEqual({c for c, _ in archived}, EXPECTED_IDS)
        self.assertEqual(out["attempted"], 11)

    def test_it_fetches_only_cams_the_vision_loop_did_not(self):
        registry = json.loads((ROOT / "config" / "vision-cams.json").read_text(encoding="utf-8"))
        attempted = {(slug, c["id"]) for slug, e in registry.items() for c in e["cams"]}
        self.assertEqual(len(attempted), 7)
        out, fetched, _ = self.run_pass(set(attempted))
        self.assertEqual(set(fetched), {"boca-inlet", "boca-inlet-north", "boca-inlet-jetty", "deerfield-spinner-uw"})
        self.assertEqual(out["attempted"], 4)

    def test_spinner_already_fetched_by_the_underwater_path_is_not_fetched_again(self):
        attempted = {("deerfield-beach", "deerfield-spinner-uw")}
        _, fetched, _ = self.run_pass(attempted)
        self.assertNotIn("deerfield-spinner-uw", fetched)
        self.assertEqual(len(fetched), 10)

    def test_it_adds_what_it_fetched_to_attempted(self):
        attempted = set()
        self.run_pass(attempted)
        self.assertEqual({c for _, c in attempted}, EXPECTED_IDS)

    def test_it_needs_no_vision_provider(self):
        # No provider is configured and assess() blows up if anything reaches it.
        # (clef is configured by INGEST_TOKEN alone, so drop that too.)
        with env(INGEST_TOKEN=None), mock.patch.object(cs, "API_KEY", ""), \
                mock.patch.dict(cs.OPENAI_PROVIDERS["groq"], {"key": ""}), \
                mock.patch.dict(cs.OPENAI_PROVIDERS["openrouter"], {"key": ""}), \
                mock.patch.dict(cs.OPENAI_PROVIDERS["github"], {"key": ""}), \
                mock.patch.object(cs, "assess", side_effect=AssertionError("vision must not run")):
            self.assertEqual(cs._enabled_providers(), [])
            _, fetched, _ = self.run_pass(set())
        self.assertEqual(len(fetched), 11)

    def test_without_a_token_it_fetches_nothing(self):
        out, fetched, archived = self.run_pass(set(), token=None)
        self.assertEqual((fetched, archived), ([], []))
        self.assertEqual(out["attempted"], 0)

    def test_feed_cams_carry_their_timestamp_and_courier_cams_their_meta_time(self):
        grabbed = iso_ago(25)
        meta_url = "https://uw-frame.entwined-app.workers.dev/meta?cam=ftl-elbo-beach-cam"
        _, _, archived = self.run_pass(set(), meta_by_url={meta_url: {"ok": True, "grabbedAtUtc": grabbed}})
        by_id = dict(archived)
        self.assertEqual(by_id["boca-inlet"], "2026-10-11T14:05:09Z")
        self.assertEqual(by_id["ftl-elbo-beach-cam"], grabbed)

    def test_a_courier_cam_with_no_usable_meta_is_skipped_not_archived_under_now(self):
        url = "https://uw-frame.entwined-app.workers.dev/meta?cam=deerfield-pier-cam"
        for bad in (None, {"ok": False}, {"ok": True}, {"ok": True, "grabbedAtUtc": "nonsense"}):
            _, fetched, archived = self.run_pass(set(), meta_by_url={url: bad})
            self.assertNotIn("deerfield-pier-cam", fetched)
            self.assertNotIn("deerfield-pier-cam", {c for c, _ in archived})
            self.assertEqual(len(fetched), 10)

    def test_one_cam_failing_does_not_stop_the_others(self):
        out, fetched, archived = self.run_pass(set(), fail_ids={"boca-inlet", "deerfield-surf-cam"})
        self.assertEqual(len(archived), 9)
        self.assertEqual(out["results"]["boca-raton/boca-inlet"], "error")

    def test_main_runs_the_archive_pass_even_with_no_vision_provider(self):
        calls = []
        registry = {"boca-raton": {"timezone": "America/New_York", "cams": []}}
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(cs, "load_registry", lambda: registry), \
                mock.patch.object(cs, "_enabled_providers", lambda: []), \
                mock.patch.object(cs, "fetch_prev", lambda slug: {}), \
                mock.patch.object(cs, "OUT_DIR", d), mock.patch.object(cs, "OUT", str(Path(d) / "legacy.json")), \
                mock.patch.object(cs, "capture_beach", side_effect=AssertionError("no providers: no vision")), \
                mock.patch.object(cs, "archive_pass", lambda attempted, cams=None, run=None: calls.append(set(attempted)) or {"attempted": 11, "results": {}}), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cs.main(), 0)
        self.assertEqual(calls, [set()])

    def test_main_runs_the_archive_pass_even_with_an_empty_registry(self):
        calls = []
        with mock.patch.object(cs, "load_registry", lambda: {}), \
                mock.patch.object(cs, "archive_pass", lambda attempted, cams=None, run=None: calls.append(1) or {"attempted": 0, "results": {}}), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cs.main(), 0)
        self.assertEqual(calls, [1])

    def test_a_crash_inside_the_archive_pass_cannot_fail_the_cycle(self):
        with mock.patch.object(cs, "load_registry", lambda: {}), \
                mock.patch.object(cs, "archive_pass", side_effect=RuntimeError("boom")), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cs.main(), 0)


class StaleFeedFrameTests(WithManifest):
    """capture_beach: a feed frame older than VISION_MAX_FRAME_AGE_MIN is not read.

    Observed 2026-10-11 6 AM: boca-inlet-surf served a 431-470 minute old night
    frame and the loop scored it ("seaweed none, crowd empty")."""

    # The same harness as CaptureBeachTests (not a subclass: its tests would run twice).
    FEED_CAM = CaptureBeachTests.FEED_CAM
    COURIER_CAM = CaptureBeachTests.COURIER_CAM
    run_capture = CaptureBeachTests.run_capture

    def two_cams(self):
        return [dict(self.FEED_CAM, id="boca-south"), dict(self.FEED_CAM, id="boca-inlet-surf", name="Inlet surf")]

    def test_the_limit_is_sixty_minutes(self):
        self.assertEqual(cs.VISION_MAX_FRAME_AGE_MIN, 60)

    def test_a_431_minute_old_night_frame_is_not_read(self):
        result, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(431))
        self.assertNotIn("assess", order)
        self.assertIsNone(result, "no reading at all for the beach this tick")
        self.assertRegex(self.out.getvalue(), r"\[boca-raton\] boca-south: skipped \(frame is 43\d min old\)")

    def test_assess_is_never_called_for_a_stale_frame(self):
        calls = []
        self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(300), assess=lambda img: calls.append(1) or {})
        self.assertEqual(calls, [])

    def test_a_fresh_frame_next_to_a_stale_one_is_read_and_the_stale_cam_is_absent(self):
        # Only the fresh cam appears; fetch order is per cam, so give each its own age.
        ages = {"boca-south": iso_ago(5), "boca-inlet-surf": iso_ago(431)}
        seen = []

        def fake_fetch(cam, info=None, feed_cache=None):
            seen.append(cam["id"])
            info["frameAt"] = ages[cam["id"]]
            return jpeg()

        with env(INGEST_TOKEN="tok"), mock.patch.object(cs, "fetch_still", fake_fetch), \
                mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                mock.patch.object(cs, "assess", lambda img: {"level": "none", "coveragePct": 0, "crowd": "empty", "crowdPct": 0, "people": 0, "provider": "t"}), \
                mock.patch.object(cs.time, "sleep", lambda s: None), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            result = cs.capture_beach("boca-raton", self.two_cams(), dt.datetime.now(ZONE), {"called": False}, {})
        self.assertEqual(seen, ["boca-south", "boca-inlet-surf"])
        self.assertEqual([c["id"] for c in result["cams"]], ["boca-south"])

    def test_the_published_output_for_a_skipped_feed_cam_matches_a_skipped_courier_cam(self):
        # A skipped cam leaves NO entry in the tick's cams and NO key in history[].frames.
        feed_cams = [self.FEED_CAM]
        stale_result, _ = self.run_capture("boca-raton", feed_cams, frame_at_info=iso_ago(431))
        courier_stale = {"ok": True, "grabbedAtUtc": iso_ago(cs.DIRECT_FRAME_MAX_AGE_MIN + 30)}
        courier_result, _ = self.run_capture("fort-lauderdale", [self.COURIER_CAM], meta=courier_stale)
        self.assertIsNone(stale_result)
        self.assertEqual(stale_result, courier_result)
        # With a fresh sibling the document has only the sibling, and no frames entry for the stale cam.
        ages = {"boca-south": iso_ago(5), "boca-inlet-surf": iso_ago(431)}

        def fake_fetch(cam, info=None, feed_cache=None):
            info["frameAt"] = ages[cam["id"]]
            return jpeg()

        now = dt.datetime.now(ZONE)
        with env(INGEST_TOKEN="tok"), mock.patch.object(cs, "fetch_still", fake_fetch), \
                mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                mock.patch.object(cs, "assess", lambda img: {"level": "low", "coveragePct": 3, "crowd": "quiet", "crowdPct": 5, "people": 2, "provider": "t"}), \
                mock.patch.object(cs.time, "sleep", lambda s: None), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            current = cs.capture_beach("boca-raton", self.two_cams(), now, {"called": False}, {})
        doc = cs.build_beach_output("boca-raton", "America/New_York", now, [("gemini", "m")], {}, current, None, None)
        self.assertEqual([c["id"] for c in doc["latest"]["cams"]], ["boca-south"])
        self.assertNotIn("frames", doc["history"][0])
        self.assertNotIn("boca-inlet-surf", json.dumps(doc))

    def test_when_every_cam_is_stale_the_previous_reading_is_carried_forward_unchanged(self):
        now = dt.datetime.now(ZONE)
        prev_latest = {"capturedAtLocal": "2026-10-11T05:50-04:00", "hour": 5, "cams": [{"id": "boca-south", "level": "low"}]}
        prev = {"dateLocal": now.date().isoformat(), "latest": prev_latest, "morning": None, "history": [], "generatedAt": "2026-10-11T09:50:00Z"}
        current, _ = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(431))
        doc = cs.build_beach_output("boca-raton", "America/New_York", now, [("gemini", "m")], prev, current, None, None)
        self.assertEqual(doc["latest"], prev_latest)
        self.assertEqual(doc["generatedAt"], "2026-10-11T09:50:00Z", "not bumped: nothing fresh was read")
        self.assertEqual(doc["history"], [])

    def test_just_inside_and_just_outside_the_limit(self):
        _, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(59))
        self.assertIn("assess", order)
        _, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(61))
        self.assertNotIn("assess", order)

    # --- the three states -------------------------------------------------

    def test_scored_only_inside_minus_five_to_sixty_minutes(self):
        for age in (59, 30, 1, -3, -4):
            _, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(age))
            self.assertIn("assess", order, f"age {age} min")

    def test_older_than_sixty_minutes_is_skipped_and_logged(self):
        for age in (61, 120, 431):
            result, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(age))
            self.assertNotIn("assess", order, f"age {age} min")
            self.assertIsNone(result)
            self.assertRegex(self.out.getvalue(), rf"boca-south: skipped \(frame is {age} min old\)")

    def test_more_than_five_minutes_in_the_future_is_skipped_and_logged(self):
        for ahead in (6, 30, 600):
            result, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(-ahead))
            self.assertNotIn("assess", order, f"{ahead} min ahead")
            self.assertIsNone(result)
            self.assertRegex(self.out.getvalue(), rf"skipped \(frame is {ahead} min in the future\)")

    def test_a_missing_timestamp_is_not_scored_and_says_so_loudly(self):
        result, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=None)
        self.assertNotIn("assess", order)
        self.assertIsNone(result, "no fresh reading, same shape as a skipped cam")
        err = self.err.getvalue()
        self.assertEqual(err.count("no frame timestamp"), 1, "one line per cam per tick")
        self.assertIn("WARN [boca-raton] boca-south: no frame timestamp", err)
        self.assertIn("not scored", err)

    def test_one_diagnostic_line_per_cam_without_a_timestamp(self):
        cams = [dict(self.FEED_CAM, id="a"), dict(self.FEED_CAM, id="b")]
        self.run_capture("boca-raton", cams, frame_at_info=None)
        lines = [l for l in self.err.getvalue().splitlines() if "no frame timestamp" in l]
        self.assertEqual(len(lines), 2)

    def test_an_unparsable_timestamp_is_treated_as_missing(self):
        result, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info="not-a-time")
        self.assertNotIn("assess", order)
        self.assertIsNone(result)
        self.assertIn("no frame timestamp", self.err.getvalue())

    def test_visionTrustNoTimestamp_lets_a_known_untimed_source_be_scored(self):
        trusted = dict(self.FEED_CAM, visionTrustNoTimestamp=True)
        result, order = self.run_capture("boca-raton", [trusted], frame_at_info=None)
        self.assertIn("assess", order)
        self.assertEqual(len(result["cams"]), 1)
        self.assertNotIn("no frame timestamp", self.err.getvalue())

    def test_the_trust_flag_does_not_excuse_a_stale_or_future_frame(self):
        trusted = dict(self.FEED_CAM, visionTrustNoTimestamp=True)
        for age in (431, -30):
            _, order = self.run_capture("boca-raton", [trusted], frame_at_info=iso_ago(age))
            self.assertNotIn("assess", order, f"age {age}")

    def test_only_true_counts_as_the_trust_flag(self):
        for bogus in ("true", 1, "yes", False, None):
            _, order = self.run_capture("boca-raton", [dict(self.FEED_CAM, visionTrustNoTimestamp=bogus)], frame_at_info=None)
            self.assertNotIn("assess", order, repr(bogus))

    def test_no_current_feed_cam_needs_the_trust_flag(self):
        registry = json.loads((ROOT / "config" / "vision-cams.json").read_text(encoding="utf-8"))
        for slug, entry in registry.items():
            for cam in entry["cams"]:
                self.assertNotIn("visionTrustNoTimestamp", cam, f"{slug}/{cam['id']}")

    def test_the_verdict_function_directly(self):
        self.assertEqual(cs.vision_frame_verdict(iso_ago(10)), (True, None))
        self.assertEqual(cs.vision_frame_verdict(iso_ago(-5.0 + 1)), (True, None))
        self.assertFalse(cs.vision_frame_verdict(None)[0])
        self.assertTrue(cs.vision_frame_verdict(None, True)[0])
        self.assertFalse(cs.vision_frame_verdict("junk", False)[0])
        self.assertTrue(cs.vision_frame_verdict("junk", True)[0])

    def test_the_archive_still_gets_a_frame_the_vision_loop_will_not_score(self):
        # The archive keeps its own rules (170-minute rule, in archive_frame).
        for at in (None, iso_ago(431), iso_ago(-30)):
            _, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=at)
            self.assertEqual(len([o for o in order if isinstance(o, tuple)]), 1)

    def test_the_stale_frame_is_still_offered_to_the_archive_and_marked_attempted(self):
        attempted = set()
        _, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(431), attempted=attempted)
        self.assertEqual(attempted, {("boca-raton", "boca-south")}, "archive_pass does not fetch it a second time")
        self.assertEqual([o for o in order if isinstance(o, tuple)], [("archive", "boca-raton", "boca-south", mock.ANY)])

    def test_a_stale_cam_spends_no_vision_quota_gap(self):
        gap = {"called": False}
        self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(431), gap_state=gap)
        self.assertEqual(self.sleeps, [])
        self.assertFalse(gap["called"], "the next cam does not wait for a call that never happened")

    def test_the_gap_still_separates_two_real_reads(self):
        cams = [dict(self.FEED_CAM, id="a"), dict(self.FEED_CAM, id="b")]
        self.run_capture("boca-raton", cams, frame_at_info=iso_ago(5))
        self.assertEqual(self.sleeps, [cs.CAM_GAP_S])

    def test_a_courier_cam_keeps_its_own_freshness_rule(self):
        # 100 minutes is past the 60-minute feed limit but inside the courier's 150: still read.
        grabbed = iso_ago(100)
        result, order = self.run_capture(
            "fort-lauderdale", [self.COURIER_CAM], meta={"ok": True, "grabbedAtUtc": grabbed}, frame_at_info=iso_ago(500))
        self.assertIn("assess", order)
        self.assertEqual(result["cams"][0]["frameAt"], grabbed)

    def test_a_direct_cam_without_a_meta_url_is_never_skipped_for_age(self):
        still = {"id": "x", "name": "X", "source": {"kind": "direct", "url": "https://u/frame"}}
        _, order = self.run_capture("boca-raton", [still], frame_at_info=iso_ago(500))
        self.assertIn("assess", order)


class FetchFilledSlotsTests(unittest.TestCase):
    def call(self, answer=None, token="tok-unit", exc=None):
        urlopen = mock.Mock(side_effect=exc) if exc else mock.Mock(return_value=FakeResponse(answer))
        with env(INGEST_TOKEN=token), mock.patch.object(cs.urllib.request, "urlopen", urlopen), \
                contextlib.redirect_stderr(io.StringIO()):
            return cs.fetch_filled_slots("boca-raton"), urlopen

    def test_sends_an_authenticated_get_and_parses_the_slots(self):
        got, urlopen = self.call({"ok": True, "slots": {"2026-10-11T14:00:00.000Z": ["boca-south", "boca-inlet"], "2026-10-11T13:00:00.000Z": []}})
        self.assertEqual(got, {
            "slots": {"2026-10-11T14:00:00.000Z": {"boca-south", "boca-inlet"}, "2026-10-11T13:00:00.000Z": set()},
            "current": None,
            "golden": [],
        })
        (req,), kwargs = urlopen.call_args
        self.assertEqual(req.get_method(), "GET")
        self.assertEqual(req.full_url, "https://app.isitbeachday.com/api/cam-frames/slots?slug=boca-raton")
        self.assertEqual(req.get_header("Authorization"), "Bearer tok-unit")
        self.assertEqual(kwargs["timeout"], cs.ARCHIVE_PRECHECK_TIMEOUT_S)

    def test_fails_open_with_none_on_every_kind_of_error(self):
        for exc in (urllib.error.HTTPError("u", 401, "no", {}, io.BytesIO(b"{}")), urllib.error.URLError("x"), TimeoutError(), OSError("x")):
            got, _ = self.call(exc=exc)
            self.assertIsNone(got, exc)
        for bad in (b"<html>", {"ok": True}, {"slots": []}, {"slots": {"a": 5}}):
            got, _ = self.call(bad)
            self.assertIsNone(got, bad)

    def test_no_token_makes_no_request(self):
        got, urlopen = self.call({"slots": {}}, token=None)
        self.assertIsNone(got)
        urlopen.assert_not_called()

    def test_slot_arithmetic_matches_the_servers_rules(self):
        now = dt.datetime.now(dt.timezone.utc)
        self.assertEqual(cs._slot_utc_of(None), now.strftime("%Y-%m-%dT%H:00:00.000Z"))
        t = now - dt.timedelta(minutes=90)
        self.assertEqual(cs._slot_utc_of(t.strftime("%Y-%m-%dT%H:%M:%SZ")), t.strftime("%Y-%m-%dT%H:00:00.000Z"))
        # Older than 3 h, in the future, or unreadable: the server files it under "now", so do we.
        for odd in ((now - dt.timedelta(hours=5)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                    (now + dt.timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"), "garbage"):
            self.assertEqual(cs._slot_utc_of(odd), cs._slot_utc_of(None))


class ArchiveRunTests(WithManifest):
    def test_precheck_asks_once_per_beach_and_never_twice(self):
        run = cs.ArchiveRun()
        with env(INGEST_TOKEN="tok"):
            run.precheck({"boca-raton", "deerfield-beach", "fort-lauderdale"})
            run.precheck({"boca-raton", "deerfield-beach", "fort-lauderdale"})
        self.assertEqual(sorted(self.filled_calls), ["boca-raton", "deerfield-beach", "fort-lauderdale"])

    def test_the_manifest_needs_at_most_three_precheck_requests(self):
        slugs = {c["slug"] for c in cs.load_archive_cams()}
        self.assertEqual(len(slugs), 3)

    def test_no_token_means_no_precheck(self):
        with env(INGEST_TOKEN=None):
            cs.ArchiveRun().precheck({"boca-raton"})
        self.assertEqual(self.filled_calls, [])

    def test_a_failed_precheck_fails_open(self):
        self.filled_by_slug["boca-raton"] = None
        run = cs.ArchiveRun()
        with env(INGEST_TOKEN="tok"):
            run.precheck({"boca-raton"})
        self.assertFalse(run.is_filled("boca-raton", "boca-south"))
        with env(INGEST_TOKEN="tok"), contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(run.enqueue("boca-raton", "boca-south", jpeg(), None))

    def test_filled_cams_are_not_queued_and_others_are(self):
        self.fill("boca-raton", ["boca-south"])
        run = cs.ArchiveRun()
        with env(INGEST_TOKEN="tok"):
            run.precheck({"boca-raton"})
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(run.enqueue("boca-raton", "boca-south", jpeg(), None))
                self.assertTrue(run.enqueue("boca-raton", "boca-inlet", jpeg(), None))
        self.assertEqual([(q[0], q[1]) for q in run.queue], [("boca-raton", "boca-inlet")])

    def test_unlisted_cams_and_a_missing_token_queue_nothing(self):
        run = cs.ArchiveRun()
        with env(INGEST_TOKEN="tok"):
            self.assertFalse(run.enqueue("boca-raton", "stray-cam", jpeg(), None))
        with env(INGEST_TOKEN=None):
            self.assertFalse(run.enqueue("boca-raton", "boca-south", jpeg(), None))

    def test_flush_uploads_concurrently_on_a_pool_of_four(self):
        gate = threading.Barrier(4, timeout=3)  # releases only if 4 uploads are in flight together
        seen = []

        def fake_archive(s, c, img, frame_at=None):
            gate.wait()
            seen.append(c)
            return "stored"

        run = cs.ArchiveRun()
        run.queue = [("boca-raton", f"cam-{i}", jpeg(), None) for i in range(4)]
        with mock.patch.object(cs, "archive_frame", fake_archive):
            out = run.flush()
        self.assertEqual(len(out), 4)
        self.assertEqual(sorted(seen), [f"cam-{i}" for i in range(4)])
        self.assertEqual(cs.ARCHIVE_WORKERS, 4)

    def test_flush_with_nothing_queued_does_nothing(self):
        self.assertEqual(cs.ArchiveRun().flush(), {})

    def test_work_past_the_deadline_is_dropped_and_logged_once(self):
        release = threading.Event()

        def stuck_archive(s, c, img, frame_at=None):
            release.wait(2)
            return "stored"

        run = cs.ArchiveRun(deadline_s=0.2)
        run.queue = [("boca-raton", f"cam-{i}", jpeg(), None) for i in range(6)]  # 4 run, 2 wait for a worker
        err = io.StringIO()
        started = time.monotonic()
        with mock.patch.object(cs, "archive_frame", stuck_archive), contextlib.redirect_stderr(err):
            out = run.flush()
            elapsed = time.monotonic() - started
            run.queue = [("boca-raton", "cam-late", jpeg(), None)]
            run.flush()  # the budget is already spent: dropped without starting
        release.set()
        self.assertLess(elapsed, 1.0)
        self.assertEqual(out, {})
        self.assertEqual(run.dropped, 7)
        self.assertEqual(err.getvalue().count("budget for this tick ran out"), 1, "logged once")

    def test_the_budget_is_shared_across_flushes(self):
        run = cs.ArchiveRun(deadline_s=0.5)

        def slowish(s, c, img, frame_at=None):
            threading.Event().wait(0.3)
            return "stored"

        with mock.patch.object(cs, "archive_frame", slowish), contextlib.redirect_stderr(io.StringIO()):
            run.queue = [("boca-raton", "a", jpeg(), None)]
            self.assertEqual(run.flush(), {"boca-raton/a": "stored"})
            run.queue = [("boca-raton", "b", jpeg(), None)]
            second = run.flush()  # only ~0.2 s left of the 0.5 s budget
        self.assertEqual(second, {})
        self.assertEqual(run.dropped, 1)
        self.assertLess(run.remaining(), 0.25)

    def test_default_deadline_is_ninety_seconds(self):
        self.assertEqual(cs.ARCHIVE_DEADLINE_S, 90.0)
        self.assertEqual(cs.ArchiveRun().remaining(), 90.0)


class CourierMetaTests(unittest.TestCase):
    def frame_at(self, meta):
        with mock.patch.object(cs, "_get", lambda url, timeout=25: json.dumps(meta).encode()), \
                contextlib.redirect_stderr(io.StringIO()):
            return cs._courier_frame_at("https://u/meta")

    def test_requires_ok_to_be_exactly_true(self):
        fresh = iso_ago(20)
        self.assertEqual(self.frame_at({"ok": True, "grabbedAtUtc": fresh}), fresh)
        for ok in (False, None, "true", 1, "yes"):
            self.assertIsNone(self.frame_at({"ok": ok, "grabbedAtUtc": fresh}), ok)
        self.assertIsNone(self.frame_at({"grabbedAtUtc": fresh}), "a missing ok is not ok")

    def test_rejects_a_frame_older_than_170_minutes(self):
        self.assertIsNotNone(self.frame_at({"ok": True, "grabbedAtUtc": iso_ago(169)}))
        self.assertIsNone(self.frame_at({"ok": True, "grabbedAtUtc": iso_ago(171)}))

    def test_rejects_missing_or_unreadable_times(self):
        for bad in (None, "", "nonsense", 12345):
            self.assertIsNone(self.frame_at({"ok": True, "grabbedAtUtc": bad}), bad)

    def test_an_unreachable_meta_is_none(self):
        def boom(url, timeout=25):
            raise OSError("down")
        with mock.patch.object(cs, "_get", boom), contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(cs._courier_frame_at("https://u/meta"))


class ArchivePassPrecheckTests(ArchivePassBase):
    """The pre-check, the courier meta rules and the time budget, as seen from archive_pass."""

    def test_a_filled_current_slot_skips_the_fetch_and_the_upload_for_archive_only_cams(self):
        self.fill("boca-raton", ["boca-inlet", "boca-inlet-north"])
        out, fetched, archived = self.run_pass(set())
        self.assertNotIn("boca-inlet", fetched)
        self.assertNotIn("boca-inlet-north", fetched)
        self.assertIn("boca-inlet-jetty", fetched)
        self.assertEqual(len(fetched), 9)
        self.assertEqual(out["results"]["boca-raton/boca-inlet"], "filled")

    def test_a_courier_cam_whose_own_hour_is_filled_is_not_downloaded(self):
        grabbed = iso_ago(40)
        meta_url = "https://uw-frame.entwined-app.workers.dev/meta?cam=deerfield-pier-cam"
        self.fill("deerfield-beach", ["deerfield-pier-cam"], grabbed)
        if cs._slot_utc_of(grabbed) == cs._slot_utc_of(None):
            self.skipTest("pre-fetch check already covers this")
        _, fetched, _ = self.run_pass(set(), meta_by_url={meta_url: {"ok": True, "grabbedAtUtc": grabbed}})
        self.assertNotIn("deerfield-pier-cam", fetched)

    def test_a_filled_hour_for_the_frame_just_fetched_skips_only_the_upload(self):
        # Feed cams learn their frame time from the fetch; the frame is from a
        # slot that is filled, so it is fetched but not uploaded.
        stamp = "2026-10-11T14:05:09Z"
        with mock.patch.object(cs, "_slot_utc_of", lambda fa=None, golden=None: "SLOT-FILLED" if fa == stamp else "SLOT-NOW"):
            self.filled_by_slug["boca-raton"] = {"SLOT-FILLED": {"boca-inlet"}}
            out, fetched, archived = self.run_pass(set())
        self.assertIn("boca-inlet", fetched)
        self.assertNotIn("boca-inlet", {c for c, _ in archived})
        self.assertEqual(out["results"]["boca-raton/boca-inlet"], "filled")

    def test_a_failed_precheck_behaves_as_before_everything_is_fetched_and_uploaded(self):
        for slug in ("boca-raton", "deerfield-beach", "fort-lauderdale"):
            self.filled_by_slug[slug] = None
        out, fetched, archived = self.run_pass(set())
        self.assertEqual(len(fetched), 11)
        self.assertEqual(len(archived), 11)

    def test_the_whole_pass_asks_the_app_at_most_three_times(self):
        self.run_pass(set())
        self.assertEqual(sorted(self.filled_calls), ["boca-raton", "deerfield-beach", "fort-lauderdale"])

    def test_a_stale_courier_frame_is_not_downloaded(self):
        meta_url = "https://uw-frame.entwined-app.workers.dev/meta?cam=ftl-elbo-beach-cam"
        _, fetched, _ = self.run_pass(set(), meta_by_url={meta_url: {"ok": True, "grabbedAtUtc": iso_ago(200)}})
        self.assertNotIn("ftl-elbo-beach-cam", fetched)

    def test_a_courier_meta_without_ok_true_is_not_downloaded(self):
        meta_url = "https://uw-frame.entwined-app.workers.dev/meta?cam=ftl-elbo-beach-cam"
        _, fetched, _ = self.run_pass(set(), meta_by_url={meta_url: {"grabbedAtUtc": iso_ago(5)}})
        self.assertNotIn("ftl-elbo-beach-cam", fetched)

    def test_the_pass_stays_inside_the_archive_budget(self):
        release = threading.Event()
        run = cs.ArchiveRun(deadline_s=0.3)

        def hang(cam, info=None, feed_cache=None):
            release.wait(2)
            return jpeg()

        started = time.monotonic()
        with env(INGEST_TOKEN="tok"), mock.patch.object(cs, "fetch_still", hang), \
                mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                mock.patch.object(cs, "_get", lambda url, timeout=25: json.dumps({"ok": True, "grabbedAtUtc": iso_ago(5)}).encode()), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            out = cs.archive_pass(set(), run=run)
        elapsed = time.monotonic() - started
        release.set()
        self.assertLess(elapsed, 1.5)
        self.assertEqual(out["results"], {})
        self.assertGreater(run.dropped, 0)


def utc(iso):
    return dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))


def frozen_now(iso):
    """Freeze the script's clock (cs.dt.datetime.now) at `iso`."""
    real = dt.datetime

    class Frozen(real):
        @classmethod
        def now(cls, tz=None):
            t = utc(iso)
            return t if tz is None else t.astimezone(tz)

    return mock.patch.object(cs.dt, "datetime", Frozen)


class FetchGoldenReplyTests(unittest.TestCase):
    """fetch_filled_slots against the real function (WithManifest would replace it)."""

    def test_fetch_filled_slots_reads_the_windows_and_the_current_slot(self):
        reply = {
            "ok": True,
            "currentSlotUtc": "2026-10-11T11:20:00.000Z",
            "golden": [
                {"kind": "sunrise", "startUtc": "2026-10-11T10:57:34.565Z", "endUtc": "2026-10-11T11:57:34.565Z"},
                {"kind": "sunset", "startUtc": "nonsense", "endUtc": "2026-10-11T23:16:18.394Z"},
                "junk",
            ],
            "slots": {"2026-10-11T11:20:00.000Z": ["boca-south"], "2026-10-11T11:10:00.000Z": []},
        }
        with env(INGEST_TOKEN="tok"), mock.patch.object(cs.urllib.request, "urlopen", mock.Mock(return_value=FakeResponse(reply))):
            got = cs.fetch_filled_slots("boca-raton")
        self.assertEqual(got["current"], "2026-10-11T11:20:00.000Z")
        self.assertEqual(got["slots"]["2026-10-11T11:20:00.000Z"], {"boca-south"})
        self.assertEqual(got["golden"], [(utc("2026-10-11T10:57:34.565Z"), utc("2026-10-11T11:57:34.565Z"))], "malformed windows are dropped")

    def test_a_window_that_opens_after_the_precheck_still_classifies_the_frame_as_golden_and_posts_it(self):
        # GET at 10:56:00Z; the sunrise window opens at 10:57:34Z. The reply lists every window of the
        # surrounding dates, so a frame judged at 10:58 lands in the 10:50 golden slot, not the 10:00 hour slot.
        reply = {
            "ok": True,
            "currentSlotUtc": "2026-10-11T10:00:00.000Z",
            "golden": [
                {"kind": "sunset", "startUtc": "2026-10-10T22:16:00.000Z", "endUtc": "2026-10-10T23:16:00.000Z"},
                {"kind": "sunrise", "startUtc": "2026-10-11T10:57:34.565Z", "endUtc": "2026-10-11T11:57:34.565Z"},
                {"kind": "sunset", "startUtc": "2026-10-11T22:16:18.394Z", "endUtc": "2026-10-11T23:16:18.394Z"},
            ],
            # The cam's HOUR slot is filled (an earlier shot); nothing golden exists yet.
            "slots": {"2026-10-11T10:00:00.000Z": ["boca-south"], "2026-10-11T09:00:00.000Z": []},
        }
        run = cs.ArchiveRun()
        with mock.patch.object(cs, "ARCHIVE_CAMS_PATH", str(MANIFEST_PATH)), env(INGEST_TOKEN="tok"), \
                mock.patch.object(cs.urllib.request, "urlopen", mock.Mock(return_value=FakeResponse(reply))):
            with frozen_now("2026-10-11T10:56:00Z"):
                run.precheck({"boca-raton"})
                self.assertTrue(run.is_filled("boca-raton", "boca-south"), "at 10:56 the hour slot is the one that counts, and it is filled")
            with frozen_now("2026-10-11T10:58:00Z"), contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(run.is_filled("boca-raton", "boca-south"), "the window has opened: the slot is 10:50, which is empty")
                self.assertEqual(cs._slot_utc_of(None, run.filled["boca-raton"]["golden"]), "2026-10-11T10:50:00.000Z")
                self.assertTrue(run.enqueue("boca-raton", "boca-south", jpeg(), None), "so the frame is queued to be posted")
                # A source time a few minutes ahead of the GET is judged by the same windows.
                self.assertEqual(cs._slot_utc_of("2026-10-11T10:59:00Z", run.filled["boca-raton"]["golden"]), "2026-10-11T10:50:00.000Z")

    def test_an_older_server_without_the_new_fields_still_works(self):
        with env(INGEST_TOKEN="tok"), mock.patch.object(cs.urllib.request, "urlopen", mock.Mock(return_value=FakeResponse({"slots": {"s": ["a"]}}))):
            got = cs.fetch_filled_slots("boca-raton")
        self.assertEqual(got, {"slots": {"s": {"a"}}, "current": None, "golden": []})


class GoldenSlotTests(WithManifest):
    """Slot-rule-aware pre-check: the server decides, the script reads the windows."""

    # A sunrise window like Boca's on 2026-10-11 (10:57:34Z-11:57:34Z).
    WINDOW = [(utc("2026-10-11T10:57:34Z"), utc("2026-10-11T11:57:34Z"))]

    def at(self, iso):
        """Freeze the script's clock at `iso` (it reads dt.datetime.now in _slot_utc_of)."""
        return frozen_now(iso)

    def test_inside_a_window_the_slot_is_ten_minutes_wide(self):
        with self.at("2026-10-11T11:30:00Z"):
            self.assertEqual(cs._slot_utc_of("2026-10-11T11:24:30Z", self.WINDOW), "2026-10-11T11:20:00.000Z")
            self.assertEqual(cs._slot_utc_of("2026-10-11T11:20:00Z", self.WINDOW), "2026-10-11T11:20:00.000Z")
            self.assertEqual(cs._slot_utc_of(None, self.WINDOW), "2026-10-11T11:30:00.000Z")

    def test_outside_a_window_or_with_none_it_is_the_hour(self):
        with self.at("2026-10-11T14:20:00Z"):
            self.assertEqual(cs._slot_utc_of("2026-10-11T14:05:00Z", self.WINDOW), "2026-10-11T14:00:00.000Z")
            self.assertEqual(cs._slot_utc_of(None, self.WINDOW), "2026-10-11T14:00:00.000Z")
        with self.at("2026-10-11T11:30:00Z"):
            self.assertEqual(cs._slot_utc_of("2026-10-11T11:24:30Z"), "2026-10-11T11:00:00.000Z")
            self.assertEqual(cs._slot_utc_of("2026-10-11T11:24:30Z", []), "2026-10-11T11:00:00.000Z")

    def test_the_window_is_half_open_like_the_servers(self):
        with self.at("2026-10-11T12:00:00Z"):
            self.assertEqual(cs._slot_utc_of("2026-10-11T10:57:00Z", self.WINDOW), "2026-10-11T10:00:00.000Z")
            self.assertEqual(cs._slot_utc_of("2026-10-11T10:58:00Z", self.WINDOW), "2026-10-11T10:50:00.000Z")
            self.assertEqual(cs._slot_utc_of("2026-10-11T11:57:00Z", self.WINDOW), "2026-10-11T11:50:00.000Z")
            self.assertEqual(cs._slot_utc_of("2026-10-11T11:58:00Z", self.WINDOW), "2026-10-11T11:00:00.000Z")

    def test_a_frame_time_the_server_would_drop_is_placed_by_the_clock_now(self):
        with self.at("2026-10-11T11:30:00Z"):
            # 5 hours old: the server files it under "now", which is inside the window.
            self.assertEqual(cs._slot_utc_of("2026-10-11T06:25:00Z", self.WINDOW), "2026-10-11T11:30:00.000Z")

    def run_for(self, run, cam_id, frame_at=None):
        return run.is_filled("boca-raton", cam_id, frame_at)

    def precheck_run(self, slots):
        self.filled_by_slug["boca-raton"] = slots
        self.golden_by_slug["boca-raton"] = self.WINDOW
        run = cs.ArchiveRun()
        with env(INGEST_TOKEN="tok"):
            run.precheck({"boca-raton"})
        return run

    def test_inside_a_window_only_the_ten_minute_slot_counts(self):
        # The :00 HOUR slot is filled (earlier, outside the window) but the current 10-minute slot is not.
        run = self.precheck_run({"2026-10-11T11:00:00.000Z": {"boca-south"}, "2026-10-11T11:20:00.000Z": {"boca-inlet"}})
        with self.at("2026-10-11T11:24:00Z"):
            self.assertFalse(self.run_for(run, "boca-south"), "the slot a frame taken now lands in is 11:20, and it is empty")
            self.assertTrue(self.run_for(run, "boca-inlet"))
            self.assertTrue(self.run_for(run, "boca-inlet", "2026-10-11T11:21:00Z"))
        with self.at("2026-10-11T11:36:00Z"):
            self.assertTrue(self.run_for(run, "boca-inlet", "2026-10-11T11:27:00Z"))
            self.assertFalse(self.run_for(run, "boca-inlet", "2026-10-11T11:31:00Z"), "the next 10 minutes are a new slot")

    def test_the_slot_is_read_at_the_time_of_the_question_not_of_the_precheck(self):
        run = self.precheck_run({"2026-10-11T11:20:00.000Z": {"boca-inlet"}})
        with self.at("2026-10-11T11:29:50Z"):
            self.assertTrue(self.run_for(run, "boca-inlet"))
        with self.at("2026-10-11T11:30:10Z"):  # ten seconds later, a new slot
            self.assertFalse(self.run_for(run, "boca-inlet"))

    def test_outside_a_window_the_hour_slot_counts_as_before(self):
        self.golden_by_slug["boca-raton"] = []
        self.filled_by_slug["boca-raton"] = {"2026-10-11T14:00:00.000Z": {"boca-south"}}
        run = cs.ArchiveRun()
        with env(INGEST_TOKEN="tok"):
            run.precheck({"boca-raton"})
        with self.at("2026-10-11T14:40:00Z"):
            self.assertTrue(self.run_for(run, "boca-south"))
            self.assertFalse(self.run_for(run, "boca-inlet"))

    def test_a_courier_frame_from_before_the_window_is_judged_as_an_hour_shot(self):
        run = self.precheck_run({"2026-10-11T10:00:00.000Z": {"boca-south"}})
        with self.at("2026-10-11T11:24:00Z"):
            self.assertTrue(self.run_for(run, "boca-south", "2026-10-11T10:30:00Z"))

    def test_a_failed_precheck_still_fails_open(self):
        self.filled_by_slug["boca-raton"] = None
        run = cs.ArchiveRun()
        with env(INGEST_TOKEN="tok"):
            run.precheck({"boca-raton"})
        with self.at("2026-10-11T11:24:00Z"):
            self.assertFalse(self.run_for(run, "boca-south"))

    def test_a_golden_tick_still_asks_the_app_at_most_three_times(self):
        for slug in ("boca-raton", "deerfield-beach", "fort-lauderdale"):
            self.golden_by_slug[slug] = self.WINDOW
        run = cs.ArchiveRun()
        with env(INGEST_TOKEN="tok"):
            run.precheck({c["slug"] for c in cs.load_archive_cams()})
            run.precheck({c["slug"] for c in cs.load_archive_cams()})
        self.assertEqual(sorted(self.filled_calls), ["boca-raton", "deerfield-beach", "fort-lauderdale"])

    def test_archive_pass_inside_a_window_skips_only_cams_whose_ten_minute_slot_is_filled(self):
        now = dt.datetime.now(dt.timezone.utc)
        self.golden_by_slug["boca-raton"] = [(now - dt.timedelta(minutes=25), now + dt.timedelta(minutes=25))]
        slot = cs._slot_utc_of(None, self.golden_by_slug["boca-raton"])
        hour_slot = cs._slot_utc_of(None)
        filled = {slot: {"boca-inlet"}}
        filled.setdefault(hour_slot, set()).add("boca-inlet-north")  # the same key in the first ten minutes of an hour
        self.filled_by_slug["boca-raton"] = filled
        fetched = []

        def fake_fetch(cam, info=None, feed_cache=None):
            fetched.append(cam["id"])
            return jpeg()

        with env(INGEST_TOKEN="tok"), mock.patch.object(cs, "fetch_still", fake_fetch), \
                mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            cs.archive_pass(set())
        self.assertNotIn("boca-inlet", fetched)
        if slot != hour_slot:
            self.assertIn("boca-inlet-north", fetched, "an hour-slot fill does not satisfy a golden slot")


class RunWindowTests(WithManifest):
    """The loop's reading window: earliest sunrise - 30 min to latest sunset + 30 min."""

    def cams(self):
        return cs.load_archive_cams()

    def test_every_manifest_cam_carries_coordinates(self):
        for c in self.cams():
            self.assertIsInstance(c["lat"], float, c["id"])
            self.assertIsInstance(c["lon"], float, c["id"])
        self.assertEqual(len({c["slug"] for c in self.cams()}), 3)

    def test_summer_the_window_runs_past_eight_forty_pm_eastern(self):
        start, end = cs.run_window(self.cams(), utc("2026-06-21T16:00:00Z"))
        # Sunset is about 8:16 PM EDT (00:16Z): the window ends half an hour later.
        self.assertTrue(utc("2026-06-22T00:38:00Z") <= end <= utc("2026-06-22T00:58:00Z"), end)
        # Sunrise is about 6:26 AM EDT (10:26Z): the window opens half an hour before.
        self.assertTrue(utc("2026-06-21T09:50:00Z") <= start <= utc("2026-06-21T10:10:00Z"), start)

    def test_winter_the_window_is_shorter(self):
        start, end = cs.run_window(self.cams(), utc("2026-12-21T16:00:00Z"))
        self.assertTrue(utc("2026-12-21T11:25:00Z") <= start <= utc("2026-12-21T11:45:00Z"), start)  # sunrise ~7:04 AM EST
        self.assertTrue(utc("2026-12-21T22:55:00Z") <= end <= utc("2026-12-21T23:15:00Z"), end)      # sunset ~5:33 PM EST

    def test_a_loop_started_by_the_ten_utc_cron_misses_no_grid_tick_of_the_morning(self):
        # The cron's first fire is 10:00Z. The window opens ~09:56Z in June (the :00 tick lands
        # at 10:00Z anyway) and ~11:34Z in December. Never earlier than 09:50Z at these beaches.
        for day in ("2026-06-21", "2026-12-21", "2026-03-20", "2026-09-22"):
            start, _ = cs.run_window(self.cams(), utc(f"{day}T16:00:00Z"))
            self.assertGreaterEqual(start, utc(f"{day}T09:50:00Z"), day)

    def test_it_follows_the_beachs_local_date_not_the_utc_date(self):
        # 2026-06-22T00:30Z is 8:30 PM EDT on June 21: still June 21's window, and still 'day'.
        self.assertEqual(cs.window_state(utc("2026-06-22T00:30:00Z"), self.cams()), "day")
        # 04:00Z is midnight EDT: June 22's window, which has not opened.
        self.assertEqual(cs.window_state(utc("2026-06-22T04:00:00Z"), self.cams()), "night")

    def test_states_around_the_edges(self):
        start, end = cs.run_window(self.cams(), utc("2026-10-11T16:00:00Z"))
        one = dt.timedelta(minutes=1)
        self.assertEqual(cs.window_state(start - one, self.cams()), "night")
        self.assertEqual(cs.window_state(start, self.cams()), "day")
        self.assertEqual(cs.window_state(end - one, self.cams()), "day")
        self.assertEqual(cs.window_state(end, self.cams()), "dusk")
        self.assertEqual(cs.window_state(end + dt.timedelta(minutes=19), self.cams()), "dusk")
        self.assertEqual(cs.window_state(end + dt.timedelta(minutes=20), self.cams()), "night")

    def test_the_old_fixed_window_closed_before_a_june_sunset_ended(self):
        # 8:25 PM EDT in June (00:25Z): the fixed 20:05 rule said night. Sunset is 8:16 PM; golden light runs to ~8:36.
        self.assertEqual(cs.window_state(utc("2026-06-22T00:25:00Z"), self.cams()), "day")

    def test_the_window_spans_every_beach_the_earliest_start_and_the_latest_end(self):
        east = {"slug": "e", "timezone": "America/New_York", "lat": 26.0, "lon": -80.0}
        west = {"slug": "w", "timezone": "America/Los_Angeles", "lat": 34.0, "lon": -118.4}
        now = utc("2026-10-11T16:00:00Z")
        s_e, e_e = cs.run_window([east], now)
        s_w, e_w = cs.run_window([west], now)
        s_both, e_both = cs.run_window([east, west], now)
        self.assertEqual(s_both, min(s_e, s_w))
        self.assertEqual(e_both, max(e_e, e_w))
        self.assertEqual(e_both, e_w)  # the west coast sets last

    def test_two_cams_of_one_beach_count_once(self):
        two = [dict(self.cams()[0]), dict(self.cams()[0], id="other")]
        self.assertEqual(cs.run_window(two, utc("2026-10-11T16:00:00Z")), cs.run_window(two[:1], utc("2026-10-11T16:00:00Z")))

    def test_polar_and_incomplete_beaches_add_nothing(self):
        polar = {"slug": "p", "timezone": "Arctic/Longyearbyen", "lat": 78.2, "lon": 15.6}
        no_geo = {"slug": "g", "timezone": "America/New_York"}
        bad_tz = {"slug": "t", "timezone": "Nowhere/Land", "lat": 26.0, "lon": -80.0}
        boca = self.cams()[0]
        now = utc("2026-06-21T12:00:00Z")
        self.assertEqual(cs.run_window([polar, no_geo, bad_tz, boca], now), cs.run_window([boca], now))
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertIsNone(cs.run_window([polar], now))
            self.assertIsNone(cs.run_window([no_geo], now))
            self.assertIsNone(cs.run_window([], now))
            self.assertEqual(cs.window_state(now, []), "unknown")

    def test_unknown_when_the_manifest_is_missing(self):
        with mock.patch.object(cs, "ARCHIVE_CAMS_PATH", "/nonexistent/archive-cams.json"), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cs.window_state(utc("2026-06-21T16:00:00Z")), "unknown")

    def test_the_cli_prints_exactly_one_word(self):
        import subprocess
        out = subprocess.run([sys.executable, str(ROOT / "scripts" / "cam_seaweed.py"), "--window-state"],
                             cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn(out.stdout.strip(), {"day", "dusk", "night"})
        self.assertEqual(len(out.stdout.strip().split()), 1)
        self.assertIn("run window", out.stderr)

    def test_the_cli_says_unknown_rather_than_failing(self):
        import subprocess
        out = subprocess.run([sys.executable, str(ROOT / "scripts" / "cam_seaweed.py"), "--window-state"],
                             cwd=ROOT, capture_output=True, text=True, timeout=30, env={**os.environ, "ARCHIVE_CAMS": "/nonexistent.json"})
        self.assertEqual(out.returncode, 0)
        self.assertEqual(out.stdout.strip(), "unknown")


class VisionCallLogTests(unittest.TestCase):
    """One line a tick: how many vision calls went to which provider/model."""

    def setUp(self):
        with cs._VISION_CALLS_LOCK:
            cs._VISION_CALLS.clear()
        self.addCleanup(lambda: cs._VISION_CALLS.clear())

    def read_with(self, gemini=None, openai=None, order=("gemini", "groq")):
        gem = gemini or (lambda img, prompt, model: {"seaweed": "none"})
        oai = openai or (lambda cfg, img, prompt: {"seaweed": "none"})
        with mock.patch.object(cs, "API_KEY", "k"), mock.patch.object(cs, "GEMINI_MODELS", ["g-1", "g-2"]), \
                mock.patch.object(cs, "PROVIDER_ORDER", list(order)), \
                mock.patch.dict(cs.OPENAI_PROVIDERS["groq"], {"key": "k", "model": "q-1"}), \
                mock.patch.object(cs, "_gemini_out", gem), mock.patch.object(cs, "_openai_out", oai), \
                mock.patch.object(cs, "_parse_out", lambda raw: {"level": "none"}):
            return cs.assess(b"x", parse=lambda raw: {"level": "none"})

    def test_none_before_any_call(self):
        self.assertEqual(cs.vision_call_summary(), "vision calls this tick: none")

    def test_a_successful_read_is_counted_against_its_model(self):
        self.read_with()
        self.read_with()
        self.assertEqual(cs.vision_call_summary(), "vision calls this tick: 2 total; gemini/g-1 ok=2 failed=0")

    def test_fallbacks_show_the_failed_attempts_and_who_took_over(self):
        def gem(img, prompt, model):
            raise RuntimeError("429 quota")

        self.read_with(gemini=gem)
        line = cs.vision_call_summary()
        self.assertIn("3 total", line)
        self.assertIn("gemini/g-1 ok=0 failed=1", line)
        self.assertIn("gemini/g-2 ok=0 failed=1", line)
        self.assertIn("groq/q-1 ok=1 failed=0", line)

    def test_a_reply_that_will_not_parse_counts_as_failed(self):
        def bad_parse(raw):
            raise ValueError("not json")

        with mock.patch.object(cs, "API_KEY", "k"), mock.patch.object(cs, "_gemini_out", lambda i, p, m: {}):
            with self.assertRaises(ValueError):
                cs.assess_with("gemini", b"x", parse=bad_parse, model="g-1")
        self.assertIn("gemini/g-1 ok=0 failed=1", cs.vision_call_summary())

    def test_main_prints_the_line_once_a_tick(self):
        registry = {"boca-raton": {"timezone": "America/New_York", "cams": []}}
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(cs, "load_registry", lambda: registry), \
                mock.patch.object(cs, "_enabled_providers", lambda: [("gemini", "g-1")]), \
                mock.patch.object(cs, "fetch_prev", lambda slug: {}), \
                mock.patch.object(cs, "capture_beach", lambda *a, **k: None), \
                mock.patch.object(cs, "load_archive_cams", lambda: []), \
                mock.patch.object(cs, "OUT_DIR", d), mock.patch.object(cs, "OUT", str(Path(d) / "legacy.json")), \
                mock.patch.object(cs, "archive_pass", lambda attempted, cams=None, run=None: {"attempted": 0, "results": {}}), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cs.main(), 0)
        self.assertEqual(out.getvalue().count("vision calls this tick:"), 1)
        self.assertIn("vision calls this tick: none", out.getvalue())

    def test_no_line_when_no_provider_is_configured(self):
        registry = {"boca-raton": {"timezone": "America/New_York", "cams": []}}
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(cs, "load_registry", lambda: registry), \
                mock.patch.object(cs, "_enabled_providers", lambda: []), \
                mock.patch.object(cs, "fetch_prev", lambda slug: {}), \
                mock.patch.object(cs, "load_archive_cams", lambda: []), \
                mock.patch.object(cs, "OUT_DIR", d), mock.patch.object(cs, "OUT", str(Path(d) / "legacy.json")), \
                mock.patch.object(cs, "archive_pass", lambda attempted, cams=None, run=None: {"attempted": 0, "results": {}}), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            cs.main()
        self.assertNotIn("vision calls this tick", out.getvalue())

    def test_the_default_provider_order_excludes_github_models(self):
        # The workflow comment about quota depends on this: gemini (2 models), groq, openrouter.
        # Clef is added only by CLEF_FALLBACK=1 (see ClefProviderTests).
        self.assertEqual(provider_order_in_fresh_process(), ["gemini", "groq", "openrouter"])


CLEF_REPLY = {
    "ok": True, "kind": "surface", "level": "low", "coveragePct": 4, "note": "",
    "crowd": "quiet", "crowdPct": 22, "people": 9, "crowdNote": "",
    "water": "clear", "waterPct": 71, "waterNote": "",
    "unreadable": False, "unreadableP": 0.03,
    "provider": "clef", "model": "@cf/cloudflare/clef", "usage": {"inputTokens": 1795}, "latencyMs": 640,
}
CLEF_UW_REPLY = {
    "ok": True, "kind": "underwater", "level": "slightly_hazy", "pct": 62, "note": "",
    "unreadable": False, "unreadableP": 0.1,
    "provider": "clef", "model": "@cf/cloudflare/clef", "usage": {"inputTokens": 867}, "latencyMs": 400,
}


def provider_order_in_fresh_process(**overrides):
    """PROVIDER_ORDER as a fresh import of cam_seaweed computes it. Unset env vars are dropped first."""
    e = {k: v for k, v in os.environ.items() if k not in ("VISION_PROVIDERS", "CLEF_FALLBACK")}
    e.update(overrides)
    out = subprocess.run([sys.executable, "-c", "import json, cam_seaweed as c; print(json.dumps(c.PROVIDER_ORDER))"],
                         cwd=Path(__file__).resolve().parent, capture_output=True, text=True, timeout=60, env=e)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def http_error(code, body=b'{"ok":false,"error":"x"}'):
    return urllib.error.HTTPError("https://app.isitbeachday.com/api/vision/clef", code, "err", {}, io.BytesIO(body))


class ClefProviderTests(unittest.TestCase):
    """Clef 27B as a fallback reader: Gemini (flash, flash-lite) -> clef -> Groq -> OpenRouter."""

    def setUp(self):
        with cs._VISION_CALLS_LOCK:
            cs._VISION_CALLS.clear()
        self.addCleanup(lambda: cs._VISION_CALLS.clear())
        self.sent = []  # (url, headers, body dict, timeout) of every Clef POST

    def urlopen(self, outcome):
        """A urlopen stand-in. `outcome` is a payload dict/bytes, an exception, or a list of those."""
        queue = list(outcome) if isinstance(outcome, list) else None

        def fake(req, timeout=None):
            self.sent.append((req.full_url, dict(req.header_items()), json.loads(req.data), timeout))
            o = queue.pop(0) if queue is not None else outcome
            if isinstance(o, BaseException):
                raise o
            return FakeResponse(o)

        return mock.patch.object(cs.urllib.request, "urlopen", fake)

    def clef_only(self):
        """The chain with Clef the only provider (the default order leaves it out until CLEF_FALLBACK=1)."""
        return mock.patch.object(cs, "PROVIDER_ORDER", ["clef"])

    def small(self):
        return mock.patch.object(cs, "shrink_for_clef", lambda img: b"\xff\xd8\xff-small-jpeg")

    # -- order and configuration ------------------------------------------------

    def test_clef_is_off_in_the_default_order_until_clef_fallback_is_1(self):
        self.assertEqual(provider_order_in_fresh_process(), ["gemini", "groq", "openrouter"])
        for off in ("0", "", "true", "yes"):
            self.assertEqual(provider_order_in_fresh_process(CLEF_FALLBACK=off), ["gemini", "groq", "openrouter"], off)

    def test_clef_fallback_1_puts_clef_right_behind_gemini(self):
        self.assertEqual(provider_order_in_fresh_process(CLEF_FALLBACK="1"), ["gemini", "clef", "groq", "openrouter"])

    def test_an_explicit_vision_providers_wins_over_the_flag(self):
        self.assertEqual(provider_order_in_fresh_process(CLEF_FALLBACK="1", VISION_PROVIDERS="groq,gemini"), ["groq", "gemini"])
        self.assertEqual(provider_order_in_fresh_process(VISION_PROVIDERS="gemini,clef"), ["gemini", "clef"])

    def test_default_provider_order_function(self):
        with env(CLEF_FALLBACK=None):
            self.assertEqual(cs.default_provider_order(), "gemini,groq,openrouter")
        with env(CLEF_FALLBACK=" 1 "):
            self.assertEqual(cs.default_provider_order(), "gemini,clef,groq,openrouter")

    def test_enabled_providers_order_with_the_flag_on(self):
        with env(INGEST_TOKEN="tok"), mock.patch.object(cs, "PROVIDER_ORDER", ["gemini", "clef", "groq", "openrouter"]), \
                mock.patch.object(cs, "API_KEY", "k"), \
                mock.patch.object(cs, "GEMINI_MODELS", ["g-flash", "g-lite"]), \
                mock.patch.dict(cs.OPENAI_PROVIDERS["groq"], {"key": "k", "model": "q-1"}), \
                mock.patch.dict(cs.OPENAI_PROVIDERS["openrouter"], {"key": "k", "model": "o-1"}):
            self.assertEqual(cs._enabled_providers(), [
                ("gemini", "g-flash"), ("gemini", "g-lite"),
                ("clef", "@cf/cloudflare/clef"), ("groq", "q-1"), ("openrouter", "o-1"),
            ])

    def test_clef_is_configured_only_when_ingest_token_is_set(self):
        with env(INGEST_TOKEN=None):
            self.assertFalse(cs._provider_configured("clef"))
            with mock.patch.object(cs, "PROVIDER_ORDER", ["gemini", "clef", "groq", "openrouter"]), \
                    mock.patch.object(cs, "API_KEY", "k"), mock.patch.object(cs, "GEMINI_MODELS", ["g"]):
                self.assertNotIn("clef", [n for n, _ in cs._enabled_providers()])
        with env(INGEST_TOKEN="   "):
            self.assertFalse(cs._provider_configured("clef"))
        with env(INGEST_TOKEN="tok"):
            self.assertTrue(cs._provider_configured("clef"))
            with mock.patch.object(cs, "PROVIDER_ORDER", ["gemini", "clef", "groq", "openrouter"]), \
                    mock.patch.object(cs, "API_KEY", ""), \
                    mock.patch.dict(cs.OPENAI_PROVIDERS["groq"], {"key": ""}), \
                    mock.patch.dict(cs.OPENAI_PROVIDERS["openrouter"], {"key": ""}):
                self.assertEqual(cs._enabled_providers(), [("clef", "@cf/cloudflare/clef")])

    def test_assess_with_clef_refuses_without_a_token(self):
        with env(INGEST_TOKEN=None):
            with self.assertRaises(RuntimeError):
                cs.assess_with("clef", b"x")

    # -- the request ---------------------------------------------------------------

    def test_the_request_is_a_bearer_post_of_kind_and_base64_image(self):
        with env(INGEST_TOKEN="tok-123", CLEF_URL=None), self.small(), self.urlopen(CLEF_REPLY):
            r = cs.assess_with("clef", b"x")
        url, headers, body, timeout = self.sent[0]
        self.assertEqual(url, "https://app.isitbeachday.com/api/vision/clef")
        self.assertEqual(headers["Authorization"], "Bearer tok-123")
        self.assertEqual(headers["Content-type"], "application/json")
        self.assertEqual(timeout, 30)
        self.assertEqual(set(body), {"kind", "image"})
        self.assertEqual(body["kind"], "surface")
        self.assertEqual(base64.b64decode(body["image"]), b"\xff\xd8\xff-small-jpeg")
        self.assertEqual(r["provider"], "clef")
        self.assertEqual(r["model"], "@cf/cloudflare/clef")

    def test_the_url_can_be_overridden(self):
        with env(INGEST_TOKEN="t"), mock.patch.object(cs, "CLEF_URL", "http://localhost:8787/api/vision/clef"), \
                self.small(), self.urlopen(CLEF_REPLY):
            cs.assess_with("clef", b"x")
        self.assertEqual(self.sent[0][0], "http://localhost:8787/api/vision/clef")

    def test_a_surface_read_has_exactly_the_shape_other_providers_return(self):
        with env(INGEST_TOKEN="t"), self.small(), self.urlopen(CLEF_REPLY):
            r = cs.assess_with("clef", b"x")
        other = cs._parse_out({"seaweed": "low", "seaweed_pct": 4, "crowd": "quiet", "crowd_pct": 22,
                               "people": 9, "water": "clear", "water_pct": 71})
        self.assertEqual(set(r), set(other) | {"provider", "model"})
        self.assertEqual(r, {**other, "provider": "clef", "model": "@cf/cloudflare/clef"})

    def test_the_underwater_read_sends_kind_underwater_and_parses_like_the_others(self):
        with env(INGEST_TOKEN="t"), self.clef_only(), self.small(), self.urlopen(CLEF_UW_REPLY):
            r = cs.assess_uw(b"x")
        self.assertEqual(self.sent[0][2]["kind"], "underwater")
        self.assertEqual(r, {"level": "slightly_hazy", "pct": 62, "note": "", "provider": "clef", "model": "@cf/cloudflare/clef"})

    def test_kind_follows_the_parser_when_not_given(self):
        with env(INGEST_TOKEN="t"), self.small(), self.urlopen(CLEF_UW_REPLY):
            cs.assess_with("clef", b"x", cs.UW_PROMPT, cs._parse_uw)
        self.assertEqual(self.sent[0][2]["kind"], "underwater")

    def test_an_unreadable_surface_frame_is_no_reading_and_stops_the_chain(self):
        dark = {**CLEF_REPLY, "unreadable": True, "unreadableP": 0.97, "water": "clear", "waterPct": 70}
        with env(INGEST_TOKEN="t"), self.small(), self.urlopen(dark):
            with self.assertRaises(cs.UnreadableFrame):
                cs.assess_with("clef", b"x")
        # The provider answered (and may be billed), so it counts as an ok call.
        self.assertIn("clef/@cf/cloudflare/clef ok=1 failed=0", cs.vision_call_summary())

    def test_an_unreadable_underwater_frame_is_no_reading_too(self):
        dark_uw = {**CLEF_UW_REPLY, "unreadable": True, "unreadableP": 0.95}
        with env(INGEST_TOKEN="t"), self.small(), self.urlopen(dark_uw):
            with self.assertRaises(cs.UnreadableFrame):
                cs.assess_with("clef", b"x", cs.UW_PROMPT, cs._parse_uw)
        with env(INGEST_TOKEN="t"), self.clef_only(), self.small(), self.urlopen(dark_uw):
            with self.assertRaises(cs.UnreadableFrame):
                cs.assess_uw(b"x")
        self.assertEqual(self.sent[-1][2]["kind"], "underwater")

    def test_assess_does_not_fall_through_to_groq_on_an_unreadable_frame(self):
        dark = {**CLEF_REPLY, "unreadable": True, "unreadableP": 0.6}
        groq_calls = []
        with env(INGEST_TOKEN="t"), mock.patch.object(cs, "API_KEY", "k"), \
                mock.patch.object(cs, "GEMINI_MODELS", ["g-1"]), \
                mock.patch.object(cs, "PROVIDER_ORDER", ["gemini", "clef", "groq"]), \
                mock.patch.dict(cs.OPENAI_PROVIDERS["groq"], {"key": "k", "model": "q-1"}), \
                mock.patch.object(cs, "_gemini_out", lambda i, p, m: (_ for _ in ()).throw(RuntimeError("429 quota"))), \
                mock.patch.object(cs, "_openai_out", lambda cfg, i, p: groq_calls.append(1) or {"seaweed": "none"}), \
                self.small(), self.urlopen(dark):
            with self.assertRaises(cs.UnreadableFrame):
                cs.assess(b"x")
        self.assertEqual(groq_calls, [], "another model must not grade the same dark frame")

    def test_an_unreadable_frame_is_not_a_plain_provider_error(self):
        # A generic `except Exception` that treats it as "try the next provider" would be the bug.
        self.assertTrue(issubclass(cs.UnreadableFrame, Exception))
        self.assertFalse(issubclass(cs.UnreadableFrame, (RuntimeError, ValueError)))

    def test_water_unknown_from_clef_stays_none(self):
        with env(INGEST_TOKEN="t"), self.small(), self.urlopen({**CLEF_REPLY, "water": None}):
            r = cs.assess_with("clef", b"x")
        self.assertIsNone(r["water"])
        self.assertEqual(r["waterPct"], 71)

    # -- failures fall through -----------------------------------------------------

    def chain(self, clef_outcome, groq=None):
        """gemini fails, then clef answers `clef_outcome`, then groq answers."""
        groq_calls = []

        def groq_out(cfg, img, prompt):
            groq_calls.append(1)
            if groq is not None:
                raise groq
            return {"seaweed": "none", "crowd": "empty", "water": "clear"}

        def gem(img, prompt, model):
            raise RuntimeError("429 quota")

        with env(INGEST_TOKEN="t"), mock.patch.object(cs, "API_KEY", "k"), \
                mock.patch.object(cs, "GEMINI_MODELS", ["g-1", "g-2"]), \
                mock.patch.object(cs, "PROVIDER_ORDER", ["gemini", "clef", "groq", "openrouter"]), \
                mock.patch.dict(cs.OPENAI_PROVIDERS["groq"], {"key": "k", "model": "q-1"}), \
                mock.patch.dict(cs.OPENAI_PROVIDERS["openrouter"], {"key": ""}), \
                mock.patch.object(cs, "_gemini_out", gem), mock.patch.object(cs, "_openai_out", groq_out), \
                self.small(), self.urlopen(clef_outcome):
            return cs.assess(b"x"), groq_calls

    def test_clef_answers_when_gemini_is_out_and_groq_is_never_called(self):
        r, groq_calls = self.chain(CLEF_REPLY)
        self.assertEqual((r["provider"], r["model"]), ("clef", "@cf/cloudflare/clef"))
        self.assertEqual(groq_calls, [])
        self.assertEqual(len(self.sent), 1)

    def test_every_route_failure_falls_through_to_groq_without_retrying(self):
        for outcome in (
            http_error(401, b'{"ok":false,"error":"unauthorized"}'),
            http_error(429, b'{"ok":false,"error":"daily-cap","reason":"daily-cap"}'),
            http_error(502, b'{"ok":false,"error":"model-error"}'),
            http_error(503, b'{"ok":false,"error":"workers ai unavailable"}'),
            urllib.error.URLError("connection refused"),
            TimeoutError("timed out"),
            b"<html>gateway</html>",
            {"ok": False, "error": "weird"},
            {**CLEF_REPLY, "level": "extreme"},
        ):
            with self.subTest(outcome=repr(outcome)[:60]):
                self.sent.clear()
                with cs._VISION_CALLS_LOCK:
                    cs._VISION_CALLS.clear()
                r, groq_calls = self.chain(outcome)
                self.assertEqual(r["provider"], "groq")
                self.assertEqual(groq_calls, [1])
                self.assertEqual(len(self.sent), 1, "one attempt: no retry, no backoff")
                self.assertIn("clef/@cf/cloudflare/clef ok=0 failed=1", cs.vision_call_summary())

    def test_when_clef_and_everything_else_fail_the_error_names_clef(self):
        with self.assertRaises(RuntimeError) as cm:
            self.chain(http_error(429, b'{"reason":"daily-cap"}'), groq=RuntimeError("down"))
        self.assertIn("clef/@cf/cloudflare/clef: HTTP 429", str(cm.exception))

    def test_the_tick_log_line_shows_clef(self):
        self.chain(CLEF_REPLY)
        line = cs.vision_call_summary()
        self.assertIn("clef/@cf/cloudflare/clef ok=1 failed=0", line)
        self.assertIn("gemini/g-1 ok=0 failed=1", line)
        self.assertIn("gemini/g-2 ok=0 failed=1", line)

    # -- the shrink --------------------------------------------------------------------

    @staticmethod
    def big_jpeg(w=1920, h=1080, quality=92):
        from PIL import Image  # skipped below when Pillow is missing
        im = Image.effect_noise((w, h), 60).convert("RGB")
        out = io.BytesIO()
        im.save(out, format="JPEG", quality=quality)
        return out.getvalue()

    def size_of(self, jpeg_bytes):
        from PIL import Image
        return Image.open(io.BytesIO(jpeg_bytes)).size

    @unittest.skipUnless(cs._pillow_image() is not None, "Pillow not installed")
    def test_pillow_shrinks_to_768_long_side_as_a_jpeg(self):
        src = self.big_jpeg()
        out = cs.shrink_for_clef(src)
        self.assertEqual(out[:3], b"\xff\xd8\xff")
        self.assertEqual(self.size_of(out), (768, 432))
        self.assertLess(len(out), len(src))
        self.assertEqual(self.size_of(cs.shrink_for_clef(self.big_jpeg(1080, 1920))), (432, 768))

    @unittest.skipUnless(cs._pillow_image() is not None, "Pillow not installed")
    def test_pillow_never_enlarges_a_small_frame(self):
        self.assertEqual(self.size_of(cs.shrink_for_clef(self.big_jpeg(400, 300))), (400, 300))

    @unittest.skipUnless(cs._pillow_image() is not None, "Pillow not installed")
    def test_pillow_uses_quality_60_then_512_px_quality_50_over_120_kb(self):
        saved = []
        real = cs._shrink_pillow

        def spy(Image, img, max_side, quality):
            out = real(Image, img, max_side, quality)
            saved.append((max_side, quality, len(out)))
            return out

        self.assertEqual(cs.CLEF_SMALL_MAX_BYTES, 120 * 1024)
        # Lower the limit instead of building a 120 KB-plus noise frame.
        with mock.patch.object(cs, "_shrink_pillow", spy), mock.patch.object(cs, "CLEF_SMALL_MAX_BYTES", 100):
            out = cs.shrink_for_clef(self.big_jpeg())
        self.assertEqual([(a, b) for a, b, _ in saved], [(768, 60), (512, 50)])
        self.assertEqual(len(out), saved[1][2], "the 512 px copy is the one sent")
        self.assertEqual(self.size_of(out), (512, 288))
        saved.clear()
        with mock.patch.object(cs, "_shrink_pillow", spy):
            cs.shrink_for_clef(self.big_jpeg())
        self.assertEqual([(a, b) for a, b, _ in saved], [(768, 60)])

    @unittest.skipUnless(shutil.which("ffmpeg") and cs._pillow_image() is not None, "needs ffmpeg and Pillow")
    def test_without_pillow_ffmpeg_does_the_same_shrink(self):
        with mock.patch.object(cs, "_pillow_image", lambda: None):
            out = cs.shrink_for_clef(self.big_jpeg())
            tall = cs.shrink_for_clef(self.big_jpeg(1080, 1920))
            small = cs.shrink_for_clef(self.big_jpeg(400, 300))
        self.assertEqual(out[:3], b"\xff\xd8\xff")
        self.assertEqual(self.size_of(out), (768, 432))
        self.assertEqual(self.size_of(tall), (432, 768))
        self.assertEqual(self.size_of(small), (400, 300))

    def test_ffmpeg_command_when_pillow_is_missing(self):
        seen = {}

        def fake_run(cmd, **kw):
            seen["cmd"], seen["input"], seen["timeout"] = cmd, kw.get("input"), kw.get("timeout")
            return subprocess.CompletedProcess(cmd, 0, stdout=b"\xff\xd8\xff-shrunk", stderr=b"")

        with mock.patch.object(cs, "_pillow_image", lambda: None), mock.patch.object(cs.subprocess, "run", fake_run):
            out = cs.shrink_for_clef(b"original-bytes")
        self.assertEqual(out, b"\xff\xd8\xff-shrunk")
        cmd = seen["cmd"]
        self.assertEqual(cmd[0], "ffmpeg")
        self.assertEqual(seen["input"], b"original-bytes")
        self.assertIn("768", cmd[cmd.index("-vf") + 1])
        self.assertEqual(cmd[cmd.index("-q:v") + 1], "6")

    def test_a_failed_shrink_fails_the_provider_not_the_run(self):
        with mock.patch.object(cs, "_pillow_image", lambda: None), \
                mock.patch.object(cs.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 1, stdout=b"", stderr=b"bad")):
            with env(INGEST_TOKEN="t"), self.urlopen(CLEF_REPLY):
                with self.assertRaises(RuntimeError):
                    cs.assess_with("clef", b"not a jpeg")
        self.assertEqual(self.sent, [], "nothing is posted when the image cannot be shrunk")
        self.assertIn("clef/@cf/cloudflare/clef ok=0 failed=1", cs.vision_call_summary())


class SameFeedFrameTests(WithManifest):
    """capture_beach: a FEED frame we already scored successfully is not read again.

    Observed 2026-10-11/12: the loop ticks every 10 min but each feed view
    refreshes only every ~10-30 min, so most ticks re-scored an identical still
    and burned free-tier vision quota for nothing."""

    FEED_CAM = CaptureBeachTests.FEED_CAM

    def capture(self, cams, images, prev=None, assess=None):
        """One tick. `images` maps cam id -> the JPEG bytes the feed serves."""
        calls = []

        def fake_fetch(cam, info=None, feed_cache=None):
            info["frameAt"] = iso_ago(2)
            return images[cam["id"]]

        def fake_assess(img):
            calls.append(img)
            return {"level": "none", "coveragePct": 0, "crowd": "quiet", "crowdPct": 5, "people": 2, "provider": "t"}

        self.out = io.StringIO()
        self.sleeps = []
        now = dt.datetime.now(ZONE)
        with env(INGEST_TOKEN=None), mock.patch.object(cs, "fetch_still", fake_fetch), \
                mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                mock.patch.object(cs, "assess", assess or fake_assess), \
                mock.patch.object(cs.time, "sleep", lambda s: self.sleeps.append(s)), \
                contextlib.redirect_stdout(self.out), contextlib.redirect_stderr(io.StringIO()):
            result = cs.capture_beach("boca-raton", cams, now, {"called": False}, prev or {})
        return result, calls, now

    def doc(self, now, prev, current):
        return cs.build_beach_output("boca-raton", "America/New_York", now, [("gemini", "m")], prev, current, None, None)

    def test_a_scored_frame_is_recorded_by_cam_in_the_published_document(self):
        img = jpeg() + b"A"
        result, calls, now = self.capture([self.FEED_CAM], {"boca-south": img})
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["cams"][0]["frameSha"], cs.frame_sha(img))
        doc = self.doc(now, {}, result)
        self.assertEqual(doc["frameShas"], {"boca-south": cs.frame_sha(img)})
        # Feed cams add nothing to history[].frames (that stays courier-only; the file must not grow per tick).
        self.assertNotIn("frames", doc["history"][0])

    def test_the_same_frame_next_tick_is_not_read_again(self):
        img = jpeg() + b"A"
        result, _, now = self.capture([self.FEED_CAM], {"boca-south": img})
        prev = self.doc(now, {}, result)
        result2, calls, now2 = self.capture([self.FEED_CAM], {"boca-south": img}, prev=prev)
        self.assertEqual(calls, [], "no vision call for an identical frame")
        self.assertIsNone(result2)
        self.assertIn("[boca-raton] boca-south: skipped (same frame already scored)", self.out.getvalue())

    def test_a_new_frame_is_read_and_replaces_the_recorded_one(self):
        img_a, img_b = jpeg() + b"A", jpeg() + b"B"
        result, _, now = self.capture([self.FEED_CAM], {"boca-south": img_a})
        prev = self.doc(now, {}, result)
        result2, calls, now2 = self.capture([self.FEED_CAM], {"boca-south": img_b}, prev=prev)
        self.assertEqual(calls, [img_b])
        self.assertEqual(self.doc(now2, prev, result2)["frameShas"], {"boca-south": cs.frame_sha(img_b)})

    def test_each_cam_is_judged_on_its_own_frame(self):
        cams = [dict(self.FEED_CAM, id="boca-south"), dict(self.FEED_CAM, id="boca-inlet-surf", name="Inlet surf")]
        a1, b1, b2 = jpeg() + b"a1", jpeg() + b"b1", jpeg() + b"b2"
        result, _, now = self.capture(cams, {"boca-south": a1, "boca-inlet-surf": b1})
        prev = self.doc(now, {}, result)
        result2, calls, now2 = self.capture(cams, {"boca-south": a1, "boca-inlet-surf": b2}, prev=prev)
        self.assertEqual(calls, [b2])
        # The unchanged cam is carried (see CarriedReadingTests), only the changed one is fresh.
        self.assertEqual([(c["id"], c.get("carried", False)) for c in result2["cams"]],
                         [("boca-south", True), ("boca-inlet-surf", False)])
        doc2 = self.doc(now2, prev, result2)
        # The skipped cam keeps its recorded frame; the read one moves on.
        self.assertEqual(doc2["frameShas"], {"boca-south": cs.frame_sha(a1), "boca-inlet-surf": cs.frame_sha(b2)})

    def test_a_failed_read_does_not_record_the_frame_so_it_is_retried(self):
        img = jpeg() + b"A"

        def boom(_img):
            raise RuntimeError("all vision providers failed")

        result, calls, now = self.capture([self.FEED_CAM], {"boca-south": img}, assess=boom)
        self.assertIsNone(result)
        doc = self.doc(now, {}, result)
        self.assertEqual(doc["frameShas"], {})
        # Next tick: same frame, nothing recorded -> it is read again.
        result2, calls2, _ = self.capture([self.FEED_CAM], {"boca-south": img}, prev=doc)
        self.assertEqual(len(calls2), 1)
        self.assertIsNotNone(result2)

    def test_a_failed_read_keeps_the_older_recorded_frame(self):
        img_a, img_b = jpeg() + b"A", jpeg() + b"B"
        result, _, now = self.capture([self.FEED_CAM], {"boca-south": img_a})
        prev = self.doc(now, {}, result)

        def boom(_img):
            raise RuntimeError("quota")

        failed, _, now2 = self.capture([self.FEED_CAM], {"boca-south": img_b}, prev=prev, assess=boom)
        doc = self.doc(now2, prev, failed)
        self.assertEqual(doc["frameShas"], {"boca-south": cs.frame_sha(img_a)})
        # B was never scored, so B is read next tick; A would be a (correct) skip.
        _, calls, _ = self.capture([self.FEED_CAM], {"boca-south": img_b}, prev=doc)
        self.assertEqual(calls, [img_b])
        _, calls, _ = self.capture([self.FEED_CAM], {"boca-south": img_a}, prev=doc)
        self.assertEqual(calls, [])

    def test_when_every_cam_is_unchanged_the_previous_reading_is_carried_forward_unchanged(self):
        # Same output contract as the all-stale case: nothing fresh, nothing bumped, no history entry.
        img = jpeg() + b"A"
        result, _, now = self.capture([self.FEED_CAM], {"boca-south": img})
        prev = self.doc(now, {}, result)
        prev["generatedAt"] = "2026-10-11T09:50:00Z"
        result2, _, now2 = self.capture([self.FEED_CAM], {"boca-south": img}, prev=prev)
        doc = self.doc(now2, prev, result2)
        self.assertEqual(doc["latest"], prev["latest"])
        self.assertEqual(doc["generatedAt"], "2026-10-11T09:50:00Z")
        self.assertEqual(doc["history"], prev["history"])
        self.assertEqual(doc["frameShas"], prev["frameShas"])

    def test_a_stale_frame_is_still_skipped_for_age_not_for_sameness(self):
        img = jpeg() + b"A"
        prev = {"frameShas": {"boca-south": cs.frame_sha(img)}}

        def fake_fetch(cam, info=None, feed_cache=None):
            info["frameAt"] = iso_ago(431)
            return img

        out = io.StringIO()
        with mock.patch.object(cs, "fetch_still", fake_fetch), mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            cs.capture_beach("boca-raton", [self.FEED_CAM], dt.datetime.now(ZONE), {"called": False}, prev)
        self.assertIn("frame is 43", out.getvalue())
        self.assertNotIn("same frame", out.getvalue())

    def test_a_skipped_frame_spends_no_quota_gap(self):
        cams = [dict(self.FEED_CAM, id="boca-south"), dict(self.FEED_CAM, id="boca-inlet-surf", name="Inlet surf")]
        a, b = jpeg() + b"a", jpeg() + b"b"
        prev = {"frameShas": {"boca-south": cs.frame_sha(a)}}
        _, calls, _ = self.capture(cams, {"boca-south": a, "boca-inlet-surf": b}, prev=prev)
        self.assertEqual(calls, [b])
        self.assertEqual(self.sleeps, [], "the skipped cam was first, so the one real read needs no gap")

    def test_a_courier_cam_keeps_its_own_meta_based_dedupe(self):
        # Courier cams are not fingerprinted: their meta already says "same frame".
        courier = CaptureBeachTests.COURIER_CAM
        meta = {"ok": True, "grabbedAtUtc": iso_ago(5)}
        run = CaptureBeachTests.run_capture
        result, order = run(self, "fort-lauderdale", [courier], meta=meta)
        self.assertNotIn("frameSha", result["cams"][0])
        self.assertEqual(result["cams"][0]["frameAt"], meta["grabbedAtUtc"])

    def test_the_prev_lookup_ignores_junk(self):
        self.assertIsNone(cs.prev_scored_sha_for_cam({}, "x"))
        self.assertIsNone(cs.prev_scored_sha_for_cam({"frameShas": "nope"}, "x"))
        self.assertIsNone(cs.prev_scored_sha_for_cam({"frameShas": {"x": 5}}, "x"))
        self.assertEqual(cs.prev_scored_sha_for_cam({"frameShas": {"x": "abc"}}, "x"), "abc")


class CarriedReadingTests(WithManifest):
    """A tick where only SOME cams changed still rolls up over ALL of them.

    Codex review of 9764baa: with unchanged frames skipped and absent, a clean
    changed cam erased an unchanged high-seaweed cam from the headline, the
    partial roll-up went into history[], and a partial first capture could become
    the day's morning. Unchanged (or failed) cams now contribute their last good
    reading, marked carried, while it is still fresh enough to be scored."""

    def setUp(self):
        super().setUp()
        # These tests are about CARRYING readings. Their fixture cam A reads "high"
        # on its very first sighting, which jump confirmation (JumpConfirmationTests)
        # would hold back for a second look; pass fresh readings through untouched here.
        p = mock.patch.object(cs, "confirm_seaweed_jumps", lambda fresh, pending: fresh)
        p.start()
        self.addCleanup(p.stop)

    def cam(self, cid, kind="feed"):
        if kind == "feed":
            return {"id": cid, "name": cid, "source": {"kind": "feed", "base": "http://x", "view": "s4"}}
        return {"id": cid, "name": cid, "source": {"kind": "direct", "url": "https://u/" + cid, "meta": "https://u/m/" + cid}}

    # What each fake image "looks like" to the vision model.
    LOOKS = {
        b"A1": {"level": "high", "coveragePct": 60, "crowd": "quiet", "crowdPct": 5, "people": 2, "water": "murky", "waterPct": 20},
        b"B1": {"level": "none", "coveragePct": 0, "crowd": "busy", "crowdPct": 80, "people": 90, "water": "clear", "waterPct": 90},
        b"B2": {"level": "none", "coveragePct": 0, "crowd": "busy", "crowdPct": 85, "people": 95, "water": "clear", "waterPct": 95},
        b"C1": {"level": "low", "coveragePct": 10, "crowd": "light", "crowdPct": 30, "people": 20, "water": "clear", "waterPct": 70},
    }

    def tick(self, cams, images, prev, *, frame_ages=None, now=None, fail=()):
        """One capture_beach tick; images: cam id -> bytes tag; returns (group, doc)."""
        ages = frame_ages or {}

        def fake_fetch(cam, info=None, feed_cache=None):
            info["frameAt"] = iso_ago(ages.get(cam["id"], 2))
            return jpeg() + images[cam["id"]]

        def fake_assess(img):
            tag = img[len(jpeg()):]
            if tag in fail:
                raise RuntimeError("vision down")
            return dict(self.LOOKS[tag], provider="t")

        now = now or dt.datetime.now(ZONE)
        with env(INGEST_TOKEN=None), mock.patch.object(cs, "fetch_still", fake_fetch), \
                mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                mock.patch.object(cs, "assess", fake_assess), \
                mock.patch.object(cs.time, "sleep", lambda s: None), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            group = cs.capture_beach("boca-raton", cams, now, {"called": False}, prev)
        doc = cs.build_beach_output("boca-raton", "America/New_York", now, [("gemini", "m")], prev, group, None, None)
        return group, doc

    def first_full_tick(self):
        cams = [self.cam("a"), self.cam("b"), self.cam("c")]
        group, doc = self.tick(cams, {"a": b"A1", "b": b"B1", "c": b"C1"}, {})
        self.assertFalse(group.get("partial"))
        return cams, doc

    def test_only_b_changes_so_the_roll_up_still_covers_a_b_and_c(self):
        cams, prev = self.first_full_tick()
        group, doc = self.tick(cams, {"a": b"A1", "b": b"B2", "c": b"C1"}, prev)
        self.assertEqual([(c["id"], bool(c.get("carried"))) for c in group["cams"]],
                         [("a", True), ("b", False), ("c", True)])
        self.assertNotIn("partial", group)
        entry = doc["history"][-1]
        # A's high seaweed and C's cloudiness still count: the changed, clean cam does not erase them.
        self.assertEqual(entry["seaweed"], "high")
        self.assertEqual(entry["cov"], 60)
        self.assertEqual(entry["level"], "busy")
        self.assertEqual(entry["crowdPct"], 85)
        self.assertEqual(entry["clr"], 70)  # median of 20 / 95 / 70 (95 alone, from the partial set, would be wrong)
        self.assertEqual(cs.worst_seaweed(doc["latest"])["level"], "high")

    def test_a_carried_reading_is_the_old_one_with_its_original_times(self):
        cams, prev = self.first_full_tick()
        old_a = next(c for c in prev["latest"]["cams"] if c["id"] == "a")
        group, _ = self.tick(cams, {"a": b"A1", "b": b"B2", "c": b"C1"}, prev)
        carried_a = group["cams"][0]
        self.assertEqual({k: v for k, v in carried_a.items() if k != "carried"}, old_a)
        self.assertEqual(carried_a["frameAt"], old_a["frameAt"])
        self.assertEqual(carried_a["scoredAt"], old_a["scoredAt"])

    def test_the_carried_flag_survives_a_second_tick_and_keeps_the_original_time(self):
        cams, prev = self.first_full_tick()
        _, doc2 = self.tick(cams, {"a": b"A1", "b": b"B2", "c": b"C1"}, prev)
        group3, _ = self.tick(cams, {"a": b"A1", "b": b"B1", "c": b"C1"}, doc2)
        a3 = group3["cams"][0]
        self.assertTrue(a3["carried"])
        self.assertEqual(a3["frameAt"], doc2["latest"]["cams"][0]["frameAt"])

    def test_a_carried_feed_reading_older_than_sixty_minutes_drops_out(self):
        cams, prev = self.first_full_tick()
        # Age every old reading: A's frame was taken 59 min before the next tick, C's 61.
        for c in prev["latest"]["cams"]:
            c["frameAt"] = iso_ago({"a": 59, "b": 70, "c": 61}[c["id"]])
        group, doc = self.tick(cams, {"a": b"A1", "b": b"B2", "c": b"C1"}, prev)
        self.assertEqual([(c["id"], bool(c.get("carried"))) for c in group["cams"]], [("a", True), ("b", False)])
        self.assertTrue(group["partial"])
        self.assertEqual(doc["history"][-1]["seaweed"], "high")  # A (59 min) still in
        # ...and at 61 min A is gone too.
        for c in prev["latest"]["cams"]:
            c["frameAt"] = iso_ago(61)
        group, _ = self.tick(cams, {"a": b"A1", "b": b"B2", "c": b"C1"}, prev)
        self.assertEqual([c["id"] for c in group["cams"]], ["b"])

    def test_a_reading_with_no_usable_time_is_not_carried(self):
        cams, prev = self.first_full_tick()
        for c in prev["latest"]["cams"]:
            c.pop("frameAt", None)
            c.pop("scoredAt", None)
        group, _ = self.tick(cams, {"a": b"A1", "b": b"B2", "c": b"C1"}, prev)
        self.assertEqual([c["id"] for c in group["cams"]], ["b"])

    def test_scoredAt_stands_in_when_a_feed_frame_has_no_timestamp(self):
        old = {"id": "a", "name": "a", "level": "high", "scoredAt": iso_ago(30)}
        got = cs.carried_readings({"latest": {"cams": [old]}}, [self.cam("a")], set(), dt.datetime.now(ZONE))
        self.assertEqual([c["id"] for c in got], ["a"])
        old["scoredAt"] = iso_ago(75)
        self.assertEqual(cs.carried_readings({"latest": {"cams": [old]}}, [self.cam("a")], set(), dt.datetime.now(ZONE)), [])

    def test_a_cam_whose_read_fails_this_tick_keeps_its_recent_reading(self):
        cams, prev = self.first_full_tick()
        group, _ = self.tick(cams, {"a": b"A1", "b": b"B2", "c": b"B1"}, prev, fail=(b"B1",))
        self.assertEqual([(c["id"], bool(c.get("carried"))) for c in group["cams"]],
                         [("a", True), ("b", False), ("c", True)])

    def test_nothing_fresh_means_no_group_at_all_so_the_beach_carries_forward_as_before(self):
        cams, prev = self.first_full_tick()
        group, doc = self.tick(cams, {"a": b"A1", "b": b"B1", "c": b"C1"}, prev)
        self.assertIsNone(group)
        self.assertEqual(doc["latest"], prev["latest"])
        self.assertEqual(len(doc["history"]), len(prev["history"]))

    def test_carried_readings_do_not_touch_the_dedupe_or_the_courier_frame_memory(self):
        cams, prev = self.first_full_tick()
        _, doc = self.tick(cams, {"a": b"A1", "b": b"B2", "c": b"C1"}, prev)
        self.assertEqual(doc["frameShas"]["a"], prev["frameShas"]["a"])
        self.assertEqual(doc["frameShas"]["b"], cs.frame_sha(jpeg() + b"B2"))
        # History `frames` is courier-only: feed readings (fresh or carried) never enter it.
        self.assertNotIn("frames", doc["history"][-1])

    def in_morning(self):
        """Make the current real hour a MORNING hour (frame ages are judged on the real clock)."""
        return mock.patch.object(cs, "MORNING", range(0, 24))

    def test_a_partial_first_capture_cannot_become_the_morning_for_good(self):
        cams = [self.cam("a"), self.cam("b"), self.cam("c")]
        with self.in_morning():
            # Only B reads (A and C fail): a partial capture may fill an EMPTY morning...
            group1, doc1 = self.tick(cams, {"a": b"A1", "b": b"B1", "c": b"C1"}, {}, fail=(b"A1", b"C1"))
            self.assertTrue(group1["partial"])
            self.assertTrue(doc1["morning"]["partial"])
            # ...but the next complete capture replaces it (B's frame is unchanged -> carried).
            group2, doc2 = self.tick(cams, {"a": b"A1", "b": b"B1", "c": b"C1"}, doc1)
        self.assertNotIn("partial", group2)
        self.assertEqual([c["id"] for c in doc2["morning"]["cams"]], ["a", "b", "c"])
        self.assertNotIn("partial", doc2["morning"])

    def test_a_partial_capture_never_displaces_a_complete_morning(self):
        cams = [self.cam("a"), self.cam("b"), self.cam("c")]
        with self.in_morning():
            _, doc1 = self.tick(cams, {"a": b"A1", "b": b"B1", "c": b"C1"}, {})
            self.assertNotIn("partial", doc1["morning"])
            # Even an EARLIER-hour partial capture must not replace it.
            h = doc1["morning"]["hour"]
            partial = {"capturedAtLocal": "2026-10-12T00:00-04:00", "hour": max(h - 1, 0), "cams": [doc1["latest"]["cams"][1]], "partial": True}
            now = dt.datetime.now(ZONE)
            doc = cs.build_beach_output("boca-raton", "America/New_York", now, [("gemini", "m")], doc1, partial, None, None)
        self.assertEqual(doc["morning"], doc1["morning"])

    def test_outside_the_morning_hours_nothing_sets_the_morning(self):
        with mock.patch.object(cs, "MORNING", range(0, 0)):
            _, doc = self.tick([self.cam("a")], {"a": b"A1"}, {})
        self.assertIsNone(doc["morning"])

    def test_the_courier_path_had_the_same_gap_and_now_carries_too(self):
        # Three courier cams on one beach; the Mac grabbed them minutes apart, so a
        # tick can see only ONE new frame while the others still show the last one.
        cams = [self.cam("d1", "direct"), self.cam("d2", "direct"), self.cam("d3", "direct")]
        grabbed = {"d1": iso_ago(100), "d2": iso_ago(100), "d3": iso_ago(100)}

        def run(prev, grabbed, now=None):
            def fake_get(url, timeout=25):
                cid = url.rsplit("/", 1)[1]
                return json.dumps({"ok": True, "grabbedAtUtc": grabbed[cid]}).encode()

            def fake_fetch(cam, info=None, feed_cache=None):
                return jpeg() + {"d1": b"A1", "d2": b"B1", "d3": b"C1"}[cam["id"]]

            def fake_assess(img):
                return dict(self.LOOKS[img[len(jpeg()):]], provider="t")

            now = now or dt.datetime.now(ZONE)
            with env(INGEST_TOKEN=None), mock.patch.object(cs, "_get", fake_get), \
                    mock.patch.object(cs, "fetch_still", fake_fetch), \
                    mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                    mock.patch.object(cs, "assess", fake_assess), mock.patch.object(cs.time, "sleep", lambda s: None), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                group = cs.capture_beach("deerfield-beach", cams, now, {"called": False}, prev)
            return group, cs.build_beach_output("deerfield-beach", "America/New_York", now, [("gemini", "m")], prev, group, None, None)

        _, prev = run({}, grabbed)
        # d2 alone gets a new frame (grabbed 80 min ago -> 20 min fresher than the others' 100).
        grabbed2 = dict(grabbed, d2=iso_ago(80))
        group, doc = run(prev, grabbed2)
        self.assertEqual([(c["id"], bool(c.get("carried"))) for c in group["cams"]],
                         [("d1", True), ("d2", False), ("d3", True)])
        self.assertEqual(doc["history"][-1]["seaweed"], "high")
        # The courier frame memory only moves for the cam that really had a new frame.
        self.assertEqual(doc["history"][-1]["frames"], {"d2": grabbed2["d2"]})
        # Courier readings use the courier's own 150-minute limit, not the feed's 60.
        self.assertEqual(cs.DIRECT_FRAME_MAX_AGE_MIN, 150)
        aged = json.loads(json.dumps(prev))
        for c in aged["latest"]["cams"]:
            c["frameAt"] = iso_ago(151 if c["id"] == "d3" else 149)
        kept = cs.carried_readings(aged, cams, {"d2"}, dt.datetime.now(ZONE))
        self.assertEqual([c["id"] for c in kept], ["d1"])


UTC = dt.timezone.utc
BOCA = (26.3587, -80.0686)  # config/locations.ts boca-raton


def utc_at(y, mo, d, h, mi=0):
    return dt.datetime(y, mo, d, h, mi, tzinfo=UTC)


class SolarElevationTests(unittest.TestCase):
    """solar_elevation_deg: Boca Raton on 2026-10-13, EDT = UTC-4."""

    def test_the_sun_is_at_the_standard_horizon_angle_at_the_solver_sunrise_and_sunset(self):
        # sun_cam_check.sun_times() (the port of lib/sources/sun.ts) puts sunrise at
        # 11:18Z (7:18 AM EDT) and sunset at 22:54Z (6:54 PM EDT), at -0.833 deg.
        import sun_cam_check
        t = sun_cam_check.sun_times(*BOCA, dt.date(2026, 10, 13))
        for event in ("sunrise", "sunset"):
            self.assertAlmostEqual(cs.solar_elevation_deg(*BOCA, t[event]), -0.833, delta=0.1, msg=event)

    def test_known_elevations_that_day(self):
        for when, want, tol in (
            (utc_at(2026, 10, 13, 11, 30), 1.7, 0.3),    # 7:30 AM EDT: the false "moderate 20%" frame
            (utc_at(2026, 10, 13, 12, 0), 8.3, 0.3),     # 8:00 AM: still under the 10 deg gate
            (utc_at(2026, 10, 13, 17, 0), 55.6, 0.3),    # 1:00 PM: near solar noon (90 - 26.36 - 7.9)
            (utc_at(2026, 10, 13, 23, 1), -2.4, 0.3),    # 7:01 PM EDT: the false "high 60%" dusk frame
            (utc_at(2026, 10, 14, 0, 0), -15.3, 0.3),    # 8:00 PM: well after dark
        ):
            self.assertAlmostEqual(cs.solar_elevation_deg(*BOCA, when), want, delta=tol, msg=str(when))

    def test_the_1_20_pm_false_alarm_frame_is_high_sun(self):
        # That one is NOT a low-sun case: the rock shelf is handled by the confirm + hint fixes.
        self.assertGreater(cs.solar_elevation_deg(*BOCA, utc_at(2026, 10, 13, 17, 20)), 50)

    def test_an_aware_local_time_and_a_naive_utc_time_agree(self):
        edt = dt.datetime(2026, 10, 13, 7, 30, tzinfo=dt.timezone(dt.timedelta(hours=-4)))
        self.assertAlmostEqual(cs.solar_elevation_deg(*BOCA, edt),
                               cs.solar_elevation_deg(*BOCA, dt.datetime(2026, 10, 13, 11, 30)), places=9)

    def test_equator_at_the_september_equinox_noon_is_nearly_overhead(self):
        # Equinox is ~2026-09-23 00:05Z; at 12:00Z on the prime meridian the sun is
        # within a few degrees of the zenith (equation of time ~ +7 min, decl ~ 0).
        self.assertGreater(cs.solar_elevation_deg(0.0, 0.0, utc_at(2026, 9, 23, 12, 0)), 85)


class LowSunGateTests(WithManifest):
    """apply_low_sun_gate (pure) and its wiring in capture_beach."""

    READ = {"id": "boca-inlet-surf", "name": "Inlet", "level": "moderate", "coveragePct": 20,
            "note": "pink light", "crowd": "quiet", "crowdPct": 5, "people": 3, "crowdNote": "few",
            "water": "slightly_murky", "waterPct": 58, "waterNote": "tinted",
            "provider": "gemini", "frameAt": "2026-10-13T11:30:00Z", "scoredAt": "2026-10-13T11:35:00Z",
            "frameSha": "abc"}

    def test_below_the_threshold_seaweed_and_water_are_nulled_and_crowd_is_kept(self):
        got = cs.apply_low_sun_gate(self.READ, 1.7234, 10)
        for k in ("level", "coveragePct", "note", "water", "waterPct", "waterNote"):
            self.assertIn(k, got)
            self.assertIsNone(got[k], k)
        self.assertIs(got["lowSun"], True)
        self.assertEqual(got["sunElevDeg"], 1.7)
        for k in ("crowd", "crowdPct", "people", "crowdNote", "provider", "frameAt", "scoredAt", "frameSha", "id", "name"):
            self.assertEqual(got[k], self.READ[k], k)

    def test_does_not_mutate_its_input(self):
        before = dict(self.READ)
        cs.apply_low_sun_gate(self.READ, -3.0, 10)
        self.assertEqual(self.READ, before)

    def test_at_or_above_the_threshold_the_reading_is_returned_untouched(self):
        self.assertIs(cs.apply_low_sun_gate(self.READ, 10.0, 10), self.READ)
        self.assertIs(cs.apply_low_sun_gate(self.READ, 55.0, 10), self.READ)

    def test_unknown_elevation_means_no_gate(self):
        self.assertIs(cs.apply_low_sun_gate(self.READ, None, 10), self.READ)

    def test_the_threshold_comes_from_the_module_setting_by_default(self):
        with mock.patch.object(cs, "LOW_SUN_DEG", 20.0):
            self.assertTrue(cs.apply_low_sun_gate(self.READ, 15.0).get("lowSun"))
        with mock.patch.object(cs, "LOW_SUN_DEG", 5.0):
            self.assertNotIn("lowSun", cs.apply_low_sun_gate(self.READ, 15.0))

    def test_the_gated_reading_adds_nothing_to_the_seaweed_or_water_roll_ups(self):
        group = {"cams": [cs.apply_low_sun_gate(self.READ, 1.7, 10)]}
        self.assertIsNone(cs.worst_seaweed(group))
        self.assertIsNone(cs.median_water(group))
        self.assertEqual(cs.busiest_crowd(group)["level"], "quiet")  # crowd still counts

    # --- wiring in capture_beach ------------------------------------------------

    FEED = {"id": "boca-inlet-surf", "name": "Inlet", "source": {"kind": "feed", "base": "http://x", "view": "s16"}}
    LOOK = {"level": "moderate", "coveragePct": 20, "note": "n", "crowd": "quiet", "crowdPct": 5, "people": 3,
            "water": "slightly_murky", "waterPct": 58, "waterNote": "w", "provider": "t"}

    def capture(self, elevation, frame_at="fresh", cam=None):
        seen = []

        def fake_fetch(c, info=None, feed_cache=None):
            if info is not None and frame_at:
                info["frameAt"] = iso_ago(2) if frame_at == "fresh" else frame_at
            return jpeg()

        def fake_elevation(lat, lon, when):
            seen.append((lat, lon, when))
            return elevation

        now = dt.datetime.now(ZONE)
        out = io.StringIO()
        with env(INGEST_TOKEN=None), mock.patch.object(cs, "LOW_SUN_DEG", 10.0), \
                mock.patch.object(cs, "fetch_still", fake_fetch), \
                mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                mock.patch.object(cs, "assess", lambda img: dict(self.LOOK)), \
                mock.patch.object(cs, "solar_elevation_deg", fake_elevation), \
                mock.patch.object(cs.time, "sleep", lambda s: None), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            group = cs.capture_beach("boca-raton", [cam or self.FEED], now, {"called": False}, {})
        return group, seen, out.getvalue(), now

    def test_a_low_sun_frame_publishes_no_seaweed_or_water_but_keeps_crowd(self):
        group, seen, out, _ = self.capture(2.0)
        r = group["cams"][0]
        self.assertIs(r["lowSun"], True)
        self.assertEqual(r["sunElevDeg"], 2.0)
        self.assertIsNone(r["level"])
        self.assertIsNone(r["water"])
        self.assertEqual((r["crowd"], r["people"]), ("quiet", 3))
        self.assertIn("not graded", out)
        self.assertNotIn("unconfirmed", r)  # a low-sun read makes no claim
        # No cam left with a seaweed level: the capture is partial and cannot be a morning.
        self.assertTrue(group["partial"])

    def test_a_high_sun_frame_publishes_normally(self):
        group, _, _, _ = self.capture(40.0)
        r = group["cams"][0]
        self.assertNotIn("lowSun", r)
        self.assertEqual(r["water"], "slightly_murky")

    def test_the_sun_is_judged_at_the_frame_time_and_the_beach_coordinates(self):
        frame_at = iso_ago(7)
        _, seen, _, _ = self.capture(40.0, frame_at=frame_at)
        lat, lon, when = seen[0]  # the per-frame call; the tick-level call follows it
        self.assertEqual((lat, lon), BOCA)  # from the manifest (config/archive-cams.json)
        self.assertEqual(when, dt.datetime.strptime(frame_at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC))

    def test_with_no_frame_time_it_falls_back_to_the_scoring_time(self):
        cam = dict(self.FEED, visionTrustNoTimestamp=True)
        _, seen, _, now = self.capture(40.0, frame_at=None, cam=cam)
        self.assertEqual([w for _, _, w in seen], [now, now])  # per frame, then the tick

    def test_a_beach_without_coordinates_runs_ungated(self):
        with mock.patch.object(cs, "beach_coords", lambda slug: None):
            group, seen, _, _ = self.capture(-5.0)
        self.assertEqual(seen, [])
        self.assertNotIn("lowSun", group["cams"][0])

    def test_beach_coords_reads_the_manifest_by_slug(self):
        self.assertEqual(cs.beach_coords("boca-raton"), BOCA)
        self.assertEqual(cs.beach_coords("deerfield-beach"), (26.3165, -80.0742))
        self.assertIsNone(cs.beach_coords("nowhere"))


class MorningNeedsSeaweedTests(WithManifest):
    """A capture with no seaweed level can never be the day's morning; one with some
    cams lacking a level is partial."""

    NOW = dt.datetime(2026, 10, 13, 8, 30, tzinfo=dt.timezone(dt.timedelta(hours=-4)))

    def doc(self, group, prev=None):
        with mock.patch.object(cs, "MORNING", range(0, 24)):
            return cs.build_beach_output("boca-raton", "America/New_York", self.NOW, [("gemini", "m")],
                                         prev or {}, group, None, None)

    @staticmethod
    def group(hour, *cams, partial=False):
        g = {"capturedAtLocal": f"2026-10-13T{hour:02d}:30-04:00", "hour": hour, "cams": list(cams)}
        if partial:
            g["partial"] = True
        return g

    LOW = {"id": "a", "name": "a", "level": None, "coveragePct": None, "note": None,
           "water": None, "waterPct": None, "waterNote": None, "lowSun": True, "sunElevDeg": 2.0,
           "crowd": "quiet", "crowdPct": 5, "people": 2}
    NONE = {"id": "b", "name": "b", "level": "none", "coveragePct": 0, "crowd": "empty", "crowdPct": 0,
            "people": 0, "water": "clear", "waterPct": 90}

    def test_a_capture_with_no_seaweed_level_never_becomes_the_morning(self):
        doc = self.doc(self.group(7, self.LOW, dict(self.LOW, id="b")))
        self.assertIsNone(doc["morning"])
        self.assertEqual(doc["latest"]["cams"][0]["id"], "a")  # latest still moves (crowd)
        e = doc["history"][-1]
        self.assertEqual((e["seaweed"], e["cov"], e["water"], e["clr"]), (None, None, None, None))
        self.assertEqual(e["level"], "quiet")

    def test_it_does_not_displace_an_existing_morning_either(self):
        first = self.doc(self.group(8, self.NONE))
        again = self.doc(self.group(7, self.LOW), prev=first)
        self.assertEqual(again["morning"], first["morning"])

    def test_a_partial_capture_with_one_level_may_fill_an_empty_morning_and_a_complete_one_replaces_it(self):
        partial = self.group(8, self.LOW, self.NONE, partial=True)
        d1 = self.doc(partial)
        self.assertEqual(d1["morning"], partial)
        complete = self.group(9, dict(self.NONE, id="a"), self.NONE)
        d2 = self.doc(complete, prev=d1)
        self.assertEqual(d2["morning"], complete)
        # ...and a later partial one never takes it back, even if earlier in the day.
        d3 = self.doc(self.group(7, self.LOW, self.NONE, partial=True), prev=d2)
        self.assertEqual(d3["morning"], complete)


class LastSeaweedTests(WithManifest):
    """`lastSeaweed`: today's most recent capture with a published seaweed level, so
    `latest` going dark (low sun) does not blank the seaweed card or score."""

    EDT = dt.timezone(dt.timedelta(hours=-4))
    GATED = {"id": "a", "name": "a", "level": None, "coveragePct": None, "note": None,
             "water": None, "waterPct": None, "waterNote": None, "lowSun": True, "sunElevDeg": 3.0,
             "crowd": "quiet", "crowdPct": 5, "people": 2}
    LOW = {"id": "a", "name": "a", "level": "low", "coveragePct": 8, "crowd": "quiet", "crowdPct": 5,
           "people": 2, "water": "clear", "waterPct": 85}

    def doc(self, day, hour, minute, cams, prev=None):
        now = dt.datetime(2026, 10, day, hour, minute, tzinfo=self.EDT)
        group = None
        if cams is not None:
            group = {"capturedAtLocal": now.isoformat(timespec="minutes"), "hour": hour, "cams": cams}
            if any(c.get("level") is None for c in cams):
                group["partial"] = True
        return cs.build_beach_output("boca-raton", "America/New_York", now, [("gemini", "m")],
                                     prev or {}, group, None, None), group

    def test_a_daylight_capture_is_the_last_seaweed_and_the_latest(self):
        d, g = self.doc(13, 17, 30, [self.LOW])
        self.assertEqual(d["lastSeaweed"], g)
        self.assertEqual(d["latest"], g)

    def test_a_gated_evening_tick_keeps_the_5_30_pm_group_while_latest_moves_on(self):
        d1, g1 = self.doc(13, 17, 30, [self.LOW])
        d2, g2 = self.doc(13, 19, 10, [self.GATED], prev=d1)
        self.assertEqual(d2["latest"], g2)            # crowd keeps moving
        self.assertEqual(d2["lastSeaweed"], g1)       # seaweed stays on the 5:30 PM read

    def test_the_first_gated_tick_of_the_next_morning_drops_yesterdays_reading(self):
        d1, _ = self.doc(13, 17, 30, [self.LOW])
        d2, _ = self.doc(14, 6, 40, [self.GATED], prev=d1)
        self.assertIsNone(d2["lastSeaweed"])
        # ...and so does a morning run with no capture at all.
        d3, _ = self.doc(14, 6, 50, None, prev=d1)
        self.assertIsNone(d3["lastSeaweed"])

    def test_a_fresh_daylight_tick_replaces_it(self):
        d1, g1 = self.doc(13, 12, 0, [self.LOW])
        d2, g2 = self.doc(13, 13, 0, [dict(self.LOW, level="none", coveragePct=0)], prev=d1)
        self.assertEqual(d2["lastSeaweed"], g2)
        self.assertNotEqual(d2["lastSeaweed"], g1)

    def test_a_run_with_no_capture_keeps_todays_value(self):
        d1, g1 = self.doc(13, 17, 30, [self.LOW])
        d2, _ = self.doc(13, 17, 40, None, prev=d1)
        self.assertEqual(d2["lastSeaweed"], g1)

    def test_none_until_a_capture_has_a_seaweed_level(self):
        d, _ = self.doc(13, 6, 40, [self.GATED])
        self.assertIsNone(d["lastSeaweed"])
        self.assertIsNotNone(d["latest"])

    def test_an_old_feed_without_the_field_is_fine(self):
        d, _ = self.doc(13, 19, 10, [self.GATED], prev={"dateLocal": "2026-10-13", "latest": None})
        self.assertIsNone(d["lastSeaweed"])


class JumpConfirmationTests(WithManifest):
    """confirm_seaweed_jumps (pure) and the 2026-10-13 Boca incident replayed through
    capture_beach + build_beach_output. One cam (boca-inlet-surf) read a false
    "moderate 35%" at 1:20 PM while the other two read none all day."""

    def read(self, cid, level="none", cov=0, **kw):
        base = {"id": cid, "name": cid, "level": level, "coveragePct": cov, "note": "n",
                "crowd": "quiet", "crowdPct": 5, "people": 2, "water": "clear", "waterPct": 80}
        return {**base, **kw}

    def confirm(self, fresh, pending=None):
        return cs.confirm_seaweed_jumps(list(fresh), pending or {})

    @staticmethod
    def claim(level="moderate", cov=35, sha="old", frame_at="2026-10-13T16:00:00Z", **kw):
        return {"level": level, "coveragePct": cov, "note": "n", "frameAt": frame_at,
                "frameSha": sha, "claimedAt": frame_at, **kw}

    # --- the pure function -------------------------------------------------------

    def test_a_lone_moderate_with_no_claim_is_held_with_its_claim_kept_for_audit(self):
        a = self.read("a", "moderate", 35)
        (got,) = self.confirm([a])
        self.assertIsNone(got["level"])
        self.assertIsNone(got["coveragePct"])
        self.assertIsNone(got["note"])
        self.assertIs(got["unconfirmed"], True)
        self.assertEqual(got["claim"], {"level": "moderate", "coveragePct": 35, "note": "n"})
        # water and crowd are untouched
        self.assertEqual((got["water"], got["waterPct"], got["crowd"], got["people"]), ("clear", 80, "quiet", 2))
        self.assertNotIn("confirmedBy", got)
        self.assertEqual(a["level"], "moderate")  # input not mutated

    def test_readings_below_moderate_pass_straight_through(self):
        for level in ("none", "low"):
            r = self.read("a", level, 10)
            self.assertIs(self.confirm([r], {"a": self.claim()})[0], r)

    def test_persistence_a_live_claim_from_a_different_frame_confirms(self):
        (got,) = self.confirm([self.read("a", "moderate", 30, frameSha="new")], {"a": self.claim()})
        self.assertEqual((got["level"], got["coveragePct"], got["confirmedBy"]), ("moderate", 30, "persistence"))
        self.assertNotIn("unconfirmed", got)

    def test_persistence_a_confirmed_claim_lets_moderate_to_high_and_back_through(self):
        for before, now in (("moderate", "high"), ("moderate", "moderate"), ("high", "moderate")):
            (got,) = self.confirm([self.read("a", now, 50, frameSha="new")],
                                  {"a": self.claim(before, confirmed=True)})
            self.assertEqual(got["level"], now)
            self.assertEqual(got["confirmedBy"], "persistence")

    def test_the_same_frame_never_confirms_itself(self):
        (got,) = self.confirm([self.read("a", "moderate", 30, frameSha="old")], {"a": self.claim(sha="old")})
        self.assertTrue(got["unconfirmed"])
        # a courier cam has no sha: its frameAt is the identity
        r = self.read("a", "moderate", 30, frameAt="2026-10-13T16:00:00Z")
        c = self.claim(sha=None, frame_at="2026-10-13T16:00:00Z")
        c.pop("frameSha")
        self.assertTrue(self.confirm([r], {"a": c})[0]["unconfirmed"])
        r2 = self.read("a", "moderate", 30, frameAt="2026-10-13T19:00:00Z")
        self.assertEqual(self.confirm([r2], {"a": c})[0]["confirmedBy"], "persistence")

    def test_a_claim_for_another_cam_does_not_confirm_this_one(self):
        self.assertTrue(self.confirm([self.read("a", "moderate", 30, frameSha="new")], {"b": self.claim()})[0]["unconfirmed"])

    def test_two_cams_that_both_claim_moderate_in_one_tick_confirm_each_other(self):
        a, b = self.read("a", "moderate", 30), self.read("b", "high", 55)
        got = self.confirm([a, b])
        self.assertEqual([(g["id"], g["level"], g["confirmedBy"]) for g in got],
                         [("a", "moderate", "cam:b"), ("b", "high", "cam:a")])

    def test_a_none_from_another_fresh_cam_does_not_confirm(self):
        got = self.confirm([self.read("a", "moderate", 30), self.read("b", "none", 0)])
        self.assertTrue(got[0]["unconfirmed"])
        self.assertEqual(got[1]["level"], "none")

    def test_a_fresh_low_sun_cam_does_not_confirm(self):
        low = self.read("b", None, None, lowSun=True, sunElevDeg=3.0)
        self.assertTrue(self.confirm([self.read("a", "moderate", 30), low])[0]["unconfirmed"])

    def test_a_cams_own_pending_claim_is_not_another_cams_corroboration(self):
        # b has a live claim, but b is not read this tick: nothing in this tick confirms a.
        self.assertTrue(self.confirm([self.read("a", "moderate", 30)], {"b": self.claim()})[0]["unconfirmed"])

    def test_confirmation_is_per_cam(self):
        got = self.confirm([self.read("a", "moderate", 30, frameSha="new"), self.read("b", "none", 0)],
                           {"a": self.claim()})
        self.assertEqual(got[0]["confirmedBy"], "persistence")
        self.assertEqual(got[1]["level"], "none")

    # --- the claim's own lifetime: live_pending_claims ---------------------------------

    NOW = dt.datetime(2026, 10, 13, 14, 0, tzinfo=dt.timezone(dt.timedelta(hours=-4)))  # 18:00Z

    def entry(self, minutes_before, **kw):
        t = (self.NOW - dt.timedelta(minutes=minutes_before)).astimezone(UTC)
        return self.claim(frame_at=t.strftime("%Y-%m-%dT%H:%M:%SZ"), **kw)

    def test_a_claim_lives_300_minutes_from_when_it_was_scored(self):
        self.assertEqual(cs.PENDING_CLAIM_MAX_MIN, 300)
        live = cs.live_pending_claims({"a": self.entry(299), "b": self.entry(301), "c": self.entry(180)}, self.NOW)
        self.assertEqual(sorted(live), ["a", "c"])

    def test_a_claim_from_yesterday_does_not_live_even_inside_300_minutes(self):
        just_after_midnight = dt.datetime(2026, 10, 13, 1, 0, tzinfo=self.NOW.tzinfo)
        # a frame at 23:30 local yesterday is 90 minutes old but a different local date
        t = (just_after_midnight - dt.timedelta(minutes=90)).astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.assertEqual(cs.live_pending_claims({"a": self.claim(frame_at=t)}, just_after_midnight), {})

    def test_a_claim_without_a_frame_time_uses_claimedAt_and_junk_is_dropped(self):
        e = self.entry(30)
        e["claimedAt"], e["frameAt"] = e["frameAt"], None
        live = cs.live_pending_claims({"a": e, "b": {"level": "huge"}, "c": "x", "d": {"level": "high"}}, self.NOW)
        self.assertEqual(sorted(live), ["a"])
        self.assertEqual(cs.live_pending_claims(None, self.NOW), {})

    def test_a_three_hour_courier_cam_confirms_on_its_second_distinct_frame(self):
        # Fort Lauderdale: ONE direct cam, a frame about every 3 hours. 180 minutes is past
        # the 150-minute carry limit, so a carried reading would be long gone.
        self.assertLess(cs.DIRECT_FRAME_MAX_AGE_MIN, 180)
        live = cs.live_pending_claims({"ftl": self.entry(180, sha=None)}, self.NOW)
        self.assertIn("ftl", live)
        frame2 = self.read("ftl", "moderate", 40, frameAt=(self.NOW.astimezone(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ"))
        (got,) = self.confirm([frame2], live)
        self.assertEqual((got["level"], got["confirmedBy"]), ("moderate", "persistence"))

    def test_a_claim_older_than_300_minutes_or_from_yesterday_does_not_confirm(self):
        frame = self.read("ftl", "moderate", 40, frameSha="new", frameAt="2026-10-13T18:00:00Z")
        for age in (301, 600):
            live = cs.live_pending_claims({"ftl": self.entry(age)}, self.NOW)
            self.assertTrue(self.confirm([frame], live)[0]["unconfirmed"], age)

    # --- update_pending_claims: what gets stored ---------------------------------------

    def group(self, *cams):
        return {"capturedAtLocal": "2026-10-13T14:00-04:00", "hour": 14, "cams": list(cams)}

    def test_a_held_read_stores_its_claim_with_its_frame_identity(self):
        held = {"id": "a", "name": "a", "level": None, "unconfirmed": True,
                "claim": {"level": "moderate", "coveragePct": 35, "note": "n"},
                "frameAt": "2026-10-13T17:50:00Z", "frameSha": "s1", "scoredAt": "2026-10-13T17:52:00Z"}
        got = cs.update_pending_claims({}, self.group(held), self.NOW)
        self.assertEqual(got["a"], {"level": "moderate", "coveragePct": 35, "note": "n",
                                    "frameAt": "2026-10-13T17:50:00Z", "frameSha": "s1",
                                    "claimedAt": "2026-10-13T17:52:00Z"})

    def test_a_confirmed_read_keeps_a_confirmed_marker_so_a_slow_cam_does_not_flip_flop(self):
        pub = self.read("a", "high", 60, frameAt="2026-10-13T17:50:00Z", frameSha="s2", scoredAt="2026-10-13T17:52:00Z",
                        confirmedBy="persistence")
        got = cs.update_pending_claims({"a": self.claim()}, self.group(pub), self.NOW)
        self.assertEqual((got["a"]["level"], got["a"]["confirmed"], got["a"]["frameSha"]), ("high", True, "s2"))

    def test_a_fresh_read_below_moderate_removes_the_claim(self):
        got = cs.update_pending_claims({"a": self.entry(60)}, self.group(self.read("a", "low", 8, scoredAt="2026-10-13T17:52:00Z")), self.NOW)
        self.assertNotIn("a", got)

    def test_a_low_sun_read_and_a_carried_read_change_nothing(self):
        before = {"a": self.entry(60), "b": self.entry(60)}
        low = self.read("a", None, None, lowSun=True)
        carried_below = self.read("b", "none", 0, carried=True)
        self.assertEqual(sorted(cs.update_pending_claims(before, self.group(low, carried_below), self.NOW)), ["a", "b"])

    def test_expired_claims_are_pruned_and_a_missing_capture_keeps_the_live_ones(self):
        got = cs.update_pending_claims({"a": self.entry(60), "b": self.entry(310)}, None, self.NOW)
        self.assertEqual(sorted(got), ["a"])

    # --- recent_prev_readings: the CARRY age limits (unchanged) ------------------------

    CAM = {"id": "a", "name": "a", "source": {"kind": "feed", "base": "http://x", "view": "s4"}}

    def test_recent_prev_readings_applies_the_carry_age_limits(self):
        now = dt.datetime.now(ZONE)
        fresh = self.read("a", "moderate", frameAt=iso_ago(59))
        stale = self.read("a", "moderate", frameAt=iso_ago(61))
        self.assertIn("a", cs.recent_prev_readings({"latest": {"cams": [fresh]}}, [self.CAM], now))
        self.assertNotIn("a", cs.recent_prev_readings({"latest": {"cams": [stale]}}, [self.CAM], now))
        self.assertNotIn("a", cs.recent_prev_readings({"latest": {"cams": [self.read("a")]}}, [self.CAM], now))
        direct = dict(self.CAM, source={"kind": "direct", "url": "u", "meta": "m"})
        self.assertIn("a", cs.recent_prev_readings({"latest": {"cams": [stale]}}, [direct], now))

    # --- the incident, replayed ------------------------------------------------------

    CAMS = [
        {"id": "boca-inlet-surf", "name": "Inlet", "source": {"kind": "feed", "base": "http://x", "view": "s16"}},
        {"id": "boca-south-surf", "name": "South surf", "source": {"kind": "feed", "base": "http://x", "view": "s11"}},
        {"id": "boca-south", "name": "South", "source": {"kind": "feed", "base": "http://x", "view": "s4"}},
    ]
    NOTHING = {"level": "none", "coveragePct": 0, "crowd": "quiet", "crowdPct": 10, "people": 5,
               "water": "clear", "waterPct": 85, "provider": "t"}
    FALSE_ROCKS = dict(NOTHING, level="moderate", coveragePct=35, note="brown rock shelf")

    def setUp(self):
        super().setUp()
        self.counter = 0
        self.tags = {}

    def tick(self, prev, looks, *, cams=None, ages=None):
        """One tick: looks maps cam id -> reading; a cam not in `looks` keeps its last frame."""
        cams = cams or self.CAMS
        self.counter += 1
        ages = ages or {}

        def fake_fetch(cam, info=None, feed_cache=None):
            info["frameAt"] = iso_ago(ages.get(cam["id"], 2))
            if cam["id"] in looks:
                self.tags[cam["id"]] = self.counter  # a new frame; the others re-serve the old one
            return jpeg() + f"{cam['id']}:{self.tags[cam['id']]}".encode()

        def fake_assess(img):
            return dict(looks[img[len(jpeg()):].decode().split(":")[0]])

        now = dt.datetime.now(ZONE)
        out = io.StringIO()
        with env(INGEST_TOKEN=None), mock.patch.object(cs, "fetch_still", fake_fetch), \
                mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                mock.patch.object(cs, "assess", fake_assess), mock.patch.object(cs.time, "sleep", lambda s: None), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            group = cs.capture_beach("boca-raton", cams, now, {"called": False}, prev)
        doc = cs.build_beach_output("boca-raton", "America/New_York", now, [("gemini", "m")], prev, group, None, None)
        self.log = out.getvalue()
        return group, doc

    def all_none(self):
        return {c["id"]: self.NOTHING for c in self.CAMS}

    def test_replay_one_bad_moderate_between_none_reads_never_reaches_the_headline_or_history(self):
        _, doc = self.tick({}, self.all_none())
        # 1:20 PM: the inlet cam alone reads the rock shelf as moderate seaweed.
        group, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        held = next(c for c in group["cams"] if c["id"] == "boca-inlet-surf")
        self.assertIsNone(held["level"])
        self.assertEqual(held["claim"]["level"], "moderate")
        self.assertIn("boca-inlet-surf: seaweed=moderate(35%) HELD (unconfirmed jump)", self.log)
        self.assertEqual(cs.worst_seaweed(group)["level"], "none")  # the others' none reads win
        self.assertEqual(doc["history"][-1]["seaweed"], "none")
        self.assertEqual(doc["history"][-1]["cov"], 0)
        # 1:30 PM: the cam reads none again; the claim is gone and nothing was ever published.
        group, doc = self.tick(doc, {"boca-inlet-surf": self.NOTHING})
        self.assertEqual(next(c for c in group["cams"] if c["id"] == "boca-inlet-surf")["level"], "none")
        self.assertNotIn("moderate", [e["seaweed"] for e in doc["history"]])
        self.assertFalse(any(c.get("level") == "moderate" for c in doc["latest"]["cams"]))

    def test_replay_the_held_claim_survives_a_tick_where_the_cam_frame_is_unchanged(self):
        _, doc = self.tick({}, self.all_none())
        _, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        # Next tick another cam changes, the inlet frame is the same: it is carried, still held.
        group, doc = self.tick(doc, {"boca-south": self.NOTHING})
        carried = next(c for c in group["cams"] if c["id"] == "boca-inlet-surf")
        self.assertTrue(carried["carried"])
        self.assertTrue(carried["unconfirmed"])
        self.assertIsNone(carried["level"])
        self.assertEqual(cs.worst_seaweed(group)["level"], "none")

    def test_replay_two_consecutive_moderate_reads_from_the_same_cam_publish_on_the_second(self):
        _, doc = self.tick({}, self.all_none())
        _, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        self.assertEqual(doc["history"][-1]["seaweed"], "none")
        group, doc = self.tick(doc, {"boca-inlet-surf": dict(self.FALSE_ROCKS, coveragePct=30)})
        pub = next(c for c in group["cams"] if c["id"] == "boca-inlet-surf")
        self.assertEqual((pub["level"], pub["coveragePct"], pub["confirmedBy"]), ("moderate", 30, "persistence"))
        self.assertNotIn("unconfirmed", pub)
        self.assertEqual(doc["history"][-1]["seaweed"], "moderate")
        self.assertEqual(doc["history"][-1]["cov"], 30)
        self.assertEqual(cs.worst_seaweed(doc["latest"]), {"level": "moderate", "pct": 30})

    def test_replay_two_cams_claiming_moderate_in_one_tick_publish_immediately(self):
        _, doc = self.tick({}, self.all_none())
        group, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS,
                                     "boca-south-surf": dict(self.FALSE_ROCKS, coveragePct=25)})
        by = {c["id"]: c for c in group["cams"]}
        self.assertEqual(by["boca-inlet-surf"]["confirmedBy"], "cam:boca-south-surf")
        self.assertEqual(by["boca-south-surf"]["confirmedBy"], "cam:boca-inlet-surf")
        self.assertEqual(doc["history"][-1]["seaweed"], "moderate")

    def skip_near_midnight(self, minutes):
        """The claim lifetime is bounded by the beach-local date; these tests age claims
        on the real clock, so skip in the first hours after local midnight."""
        now = dt.datetime.now(ZONE)
        if (now - dt.timedelta(minutes=minutes)).date() != now.date():
            self.skipTest("the aged frame would fall on yesterday's local date")

    def test_a_claim_older_than_300_minutes_does_not_confirm(self):
        _, doc = self.tick({}, self.all_none())
        _, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        doc["pendingClaims"]["boca-inlet-surf"]["frameAt"] = iso_ago(310)
        doc["pendingClaims"]["boca-inlet-surf"]["claimedAt"] = iso_ago(310)
        group, _ = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        self.assertTrue(next(c for c in group["cams"] if c["id"] == "boca-inlet-surf")["unconfirmed"])

    def test_a_claim_outlives_the_carried_reading_and_still_confirms(self):
        self.skip_near_midnight(100)
        _, doc = self.tick({}, self.all_none())
        _, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        # 100 minutes on: the held reading is past the 60-minute carry limit (it would not
        # be carried any more), but its claim is alive, so the next different frame confirms.
        doc["pendingClaims"]["boca-inlet-surf"]["frameAt"] = iso_ago(100)
        doc["pendingClaims"]["boca-inlet-surf"]["claimedAt"] = iso_ago(98)
        for c in doc["latest"]["cams"]:
            c["frameAt"] = iso_ago(100)
        group, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        pub = next(c for c in group["cams"] if c["id"] == "boca-inlet-surf")
        self.assertEqual((pub["level"], pub["confirmedBy"]), ("moderate", "persistence"))
        self.assertTrue(doc["pendingClaims"]["boca-inlet-surf"]["confirmed"])

    def test_pending_claims_are_stored_confirmed_then_cleared_by_a_clean_read(self):
        _, doc = self.tick({}, self.all_none())
        self.assertEqual(doc["pendingClaims"], {})
        _, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        held = doc["pendingClaims"]["boca-inlet-surf"]
        self.assertEqual((held["level"], held["coveragePct"], held.get("confirmed")), ("moderate", 35, None))
        self.assertTrue(held["frameSha"] and held["frameAt"] and held["claimedAt"])
        _, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        self.assertTrue(doc["pendingClaims"]["boca-inlet-surf"]["confirmed"])
        _, doc = self.tick(doc, {"boca-inlet-surf": self.NOTHING})
        self.assertNotIn("boca-inlet-surf", doc["pendingClaims"])

    def test_a_run_with_no_fresh_capture_keeps_the_live_claims(self):
        _, doc = self.tick({}, self.all_none())
        _, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        now = dt.datetime.now(ZONE)
        again = cs.build_beach_output("boca-raton", "America/New_York", now, [("gemini", "m")], doc, None, None, None)
        self.assertEqual(again["pendingClaims"], doc["pendingClaims"])

    def test_a_carried_confirmed_cam_no_longer_confirms_a_fresh_false_high(self):
        # Codex P1: a stale confirmed moderate on cam B used to publish a fresh false "high" from A.
        _, doc = self.tick({}, self.all_none())
        _, doc = self.tick(doc, {"boca-south-surf": self.FALSE_ROCKS})
        _, doc = self.tick(doc, {"boca-south-surf": self.FALSE_ROCKS})  # B confirmed (persistence)
        self.assertEqual(next(c for c in doc["latest"]["cams"] if c["id"] == "boca-south-surf")["level"], "moderate")
        group, doc = self.tick(doc, {"boca-inlet-surf": dict(self.FALSE_ROCKS, level="high", coveragePct=70)})
        by = {c["id"]: c for c in group["cams"]}
        self.assertTrue(by["boca-south-surf"]["carried"])
        self.assertEqual(by["boca-south-surf"]["level"], "moderate")  # still in the roll-up
        self.assertTrue(by["boca-inlet-surf"]["unconfirmed"])         # but it confirms nothing
        self.assertIsNone(by["boca-inlet-surf"]["level"])

    def test_a_held_read_still_records_its_frame_so_the_same_frame_is_not_scored_twice(self):
        _, doc = self.tick({}, self.all_none())
        _, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        self.assertEqual(doc["frameShas"]["boca-inlet-surf"], cs.frame_sha(jpeg() + b"boca-inlet-surf:2"))

    def test_a_held_cam_makes_the_capture_partial_for_the_morning_rules(self):
        _, doc = self.tick({}, self.all_none())
        group, _ = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        self.assertTrue(group["partial"])

    def test_the_cam_read_row_for_a_held_cam_keeps_the_claim_in_its_raw_json(self):
        # lib/history/camObservationRow.mjs: null seaweed fields, but the audit trail survives.
        import subprocess
        _, doc = self.tick({}, self.all_none())
        group, _ = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS})
        held = next(c for c in group["cams"] if c["id"] == "boca-inlet-surf")
        js = ("import {camReadRow} from './lib/history/camObservationRow.mjs';"
              "const [g,c]=JSON.parse(process.argv[1]);"
              "console.log(JSON.stringify(camReadRow('boca-raton',g,c)));")
        try:
            out = subprocess.run(["node", "--input-type=module", "-e", js, json.dumps([group, held])],
                                 cwd=ROOT, capture_output=True, text=True)
        except FileNotFoundError:
            self.skipTest("node not available")
        self.assertEqual(out.returncode, 0, out.stderr[:300])
        row = json.loads(out.stdout)
        self.assertIsNone(row["seaweed_level"])
        self.assertIsNone(row["cov_pct"])
        self.assertEqual(row["crowd_level"], "quiet")
        self.assertEqual(json.loads(row["raw_json"])["claim"]["level"], "moderate")



class CourierCadenceTests(WithManifest):
    """Fort Lauderdale has ONE direct (courier) cam read about every 3 hours: nothing
    else can corroborate it, and its held claim must outlive a carried reading."""

    CAM = {"id": "ftl-elbo-beach-cam", "name": "Elbo",
           "source": {"kind": "direct", "url": "https://u/frame", "meta": "https://u/meta"}}
    LOOK = {"level": "moderate", "coveragePct": 40, "note": "n", "crowd": "quiet", "crowdPct": 5, "people": 2,
            "water": "clear", "waterPct": 80, "provider": "t"}

    def read(self, prev, grabbed_min_ago=5):
        grabbed = iso_ago(grabbed_min_ago)

        def fake_get(url, timeout=25):
            return json.dumps({"ok": True, "grabbedAtUtc": grabbed}).encode()

        now = dt.datetime.now(ZONE)
        with env(INGEST_TOKEN=None), mock.patch.object(cs, "_get", fake_get), \
                mock.patch.object(cs, "fetch_still", lambda cam, info=None, feed_cache=None: jpeg()), \
                mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                mock.patch.object(cs, "assess", lambda img: dict(self.LOOK)), \
                mock.patch.object(cs.time, "sleep", lambda s: None), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            group = cs.capture_beach("fort-lauderdale", [self.CAM], now, {"called": False}, prev)
        doc = cs.build_beach_output("fort-lauderdale", "America/New_York", now, [("gemini", "m")], prev, group, None, None)
        return group, doc

    def skip_near_midnight(self, minutes):
        now = dt.datetime.now(ZONE)
        if (now - dt.timedelta(minutes=minutes)).date() != now.date():
            self.skipTest("the aged frame would fall on yesterday's local date")

    def prev_with_claim(self, minutes_ago):
        return {"dateLocal": dt.datetime.now(ZONE).date().isoformat(),
                "pendingClaims": {self.CAM["id"]: {
                    "level": "moderate", "coveragePct": 40, "note": "n",
                    "frameAt": iso_ago(minutes_ago), "claimedAt": iso_ago(minutes_ago - 2)}}}

    def test_the_first_frame_is_held_and_its_claim_is_stored_with_the_frame_time(self):
        group, doc = self.read({})
        self.assertTrue(group["cams"][0]["unconfirmed"])
        self.assertEqual(doc["pendingClaims"][self.CAM["id"]]["level"], "moderate")
        self.assertTrue(doc["pendingClaims"][self.CAM["id"]]["frameAt"])

    def test_three_hours_later_the_second_distinct_frame_confirms(self):
        self.skip_near_midnight(185)
        self.assertGreater(180, cs.DIRECT_FRAME_MAX_AGE_MIN)  # a carried reading would be long gone
        group, doc = self.read(self.prev_with_claim(180))
        r = group["cams"][0]
        self.assertEqual((r["level"], r["confirmedBy"]), ("moderate", "persistence"))
        self.assertTrue(doc["pendingClaims"][self.CAM["id"]]["confirmed"])
        self.assertEqual(cs.worst_seaweed(doc["latest"]), {"level": "moderate", "pct": 40})

    def test_a_claim_older_than_300_minutes_does_not_confirm(self):
        group, _ = self.read(self.prev_with_claim(310))
        self.assertTrue(group["cams"][0]["unconfirmed"])

    def test_courier_frames_180_minutes_apart_each_read_late_still_confirm(self):
        # Codex round 2: each courier frame can be read up to DIRECT_FRAME_MAX_AGE_MIN (150)
        # minutes after it was taken. Frame 1 taken 330 minutes ago, read 61 minutes later
        # (claimedAt 269 minutes ago). Frame 2 is 180 minutes newer and 149 minutes old when
        # read. A frame-time clock of 240 would have lapsed (330 > 240); claimedAt does not (269).
        self.skip_near_midnight(335)
        prev = self.prev_with_claim(330)
        prev["pendingClaims"][self.CAM["id"]]["claimedAt"] = iso_ago(269)
        group, doc = self.read(prev, grabbed_min_ago=149)
        r = group["cams"][0]
        self.assertEqual((r["level"], r["confirmedBy"]), ("moderate", "persistence"))
        self.assertTrue(doc["pendingClaims"][self.CAM["id"]]["confirmed"])

    def test_a_claim_from_yesterday_does_not_confirm(self):
        group, _ = self.read(self.prev_with_claim(24 * 60))
        self.assertTrue(group["cams"][0]["unconfirmed"])


class TickLowSunTests(WithManifest):
    """Tick-level low-sun gate: Codex's mixed fresh/carried example, both permutations.
    17:30 cam A moderate (confirmed) and B none; at 17:50 one cam refreshes below 10
    degrees and the other is carried. Neither the roll-up nor history may record a new
    seaweed value, and lastSeaweed must stay the 17:30 group."""

    CAMS = JumpConfirmationTests.CAMS
    NOTHING = JumpConfirmationTests.NOTHING
    FALSE_ROCKS = JumpConfirmationTests.FALSE_ROCKS
    tick = JumpConfirmationTests.tick
    all_none = JumpConfirmationTests.all_none

    def setUp(self):
        super().setUp()
        self.counter = 0
        self.tags = {}
        self.elev = 40.0
        for p in (mock.patch.object(cs, "LOW_SUN_DEG", 10.0),
                  mock.patch.object(cs, "solar_elevation_deg", lambda lat, lon, when: self.elev)):
            p.start()
            self.addCleanup(p.stop)

    def evening_state(self):
        """After the 17:30 tick: A (inlet) confirmed moderate, B (south surf) none."""
        two = self.CAMS[:2]
        _, doc = self.tick({}, {"boca-inlet-surf": self.NOTHING, "boca-south-surf": self.NOTHING}, cams=two)
        _, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS}, cams=two)
        group, doc = self.tick(doc, {"boca-inlet-surf": self.FALSE_ROCKS}, cams=two)
        self.assertEqual(doc["lastSeaweed"], group)
        self.assertEqual(cs.worst_seaweed(group)["level"], "moderate")
        return group, doc

    def check_dusk_tick(self, refreshed):
        evening, doc = self.evening_state()
        n_history = len(doc["history"])
        self.elev = 5.0  # 17:50: the sun is now under 10 degrees
        group, doc = self.tick(doc, {refreshed: self.NOTHING}, cams=self.CAMS[:2])
        by = {c["id"]: c for c in group["cams"]}
        self.assertEqual(set(by), {"boca-inlet-surf", "boca-south-surf"})
        for c in by.values():
            self.assertIsNone(c["level"])
            self.assertIsNone(c["water"])
            self.assertTrue(c["lowSun"])
            self.assertEqual(c["crowd"], "quiet")
        self.assertTrue(any(c.get("carried") for c in by.values()))  # one is carried, and gated too
        self.assertEqual(doc["lastSeaweed"], evening)               # the 17:30 group stays
        self.assertEqual(doc["latest"], group)                      # crowd keeps moving
        self.assertEqual(len(doc["history"]), n_history + 1)
        last = doc["history"][-1]
        self.assertEqual((last["seaweed"], last["cov"], last["water"], last["clr"]), (None, None, None, None))
        self.assertEqual(last["level"], "quiet")
        self.assertIn("tick at low sun", self.log)

    def test_the_moderate_cam_is_refreshed_below_ten_degrees_while_the_clean_cam_is_carried(self):
        self.check_dusk_tick("boca-inlet-surf")

    def test_the_clean_cam_is_refreshed_below_ten_degrees_while_the_moderate_cam_is_carried(self):
        self.check_dusk_tick("boca-south-surf")

    def test_a_gated_tick_does_not_clear_a_stored_claim(self):
        _, doc = self.evening_state()
        self.elev = 5.0
        _, doc = self.tick(doc, {"boca-inlet-surf": self.NOTHING}, cams=self.CAMS[:2])
        self.assertTrue(doc["pendingClaims"]["boca-inlet-surf"]["confirmed"])  # no new evidence at low sun

    def test_above_the_threshold_nothing_is_gated(self):
        _, doc = self.evening_state()
        group, _ = self.tick(doc, {"boca-south-surf": self.NOTHING}, cams=self.CAMS[:2])
        self.assertFalse(any(c.get("lowSun") for c in group["cams"]))


class LastWaterTests(WithManifest):
    """`lastWater`: today's newest capture where some cam has a valid water grade,
    independent of `lastSeaweed` (their validity diverges)."""

    EDT = dt.timezone(dt.timedelta(hours=-4))
    HELD = {"id": "a", "name": "a", "level": None, "coveragePct": None, "note": None, "unconfirmed": True,
            "claim": {"level": "moderate", "coveragePct": 30, "note": "n"},
            "water": "clear", "waterPct": 85, "waterNote": "w", "crowd": "quiet", "crowdPct": 5, "people": 2}
    NO_WATER = {"id": "a", "name": "a", "level": "low", "coveragePct": 8, "water": None, "waterPct": None,
                "crowd": "quiet", "crowdPct": 5, "people": 2}
    BOTH = {"id": "a", "name": "a", "level": "none", "coveragePct": 0, "water": "clear", "waterPct": 80,
            "crowd": "quiet", "crowdPct": 5, "people": 2}

    def doc(self, day, hour, minute, cams, prev=None):
        now = dt.datetime(2026, 10, day, hour, minute, tzinfo=self.EDT)
        group = None
        if cams is not None:
            group = {"capturedAtLocal": now.isoformat(timespec="minutes"), "hour": hour, "cams": cams}
        return cs.build_beach_output("boca-raton", "America/New_York", now, [("gemini", "m")],
                                     prev or {}, group, None, None), group

    def test_a_held_seaweed_claim_with_a_good_water_read_advances_lastWater_but_not_lastSeaweed(self):
        d1, g1 = self.doc(13, 12, 0, [self.BOTH])
        d2, g2 = self.doc(13, 13, 0, [self.HELD], prev=d1)
        self.assertEqual(d2["lastWater"], g2)
        self.assertEqual(d2["lastSeaweed"], g1)

    def test_a_seaweed_valid_capture_with_no_open_water_does_not_overwrite_lastWater(self):
        d1, g1 = self.doc(13, 12, 0, [self.BOTH])
        d2, g2 = self.doc(13, 13, 0, [self.NO_WATER], prev=d1)
        self.assertEqual(d2["lastSeaweed"], g2)
        self.assertEqual(d2["lastWater"], g1)

    def test_yesterdays_water_is_dropped_and_a_no_capture_run_keeps_todays(self):
        d1, g1 = self.doc(13, 17, 30, [self.BOTH])
        self.assertIsNone(self.doc(14, 6, 40, [self.NO_WATER], prev=d1)[0]["lastWater"])
        self.assertIsNone(self.doc(14, 6, 50, None, prev=d1)[0]["lastWater"])
        self.assertEqual(self.doc(13, 17, 40, None, prev=d1)[0]["lastWater"], g1)

    def test_none_until_a_capture_has_a_water_grade(self):
        d, _ = self.doc(13, 6, 40, [self.NO_WATER])
        self.assertIsNone(d["lastWater"])
        self.assertIsNotNone(d["lastSeaweed"])


class MorningWindowTests(WithManifest):
    """The day's `morning`: among captures from 5 AM to 12 PM with a published seaweed
    level, the one with MORE seaweed-level cams, tie -> earlier."""

    EDT = dt.timezone(dt.timedelta(hours=-4))

    def lvl(self, cid, level="none"):
        return {"id": cid, "name": cid, "level": level, "coveragePct": 0, "crowd": "quiet", "crowdPct": 5, "people": 1}

    def gated(self, cid):
        return {"id": cid, "name": cid, "level": None, "coveragePct": None, "lowSun": True,
                "crowd": "quiet", "crowdPct": 5, "people": 1}

    def doc(self, hour, cams, prev=None, minute=0):
        now = dt.datetime(2026, 1, 15, hour, minute, tzinfo=dt.timezone(dt.timedelta(hours=-5)))
        group = {"capturedAtLocal": now.isoformat(timespec="minutes"), "hour": hour, "cams": cams}
        return cs.build_beach_output("fort-lauderdale", "America/New_York", now, [("gemini", "m")],
                                     prev or {}, group, None, None), group

    def test_the_window_is_five_to_noon(self):
        self.assertEqual((cs.MORNING.start, cs.MORNING.stop, cs.MORNING_END_HOUR), (5, 12, 12))

    def test_winter_courier_8am_gated_11am_usable_becomes_the_morning(self):
        d1, _ = self.doc(8, [self.gated("c")])
        self.assertIsNone(d1["morning"])
        d2, g2 = self.doc(11, [self.lvl("c")], prev=d1)
        self.assertEqual(d2["morning"], g2)

    def test_a_capture_at_noon_is_too_late(self):
        d, _ = self.doc(12, [self.lvl("c")])
        self.assertIsNone(d["morning"])

    def test_a_held_partial_morning_is_replaced_by_a_later_capture_with_more_seaweed_cams(self):
        d1, g1 = self.doc(8, [self.lvl("a"), self.gated("b"), self.gated("c")])
        self.assertEqual(d1["morning"], g1)
        d2, g2 = self.doc(10, [self.lvl("a"), self.lvl("b"), self.gated("c")], prev=d1)
        self.assertEqual(d2["morning"], g2)
        # one fewer, or equal and later, never takes it back
        d3, _ = self.doc(11, [self.lvl("a"), self.gated("b"), self.gated("c")], prev=d2)
        self.assertEqual(d3["morning"], g2)
        d4, _ = self.doc(11, [self.lvl("a"), self.lvl("b"), self.gated("c")], prev=d2)
        self.assertEqual(d4["morning"], g2)

    def test_a_tie_goes_to_the_earlier_capture_and_never_to_a_zero_level_capture(self):
        d1, g1 = self.doc(9, [self.lvl("a"), self.lvl("b")])
        d2, _ = self.doc(7, [self.gated("a"), self.gated("b")], prev=d1)
        self.assertEqual(d2["morning"], g1)
        d3, g3 = self.doc(6, [self.lvl("a"), self.lvl("b")], prev=d1)
        self.assertEqual(d3["morning"], g3)  # equal count, earlier hour wins


class VisionHintTests(WithManifest):
    """prompt_for_cam: the optional per-cam visionHint rides on PROMPT."""

    HINT = "Dark rock shelf at the left is not seaweed."

    def test_no_hint_means_the_plain_prompt(self):
        self.assertEqual(cs.prompt_for_cam({"id": "a"}), cs.PROMPT)
        self.assertEqual(cs.prompt_for_cam({"id": "a", "visionHint": "  "}), cs.PROMPT)
        self.assertEqual(cs.prompt_for_cam({"id": "a", "visionHint": 5}), cs.PROMPT)

    def test_a_hint_is_appended_as_an_about_this_camera_line(self):
        p = cs.prompt_for_cam({"id": "a", "visionHint": f"  {self.HINT} "})
        self.assertTrue(p.startswith(cs.PROMPT))
        self.assertTrue(p.endswith(f" About this camera: {self.HINT}"))

    def test_the_registry_hint_for_the_inlet_surf_cam_exists_and_is_plain(self):
        reg = json.loads((ROOT / "config" / "vision-cams.json").read_text(encoding="utf-8"))
        cam = next(c for c in reg["boca-raton"]["cams"] if c["id"] == "boca-inlet-surf")
        self.assertIn("rock shelf", cam["visionHint"])
        self.assertIn("not seaweed", cam["visionHint"])
        self.assertNotRegex(cam["visionHint"], r"\bAI\b")
        for other in reg["boca-raton"]["cams"]:
            if other["id"] != "boca-inlet-surf":
                self.assertNotIn("visionHint", other)

    def capture(self, cam):
        prompts = []

        def fake_assess(img, prompt=cs.PROMPT):
            prompts.append(prompt)
            return {"level": "none", "coveragePct": 0, "crowd": "quiet", "crowdPct": 5, "people": 2, "provider": "t"}

        def fake_fetch(c, info=None, feed_cache=None):
            info["frameAt"] = iso_ago(2)
            return jpeg()

        with env(INGEST_TOKEN=None), mock.patch.object(cs, "fetch_still", fake_fetch), \
                mock.patch.object(cs, "archive_frame", lambda *a, **k: "stored"), \
                mock.patch.object(cs, "assess", fake_assess), mock.patch.object(cs.time, "sleep", lambda s: None), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            cs.capture_beach("boca-raton", [cam], dt.datetime.now(ZONE), {"called": False}, {})
        return prompts

    def test_capture_beach_sends_the_hinted_prompt_only_for_a_cam_with_a_hint(self):
        base = {"id": "a", "name": "a", "source": {"kind": "feed", "base": "http://x", "view": "s4"}}
        self.assertEqual(self.capture(base), [cs.PROMPT])
        (hinted,) = self.capture(dict(base, visionHint=self.HINT))
        self.assertIn(f"About this camera: {self.HINT}", hinted)

    def test_gemini_gets_the_hint_in_its_request_and_clef_is_left_alone(self):
        prompt = cs.prompt_for_cam({"visionHint": self.HINT})
        bodies = []

        def fake_post(url, body, headers=None, timeout=40):
            bodies.append(json.loads(body))
            return json.dumps({"candidates": [{"content": {"parts": [{"text": json.dumps(
                {"seaweed": "none", "crowd": "quiet"})}]}}]}).encode()

        with mock.patch.object(cs, "API_KEY", "k"), mock.patch.object(cs, "_post", fake_post):
            cs.assess_with("gemini", b"x", prompt, model="g-1")
        self.assertIn(self.HINT, bodies[0]["contents"][0]["parts"][0]["text"])

        clef_calls = []
        with mock.patch.object(cs, "_clef_configured", lambda: True), \
                mock.patch.object(cs, "_clef_out", lambda img, kind="surface": clef_calls.append(kind) or {"seaweed": "none"}):
            cs.assess_with("clef", b"x", prompt)
        self.assertEqual(clef_calls, ["surface"])  # no prompt parameter: Clef's questions are fixed server-side


ZONE = __import__("zoneinfo").ZoneInfo("America/New_York")

if __name__ == "__main__":
    unittest.main()
