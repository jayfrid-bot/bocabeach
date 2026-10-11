"""Unit tests for the webcam-archive half of scripts/cam_seaweed.py. Run from
the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

No network, no ffmpeg, no vision providers: every outside call is patched.
"""

import contextlib
import datetime as dt
import io
import json
import os
import re
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
    self.filled_calls records every beach asked about."""

    def setUp(self):
        self.filled_by_slug = {}
        self.filled_calls = []

        def fake_filled(slug):
            self.filled_calls.append(slug)
            return self.filled_by_slug.get(slug, {})

        for p in (mock.patch.object(cs, "ARCHIVE_CAMS_PATH", str(MANIFEST_PATH)),
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

    def run_capture(self, slug, cams, *, assess=None, frame_at_info=None, meta=None, token="tok", attempted=None, archive=None):
        order = []

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
            mock.patch.object(cs.time, "sleep", lambda s: None),
        ]
        with env(INGEST_TOKEN=token), contextlib.ExitStack() as st, \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            for p in patches:
                st.enter_context(p)
            result = cs.capture_beach(slug, cams, now, {"called": False}, {}, attempted, archive)
        return result, order

    def test_order_is_fetch_then_assess_then_the_upload(self):
        # The read never waits for the upload: the still is queued and uploaded
        # after the beach's reads.
        result, order = self.run_capture("boca-raton", [self.FEED_CAM], frame_at_info=iso_ago(5))
        self.assertEqual(order[:2], ["fetch", "assess"])
        self.assertEqual(order[2][:3], ("archive", "boca-raton", "boca-south"))
        self.assertEqual(len(order), 3)
        self.assertEqual(len(result["cams"]), 1)

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
        with env(INGEST_TOKEN="tok"), mock.patch.object(cs, "fetch_still", lambda cam, info=None, feed_cache=None: jpeg()), \
                mock.patch.object(cs, "archive_frame", slow_archive), \
                mock.patch.object(cs, "assess", lambda img: reads.append(time.monotonic()) or {"level": "none", "provider": "t"}), \
                mock.patch.object(cs.time, "sleep", lambda s: None), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            cs.capture_beach("boca-raton", [self.FEED_CAM], dt.datetime.now(ZONE), {"called": False}, {})
        self.assertEqual(len(reads), 1)
        self.assertLessEqual(reads[0], started["t"])  # the read ran before the upload began

    def test_cams_whose_hour_is_already_filled_are_read_but_not_uploaded(self):
        run = cs.ArchiveRun()
        run.filled = {"boca-raton": {cs._slot_utc_of(None): {"boca-south"}}}
        with env(INGEST_TOKEN="tok"):
            result, order = self.run_capture("boca-raton", [self.FEED_CAM], archive=run)
        self.assertEqual(order, ["fetch", "assess"])
        self.assertEqual(len(result["cams"]), 1)

    def test_a_filled_slot_is_judged_by_the_frames_own_hour(self):
        # The cam's CURRENT hour is filled, but this frame is from the hour before: still uploaded.
        run = cs.ArchiveRun()
        old = iso_ago(70)
        run.filled = {"boca-raton": {cs._slot_utc_of(None): {"boca-south"}}}
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
        with mock.patch.object(cs, "API_KEY", ""), \
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


class FetchFilledSlotsTests(unittest.TestCase):
    def call(self, answer=None, token="tok-unit", exc=None):
        urlopen = mock.Mock(side_effect=exc) if exc else mock.Mock(return_value=FakeResponse(answer))
        with env(INGEST_TOKEN=token), mock.patch.object(cs.urllib.request, "urlopen", urlopen), \
                contextlib.redirect_stderr(io.StringIO()):
            return cs.fetch_filled_slots("boca-raton"), urlopen

    def test_sends_an_authenticated_get_and_parses_the_slots(self):
        got, urlopen = self.call({"ok": True, "slots": {"2026-10-11T14:00:00.000Z": ["boca-south", "boca-inlet"], "2026-10-11T13:00:00.000Z": []}})
        self.assertEqual(got, {"2026-10-11T14:00:00.000Z": {"boca-south", "boca-inlet"}, "2026-10-11T13:00:00.000Z": set()})
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
        with mock.patch.object(cs, "_slot_utc_of", lambda fa=None: "SLOT-FILLED" if fa == stamp else "SLOT-NOW"):
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


ZONE = __import__("zoneinfo").ZoneInfo("America/New_York")

if __name__ == "__main__":
    unittest.main()
