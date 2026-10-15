"""Unit tests for scripts/quality_watch.py, the cam reader's half of the data-quality
loop. Run from the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

No network: urlopen is patched.
"""

import base64
import contextlib
import datetime as dt
import io
import json
import os
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import quality_watch as qw  # noqa: E402


class PickSecondProviderTests(unittest.TestCase):
    BOTH = {"gemini", "clef", "groq", "openrouter"}

    def test_claims_from_the_free_models_go_to_clef(self):
        for claim in ("gemini", "groq", "openrouter", "github", None):
            self.assertEqual(qw.pick_second_provider(claim, self.BOTH), "clef", claim)

    def test_a_claim_from_clef_goes_to_gemini(self):
        self.assertEqual(qw.pick_second_provider("clef", self.BOTH), "gemini")

    def test_skip_when_the_other_provider_is_not_configured(self):
        self.assertIsNone(qw.pick_second_provider("gemini", {"gemini", "groq"}))
        self.assertIsNone(qw.pick_second_provider("clef", {"clef", "groq"}))
        self.assertIsNone(qw.pick_second_provider("gemini", set()))

    def test_never_the_claims_own_provider(self):
        for claim in ("gemini", "clef", "groq"):
            self.assertNotEqual(qw.pick_second_provider(claim, self.BOTH), claim)


class AgreeTests(unittest.TestCase):
    def test_only_moderate_and_high_back_a_jump(self):
        self.assertTrue(qw.agrees("moderate"))
        self.assertTrue(qw.agrees("high"))
        for level in ("none", "low", None, "unknown", ""):
            self.assertFalse(qw.agrees(level), level)


class ConfirmedBySecondOpinionTests(unittest.TestCase):
    HELD = {"id": "a", "name": "A", "level": None, "coveragePct": None, "note": None, "crowd": "quiet",
            "water": "clear", "provider": "gemini", "unconfirmed": True,
            "claim": {"level": "moderate", "coveragePct": 35, "note": "rock?"}}

    def test_the_claim_is_published_and_the_hold_marks_are_gone(self):
        out = qw.confirmed_by_second_opinion(self.HELD, {"provider": "clef", "level": "moderate"})
        self.assertEqual((out["level"], out["coveragePct"], out["note"]), ("moderate", 35, "rock?"))
        self.assertEqual(out["confirmedBy"], "second-opinion:clef")
        self.assertNotIn("unconfirmed", out)
        self.assertNotIn("claim", out)
        self.assertEqual((out["crowd"], out["water"], out["id"]), ("quiet", "clear", "a"))

    def test_the_input_is_not_changed(self):
        before = json.dumps(self.HELD, sort_keys=True)
        qw.confirmed_by_second_opinion(self.HELD, {"provider": "clef"})
        self.assertEqual(json.dumps(self.HELD, sort_keys=True), before)


class OtherCamsTests(unittest.TestCase):
    def test_lists_only_other_cams_that_have_a_published_level(self):
        cams = [
            {"id": "a", "name": "A", "level": None, "unconfirmed": True},
            {"id": "b", "name": "B", "level": "none", "coveragePct": 0},
            {"id": "c", "name": "C", "level": "low", "coveragePct": 12, "carried": True},
            {"id": "d", "name": "D", "level": None, "lowSun": True},
            {"id": "e", "level": "high", "coveragePct": 70},
        ]
        got = qw.other_cams(cams, "a")
        self.assertEqual([o["id"] for o in got], ["b", "c", "e"])
        self.assertEqual(got[1], {"id": "c", "name": "C", "level": "low", "coveragePct": 12, "carried": True})
        self.assertEqual(got[2]["name"], "e")  # falls back to the id
        self.assertFalse(got[0]["carried"])

    def test_a_cam_is_never_listed_among_its_own_others(self):
        self.assertEqual(qw.other_cams([{"id": "a", "level": "none"}], "a"), [])


class BuildAlertTests(unittest.TestCase):
    def test_body_has_everything_the_review_screen_needs(self):
        held = {"id": "boca-inlet-surf", "name": "Inlet", "frameAt": "2026-10-13T17:20:00Z", "frameSha": "abc123",
                "scoredAt": "2026-10-13T17:22:00Z", "provider": "gemini", "model": "gemini-2.5-flash",
                "claim": {"level": "moderate", "coveragePct": 35, "note": "rocks"}}
        opinion = {"provider": "clef", "model": "m", "level": "none", "coveragePct": 0, "note": None}
        body = qw.build_alert("boca-raton", held, opinion, [{"id": "x"}], {"level": "none", "pct": 0}, "ab" * 32, True)
        self.assertEqual(body, {
            "slug": "boca-raton", "camId": "boca-inlet-surf", "camName": "Inlet",
            "observedAt": "2026-10-13T17:20:00Z", "published": {"level": "none", "pct": 0},
            "claim": {"level": "moderate", "coveragePct": 35, "note": "rocks",
                      "provider": "gemini", "model": "gemini-2.5-flash"},
            "claimTarget": {"frameSha": "abc123", "frameAt": "2026-10-13T17:20:00Z", "claimedAt": "2026-10-13T17:22:00Z"},
            "secondOpinion": opinion, "others": [{"id": "x"}],
            "frame": {"sha256": "ab" * 32, "archivedThisTick": True},
        })

    def test_observed_time_falls_back_to_the_scoring_time(self):
        held = {"id": "a", "scoredAt": "2026-10-13T17:22:00Z", "claim": {"level": "high"}}
        self.assertEqual(qw.build_alert("s", held, {}, [], None, None, False)["observedAt"], "2026-10-13T17:22:00Z")

    def test_frame_sha256_is_the_full_hex_digest(self):
        self.assertEqual(qw.frame_sha256(b"abc"),
                         "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")


class ConfirmHeldTests(unittest.TestCase):
    HELD = {"id": "a", "level": None, "unconfirmed": True, "dispute": "second-opinion",
            "claim": {"level": "moderate", "coveragePct": 35, "note": "n"}}

    def test_confirmed_by_names_who_backed_it_and_drops_the_hold_marks(self):
        got = qw.confirm_held(self.HELD, "owner")
        self.assertEqual((got["confirmedBy"], got["level"]), ("owner", "moderate"))
        for gone in ("unconfirmed", "claim", "dispute"):
            self.assertNotIn(gone, got)

    def test_a_judged_claim_with_a_valid_level_replaces_the_stored_one(self):
        got = qw.confirm_held(self.HELD, "owner", {"level": "high", "coveragePct": 60, "note": "m"})
        self.assertEqual((got["level"], got["coveragePct"], got["note"]), ("high", 60, "m"))

    def test_a_judged_claim_with_no_valid_level_is_ignored(self):
        self.assertEqual(qw.confirm_held(self.HELD, "owner", {"level": "enormous"})["level"], "moderate")

    def test_the_input_is_not_changed(self):
        before = json.dumps(self.HELD, sort_keys=True)
        qw.confirm_held(self.HELD, "owner")
        self.assertEqual(json.dumps(self.HELD, sort_keys=True), before)


NOW = dt.datetime(2026, 10, 13, 13, 40, tzinfo=ZoneInfo("America/New_York"))  # 17:40Z
CREATED = "2026-10-13T17:35:00.000Z"
UNTIL = "2026-10-14T04:00:00.000Z"
SHA_A = "aaaaaaaaaaaaaaaaaaaa"
SHA_B = "bbbbbbbbbbbbbbbbbbbb"
VECTORS = json.loads((Path(__file__).resolve().parent.parent / "lib" / "quality" / "verdictVectors.json").read_text())


def ov(cam="boca-inlet-surf", action="reject", sha=SHA_A, frame_at=None, created=CREATED, until=UNTIL,
       level=None, verdict=None, oid=1, local_date="2026-10-13"):
    return {"id": oid, "signal": "seaweed", "camId": cam, "verdict": verdict or ("right" if action == "publish" else "wrong"),
            "action": action, "level": level, "coveragePct": 35 if level else None, "note": None,
            "frameSha": sha, "frameAt": frame_at, "claimedAt": "2026-10-13T17:30:00Z", "localDate": local_date,
            "createdAtUtc": created, "untilUtc": until}


class SharedVectorTests(unittest.TestCase):
    """lib/quality/verdictVectors.json is read by the TypeScript tests too: both must agree."""

    def test_same_frame(self):
        for v in VECTORS["sameFrame"]:
            self.assertEqual(qw.same_frame(v["a"], v["b"]), v["same"], v["name"])

    def test_target_key(self):
        for v in VECTORS["targetKey"]:
            self.assertEqual(qw.target_key(v["o"]), v["key"], v["o"])

    def test_same_claim(self):
        for v in VECTORS["sameClaim"]:
            self.assertEqual(qw.same_claim(v["a"], v["b"]), v["same"], v["name"])

    def test_effective_overrides(self):
        for v in VECTORS["effective"]:
            now = qw.parse_iso(v["now"])
            self.assertEqual([o["id"] for o in qw.effective_overrides(v["overrides"], now)], v["ids"], v["name"])

    def test_the_merged_event_stream_decides_whether_the_cam_ends_disputed(self):
        checked = 0
        for v in VECTORS["effective"]:
            if "disputedAtEnd" not in v:
                continue
            now = qw.parse_iso(v["now"]).astimezone(ZoneInfo("America/New_York"))
            events = qw.owner_state(v["overrides"], now)["events"]
            self.assertEqual([o["id"] for o in events], v["ids"], v["name"])
            active = qw.active_disputes(qw.dispute_state(None, events, now))
            self.assertEqual(bool(active), v["disputedAtEnd"], v["name"])
            checked += 1
        self.assertGreaterEqual(checked, 4, "Wrong-Right-Wrong and Right-Wrong-Right are among them")


class ParseOverridesTests(unittest.TestCase):
    def test_parses_the_apps_reply(self):
        got = qw.parse_overrides({"ok": True, "overrides": [ov(action="publish", level="moderate", oid=7)]})
        self.assertEqual(got, [{
            "id": 7, "camId": "boca-inlet-surf", "verdict": "right", "action": "publish", "level": "moderate",
            "coveragePct": 35, "note": None, "frameSha": SHA_A, "frameAt": None, "claimedAt": "2026-10-13T17:30:00Z",
            "localDate": "2026-10-13", "createdAtUtc": CREATED, "untilUtc": UNTIL}])

    def test_drops_the_malformed_and_other_signals(self):
        got = qw.parse_overrides({"overrides": ["junk", ov(cam=""), dict(ov(), createdAtUtc="never"),
                                                dict(ov(), untilUtc=None), dict(ov(), signal="clarity"),
                                                dict(ov(), action="maybe"), {"camId": 7}, ov("ok")]})
        self.assertEqual([o["camId"] for o in got], ["ok"])

    def test_not_a_dict_or_no_list_is_empty(self):
        for doc in (None, [], "x", {}, {"overrides": "no"}):
            self.assertEqual(qw.parse_overrides(doc), [])

    def test_an_unknown_level_is_none(self):
        self.assertIsNone(qw.parse_overrides({"overrides": [dict(ov(action="publish"), level="enormous")]})[0]["level"])


class FetchOverridesTests(unittest.TestCase):
    def fetch(self, **kw):
        with contextlib.redirect_stderr(io.StringIO()):
            return qw.fetch_overrides("boca-raton", **kw)

    def test_no_token_means_no_overrides_and_no_request(self):
        with mock.patch.object(qw.urllib.request, "urlopen") as op:
            self.assertEqual(self.fetch(token=""), [])
            op.assert_not_called()

    def test_it_uses_its_own_quality_token_not_ingest_token(self):
        with mock.patch.dict(os.environ, {"INGEST_TOKEN": "archive-token", "QUALITY_INGEST_TOKEN": ""}), \
                mock.patch.object(qw.urllib.request, "urlopen") as op:
            self.assertEqual(self.fetch(), [])
            op.assert_not_called()
            self.assertEqual(qw.post_alert({"slug": "s"}), "no-token")
            op.assert_not_called()

    def test_asks_for_the_beach_with_the_bearer_token(self):
        seen = {}

        class Reply(FakeResponse):
            def read(self, n=-1):
                return json.dumps({"ok": True, "overrides": [ov()]}).encode()

        def fake(req, timeout=None):
            seen.update(url=req.full_url, auth=req.get_header("Authorization"), timeout=timeout)
            return Reply()

        with mock.patch.dict(os.environ, {"QUALITY_INGEST_TOKEN": "qtok"}), mock.patch.object(qw.urllib.request, "urlopen", fake):
            got = self.fetch(url="https://x/api/quality/overrides")
        self.assertEqual(seen, {"url": "https://x/api/quality/overrides?slug=boca-raton", "auth": "Bearer qtok",
                                "timeout": qw.OVERRIDES_TIMEOUT_S})
        self.assertEqual([o["camId"] for o in got], ["boca-inlet-surf"])

    def test_every_failure_fails_open(self):
        def refuse(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 503, "no", {}, None)

        def junk(req, timeout=None):
            class R(FakeResponse):
                def read(self, n=-1):
                    return b"<html>"
            return R()

        for fn in (refuse, junk, lambda req, timeout=None: (_ for _ in ()).throw(OSError("down"))):
            with mock.patch.object(qw.urllib.request, "urlopen", fn):
                self.assertEqual(self.fetch(token="tok"), [])


class OwnerStateTests(unittest.TestCase):
    def test_splits_what_is_in_force_by_action(self):
        st = qw.owner_state([ov(action="publish", level="moderate", sha=SHA_A, oid=1), ov(sha=SHA_B, oid=2)], NOW)
        self.assertEqual([o["id"] for o in st["publish"]], [1])
        self.assertEqual([o["id"] for o in st["reject"]], [2])
        self.assertEqual([o["id"] for o in st["events"]], [1, 2], "one merged stream, oldest first")

    def test_a_later_verdict_on_the_same_frame_replaces_the_earlier(self):
        later = "2026-10-13T17:39:00.000Z"
        st = qw.owner_state([ov(oid=1), ov(action="publish", level="moderate", created=later, oid=2)], NOW)
        self.assertEqual((len(st["reject"]), [o["id"] for o in st["publish"]]), (0, [2]))

    def test_a_verdict_on_one_frame_leaves_another_frame_of_the_cam_alone(self):
        st = qw.owner_state([ov(sha=SHA_A), ov(action="publish", level="high", sha=SHA_B, oid=2)], NOW)
        self.assertEqual((len(st["reject"]), len(st["publish"])), (1, 1))

    def test_an_ended_verdict_is_ignored(self):
        self.assertEqual(qw.owner_state([ov(until="2026-10-13T17:39:59.000Z")], NOW), {"publish": [], "reject": [], "events": []})

    def test_no_overrides_no_state(self):
        self.assertEqual(qw.owner_state([], NOW), {"publish": [], "reject": [], "events": []})

    def test_the_same_image_scored_at_another_time_is_another_claim(self):
        a = ov(oid=1)
        b = dict(ov(oid=2, created="2026-10-13T17:36:00.000Z"), claimedAt="2026-10-13T17:40:00Z")
        st = qw.owner_state([a, b], NOW)
        self.assertEqual([o["id"] for o in st["events"]], [1, 2], "two targets: the later verdict does not replace the first")

    def test_a_verdict_with_no_claim_time_cannot_bind(self):
        self.assertEqual(qw.owner_state([dict(ov(), claimedAt=None)], NOW)["events"], [])


HELD_AT = "2026-10-13T17:30:00Z"


def held_reading(cam="a", sha=SHA_A, frame_at="2026-10-13T17:25:00Z", **kw):
    return {"id": cam, "name": cam.upper(), "level": None, "coveragePct": None, "note": None, "unconfirmed": True,
            "claim": {"level": "moderate", "coveragePct": 35, "note": "rock?"}, "scoredAt": HELD_AT,
            "frameSha": sha, "frameAt": frame_at, "water": "clear", **kw}


def prev_feed(**held_kw):
    held = held_reading(**held_kw)
    other = {"id": "b", "name": "B", "level": "none", "coveragePct": 0, "scoredAt": HELD_AT}
    return {"latest": {"hour": 13, "cams": [held, other]},
            "lastSeaweed": {"hour": 13, "cams": [dict(held), dict(other)]},
            "pendingClaims": {"a": {"level": "moderate", "claimedAt": HELD_AT, "frameAt": held["frameAt"], "frameSha": held["frameSha"]},
                              "b": {"level": "moderate", "claimedAt": HELD_AT, "frameAt": "2026-10-13T17:00:00Z", "frameSha": SHA_B}}}


class ApplyOwnerConfirmationsTests(unittest.TestCase):
    def publish(self, **kw):
        return ov(cam="a", action="publish", level="moderate", **kw)

    def reject(self, **kw):
        return ov(cam="a", action="reject", **kw)

    def test_nothing_to_apply_returns_the_same_feed(self):
        p = prev_feed()
        self.assertIs(qw.apply_owner_confirmations(p, []), p)

    def test_publish_confirms_exactly_that_frames_held_reading_at_the_verdicts_level(self):
        out = qw.apply_owner_confirmations(prev_feed(), [self.publish()])
        for key in ("latest", "lastSeaweed"):
            a, b = out[key]["cams"]
            self.assertEqual((a["level"], a["coveragePct"], a["confirmedBy"]), ("moderate", 35, "owner"))
            self.assertNotIn("unconfirmed", a)
            self.assertEqual((a["water"], b["level"]), ("clear", "none"))
        self.assertEqual(out["pendingClaims"]["a"]["confirmed"], True)
        self.assertEqual(out["pendingClaims"]["a"]["confirmedBy"], "owner")
        self.assertNotIn("confirmed", out["pendingClaims"]["b"])

    def test_a_corrected_level_is_what_publishes(self):
        out = qw.apply_owner_confirmations(prev_feed(), [dict(self.publish(), level="high", coveragePct=60)])
        self.assertEqual((out["latest"]["cams"][0]["level"], out["latest"]["cams"][0]["coveragePct"]), ("high", 60))

    def test_a_verdict_for_frame_a_never_touches_a_newer_held_frame_b(self):
        # The owner answered an old alert (frame A); the cam's current held claim is a different frame.
        out = qw.apply_owner_confirmations(prev_feed(sha=SHA_B, frame_at="2026-10-13T17:29:00Z"), [self.publish(sha=SHA_A)])
        self.assertTrue(out["latest"]["cams"][0]["unconfirmed"])
        self.assertNotIn("confirmed", out["pendingClaims"]["a"])

    def test_a_courier_claim_is_matched_by_its_frame_time(self):
        p = prev_feed(sha=None, frame_at="2026-10-13T17:25:00Z")
        p["pendingClaims"]["a"].pop("frameSha")
        v = self.publish(sha=None, frame_at="2026-10-13T17:25:00Z")
        self.assertEqual(qw.apply_owner_confirmations(p, [v])["latest"]["cams"][0]["confirmedBy"], "owner")
        other = self.publish(sha=None, frame_at="2026-10-13T17:26:00Z")
        self.assertTrue(qw.apply_owner_confirmations(p, [other])["latest"]["cams"][0]["unconfirmed"])

    def test_reject_clears_that_frames_held_reading_and_removes_its_pending_claim(self):
        out = qw.apply_owner_confirmations(prev_feed(), [self.reject()])
        a = out["latest"]["cams"][0]
        self.assertIsNone(a["level"])
        self.assertTrue(a["ownerRejected"])
        self.assertNotIn("unconfirmed", a)
        self.assertNotIn("claim", a)
        self.assertNotIn("a", out["pendingClaims"])
        self.assertIn("b", out["pendingClaims"])

    def test_reject_of_another_frame_leaves_the_claim_in_place(self):
        out = qw.apply_owner_confirmations(prev_feed(), [self.reject(sha=SHA_B)])
        self.assertTrue(out["latest"]["cams"][0]["unconfirmed"])
        self.assertIn("a", out["pendingClaims"])

    def test_a_reading_that_is_not_held_is_left_alone(self):
        p = prev_feed()
        p["latest"]["cams"][0] = {"id": "a", "level": "none", "scoredAt": HELD_AT, "frameSha": SHA_A}
        self.assertEqual(qw.apply_owner_confirmations(p, [self.publish()])["latest"]["cams"][0]["level"], "none")

    def test_the_input_is_not_changed(self):
        p = prev_feed()
        before = json.dumps(p, sort_keys=True)
        qw.apply_owner_confirmations(p, [self.publish(), self.reject(sha=SHA_B)])
        self.assertEqual(json.dumps(p, sort_keys=True), before)

    def test_a_feed_with_no_groups_or_claims_is_fine(self):
        self.assertEqual(qw.apply_owner_confirmations({}, [self.publish(), self.reject()]), {})


class DisputeStateTests(unittest.TestCase):
    TODAY = "2026-10-13"

    def test_an_owner_reject_disputes_its_cam_for_today(self):
        st = qw.dispute_state(None, [ov(cam="a")], NOW)
        self.assertEqual(st["a"], {"since": CREATED, "sinceId": 1, "reason": "owner", "date": self.TODAY, "claims": []})
        self.assertEqual(list(qw.active_disputes(st)), ["a"])

    def test_a_reject_from_another_day_does_not_dispute(self):
        self.assertEqual(qw.dispute_state(None, [ov(cam="a", local_date="2026-10-12")], NOW), {})

    def test_the_previous_feeds_entries_carry_over_only_for_today(self):
        prev = {"a": {"since": "x", "reason": "second-opinion", "date": self.TODAY, "claims": [{"key": "k", "at": "t"}]},
                "b": {"since": "x", "reason": "owner", "date": "2026-10-12", "claims": []}}
        st = qw.dispute_state(prev, [], NOW)
        self.assertEqual(list(st), ["a"])
        self.assertEqual(st["a"]["claims"], [{"key": "k", "at": "t"}])

    def test_the_same_reject_does_not_reopen_a_resolved_dispute_but_a_newer_one_does(self):
        resolved = {"a": {"since": CREATED, "reason": "owner", "date": self.TODAY, "claims": [], "resolvedAt": "2026-10-13T17:38:00.000Z"}}
        self.assertEqual(qw.active_disputes(qw.dispute_state(resolved, [ov(cam="a")], NOW)), {})
        newer = ov(cam="a", created="2026-10-13T17:39:00.000Z", sha=SHA_B, oid=2)
        st = qw.dispute_state(resolved, [newer], NOW)
        self.assertEqual(list(qw.active_disputes(st)), ["a"])
        self.assertEqual(st["a"]["since"], "2026-10-13T17:39:00.000Z")

    def test_an_owner_publish_after_the_dispute_began_ends_it(self):
        right = ov(cam="a", action="publish", level="moderate", created="2026-10-13T17:39:00.000Z", sha=SHA_B, oid=2)
        st = qw.dispute_state(None, [ov(cam="a"), right], NOW)
        self.assertEqual(qw.active_disputes(st), {})
        self.assertEqual(st["a"]["resolvedAt"], "2026-10-13T17:39:00.000Z")

    def test_an_owner_publish_from_before_the_dispute_does_not_end_it(self):
        early = ov(cam="a", action="publish", level="moderate", created="2026-10-13T17:10:00.000Z", sha=SHA_B, oid=2)
        self.assertEqual(list(qw.active_disputes(qw.dispute_state(None, [early, ov(cam="a")], NOW))), ["a"])


    def test_wrong_right_wrong_ends_disputed_and_right_wrong_right_does_not(self):
        t = ["2026-10-13T17:20:00.000Z", "2026-10-13T17:25:00.000Z", "2026-10-13T17:30:00.000Z"]
        wrong = lambda oid, at, sha: ov(cam="a", created=at, sha=sha, oid=oid)
        right = lambda oid, at, sha: ov(cam="a", action="publish", level="moderate", created=at, sha=sha, oid=oid)
        wrw = [wrong(1, t[0], SHA_A), right(2, t[1], SHA_B), wrong(3, t[2], "cccccccccccccccccccc")]
        rwr = [right(1, t[0], SHA_A), wrong(2, t[1], SHA_B), right(3, t[2], "cccccccccccccccccccc")]
        self.assertEqual(list(qw.active_disputes(qw.dispute_state(None, wrw, NOW))), ["a"])
        self.assertEqual(qw.active_disputes(qw.dispute_state(None, rwr, NOW)), {})

    def test_replaying_the_same_events_next_tick_changes_nothing_for_every_vector(self):
        checked = 0
        for v in VECTORS["effective"]:
            now = qw.parse_iso(v["now"]).astimezone(ZoneInfo("America/New_York"))
            events = qw.owner_state(v["overrides"], now)["events"]
            first = qw.dispute_state(None, events, now)
            second = qw.dispute_state(first, events, now)
            third = qw.dispute_state(second, events, now)
            self.assertEqual(second, first, v["name"])
            self.assertEqual(third, first, v["name"])
            if "disputedAtEnd" in v:
                self.assertEqual(bool(qw.active_disputes(third)), v["disputedAtEnd"], v["name"])
            checked += 1
        self.assertEqual(checked, len(VECTORS["effective"]))

    def test_same_instant_right_7_then_wrong_8_stays_disputed_across_ticks(self):
        t = "2026-10-13T17:30:00.000Z"
        right = ov(cam="a", action="publish", level="moderate", created=t, oid=7)
        wrong = ov(cam="a", created=t, sha=SHA_B, oid=8)
        state = None
        for _ in range(4):
            state = qw.dispute_state(state, [right, wrong], NOW)
            self.assertEqual(list(qw.active_disputes(state)), ["a"])
        self.assertEqual(state["a"]["sinceId"], 8)
        # and the other order (Wrong 7, Right 8 at the same instant) stays resolved
        state = None
        for _ in range(4):
            state = qw.dispute_state(state, [ov(cam="a", created=t, oid=7), ov(cam="a", action="publish", level="moderate", created=t, sha=SHA_B, oid=8)], NOW)
            self.assertEqual(qw.active_disputes(state), {})

    def test_an_entry_written_before_ids_were_kept_still_works(self):
        old = {"a": {"since": CREATED, "reason": "owner", "date": "2026-10-13", "claims": []}}
        right = ov(cam="a", action="publish", level="moderate", created="2026-10-13T17:36:00.000Z", sha=SHA_B, oid=2)
        self.assertEqual(qw.active_disputes(qw.dispute_state(old, [right], NOW)), {})

    def test_the_order_of_the_input_does_not_matter(self):
        t = ["2026-10-13T17:20:00.000Z", "2026-10-13T17:25:00.000Z"]
        events = [ov(cam="a", created=t[0], oid=1),
                  ov(cam="a", action="publish", level="moderate", created=t[1], sha=SHA_B, oid=2)]
        self.assertEqual(qw.dispute_state(None, events, NOW), qw.dispute_state(None, events[::-1], NOW))


class ExtendedPersistenceTests(unittest.TestCase):
    def entry(self, *frames):
        return {"since": CREATED, "reason": "owner", "date": "2026-10-13",
                "claims": [{"key": f"sha:{k}", "at": at} for k, at in frames]}

    def reading(self, sha, at):
        return {"id": "a", "frameSha": sha, "frameAt": at, "scoredAt": at}

    def test_three_distinct_frames_over_90_minutes_qualify(self):
        e = self.entry((SHA_A, "2026-10-13T15:00:00Z"), (SHA_B, "2026-10-13T15:50:00Z"))
        self.assertTrue(qw.extended_persistence_ok(e, self.reading("cccccccccccccccccccc", "2026-10-13T16:30:00Z")))

    def test_two_frames_never_qualify_however_far_apart(self):
        e = self.entry((SHA_A, "2026-10-13T10:00:00Z"))
        self.assertFalse(qw.extended_persistence_ok(e, self.reading(SHA_B, "2026-10-13T16:30:00Z")))

    def test_three_frames_inside_90_minutes_do_not(self):
        e = self.entry((SHA_A, "2026-10-13T15:00:00Z"), (SHA_B, "2026-10-13T15:40:00Z"))
        self.assertFalse(qw.extended_persistence_ok(e, self.reading("cccccccccccccccccccc", "2026-10-13T16:29:00Z")))

    def test_the_same_frame_counts_once(self):
        e = self.entry((SHA_A, "2026-10-13T15:00:00Z"), (SHA_B, "2026-10-13T15:50:00Z"))
        self.assertFalse(qw.extended_persistence_ok(e, self.reading(SHA_B, "2026-10-13T16:50:00Z")))

    def test_recording_keeps_distinct_frames_and_caps_them(self):
        e = self.entry()
        for i in range(12):
            qw.record_dispute_claim(e, self.reading(f"{i:020d}", f"2026-10-13T1{i % 10}:00:00Z"))
        qw.record_dispute_claim(e, self.reading(f"{11:020d}", "2026-10-13T11:00:00Z"))
        self.assertEqual(len(e["claims"]), qw.DISPUTE_CLAIMS_KEPT)
        self.assertEqual(len({c["key"] for c in e["claims"]}), qw.DISPUTE_CLAIMS_KEPT)
        qw.record_dispute_claim(e, {"id": "a"})  # no frame identity, no time: nothing to remember
        self.assertEqual(len(e["claims"]), qw.DISPUTE_CLAIMS_KEPT)


class OutboxTests(unittest.TestCase):
    BODY = {"slug": "boca-raton", "camId": "a", "observedAt": "2026-10-13T17:20:00Z",
            "claimTarget": {"frameSha": "ab" * 10, "frameAt": "2026-10-13T17:20:00Z", "claimedAt": "2026-10-13T17:21:00Z"},
            "frame": {"sha256": "ab" * 32, "archivedThisTick": True, "jpegB64": "QUJD"}}

    def test_the_same_image_scored_again_is_a_new_claim_with_its_own_outbox_entry(self):
        # Codex C1/C2: C1 could not be published, then the unchanged image was rescored as C2.
        box = []
        self.assertTrue(qw.queue_alert(box, self.BODY, NOW))
        c2 = dict(self.BODY, claimTarget=dict(self.BODY["claimTarget"], claimedAt="2026-10-13T17:31:00Z"))
        self.assertTrue(qw.queue_alert(box, c2, NOW))
        self.assertEqual(len(box), 2)
        self.assertNotEqual(qw.alert_key(self.BODY), qw.alert_key(c2))

    def test_the_key_normalizes_the_claim_time(self):
        other = dict(self.BODY, claimTarget=dict(self.BODY["claimTarget"], claimedAt="2026-10-13T13:21:00-04:00"))
        self.assertEqual(qw.alert_key(self.BODY), qw.alert_key(other))

    def test_a_failed_alert_is_queued_once_without_its_picture(self):
        box = []
        self.assertTrue(qw.queue_alert(box, self.BODY, NOW))
        self.assertFalse(qw.queue_alert(box, dict(self.BODY), NOW))
        self.assertEqual(len(box), 1)
        self.assertNotIn("jpegB64", box[0]["body"]["frame"])
        self.assertEqual(box[0]["body"]["frame"]["sha256"], "ab" * 32)
        self.assertIn("jpegB64", self.BODY["frame"])  # the original is not changed
        self.assertEqual(box[0]["createdAt"], "2026-10-13T17:40:00Z")

    def test_a_retry_that_gets_2xx_empties_the_outbox(self):
        box = []
        qw.queue_alert(box, self.BODY, NOW)
        calls = []
        self.assertEqual(qw.retry_outbox(box, NOW + dt.timedelta(minutes=10), lambda b: calls.append(b) or "sent"), [])
        self.assertEqual(len(calls), 1)

    def test_a_retry_that_fails_keeps_it_and_counts_the_attempt(self):
        box = []
        qw.queue_alert(box, self.BODY, NOW)
        for status in ("error", "http-503", "http-429", "http-401", "no-token"):
            kept = qw.retry_outbox(box, NOW + dt.timedelta(minutes=10), lambda b, s=status: s)
            self.assertEqual(len(kept), 1, status)
            self.assertEqual(kept[0]["attempts"], 2)

    def test_a_permanent_refusal_is_dropped(self):
        box = []
        qw.queue_alert(box, self.BODY, NOW)
        for status in ("http-400", "http-404", "http-413", "http-422"):
            self.assertEqual(qw.retry_outbox(box, NOW + dt.timedelta(minutes=10), lambda b, s=status: s), [], status)

    def test_an_alert_older_than_24_hours_is_dropped_without_a_try(self):
        box = []
        qw.queue_alert(box, self.BODY, NOW)
        calls = []
        self.assertEqual(qw.retry_outbox(box, NOW + dt.timedelta(hours=24, minutes=1), lambda b: calls.append(b) or "sent"), [])
        self.assertEqual(calls, [])
        self.assertEqual(len(qw.retry_outbox(box, NOW + dt.timedelta(hours=23, minutes=59), lambda b: "error")), 1)

    def test_only_a_few_are_tried_per_tick_and_the_rest_wait(self):
        box = []
        for i in range(8):
            qw.queue_alert(box, dict(self.BODY, camId=f"c{i}"), NOW)
        calls = []
        kept = qw.retry_outbox(box, NOW + dt.timedelta(minutes=1), lambda b: calls.append(b) or "sent")
        self.assertEqual(len(calls), qw.OUTBOX_MAX_PER_TICK)
        self.assertEqual(len(kept), 8 - qw.OUTBOX_MAX_PER_TICK)

    def test_junk_in_the_outbox_is_dropped(self):
        self.assertEqual(qw.retry_outbox([{"nope": 1}, "x", {"createdAt": "never", "body": {}}], NOW, lambda b: "sent"), [])
        self.assertEqual(qw.retry_outbox(None, NOW, lambda b: "sent"), [])


class BuildAlertFrameTests(unittest.TestCase):
    HELD = {"id": "a", "name": "A", "frameAt": "2026-10-13T17:20:00Z", "claim": {"level": "moderate"}}

    def test_a_shrunk_frame_rides_along_as_base64(self):
        body = qw.build_alert("s", self.HELD, {}, [], None, "ab" * 32, False, b"\xff\xd8\xffJPEG")
        self.assertEqual(base64.b64decode(body["frame"]["jpegB64"]), b"\xff\xd8\xffJPEG")
        self.assertEqual(body["frame"]["sha256"], "ab" * 32)

    def test_no_frame_or_a_frame_over_the_limit_sends_none(self):
        self.assertNotIn("jpegB64", qw.build_alert("s", self.HELD, {}, [], None, None, False)["frame"])
        big = b"x" * (qw.ALERT_FRAME_MAX_BYTES + 1)
        self.assertNotIn("jpegB64", qw.build_alert("s", self.HELD, {}, [], None, None, False, big)["frame"])
        ok = b"x" * qw.ALERT_FRAME_MAX_BYTES
        self.assertIn("jpegB64", qw.build_alert("s", self.HELD, {}, [], None, None, False, ok)["frame"])


class FakeResponse:
    def read(self, n=-1):
        return b"{}"

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class PostAlertTests(unittest.TestCase):
    def post(self, **kw):
        with contextlib.redirect_stderr(io.StringIO()):
            return qw.post_alert({"slug": "boca-raton"}, **kw)

    def test_without_a_token_nothing_is_sent(self):
        with mock.patch.object(qw.urllib.request, "urlopen") as op:
            self.assertEqual(self.post(token=""), "no-token")
            op.assert_not_called()

    def test_sends_json_with_the_bearer_token(self):
        seen = {}

        def fake_urlopen(req, timeout=None):
            seen["url"] = req.full_url
            seen["auth"] = req.get_header("Authorization")
            seen["type"] = req.get_header("Content-type")
            seen["body"] = json.loads(req.data)
            seen["timeout"] = timeout
            return FakeResponse()

        with mock.patch.object(qw.urllib.request, "urlopen", fake_urlopen):
            self.assertEqual(self.post(token="tok", url="https://x/api/quality/alerts"), "sent")
        self.assertEqual(seen["url"], "https://x/api/quality/alerts")
        self.assertEqual(seen["auth"], "Bearer tok")
        self.assertEqual(seen["type"], "application/json")
        self.assertEqual(seen["body"], {"slug": "boca-raton"})
        self.assertEqual(seen["timeout"], qw.ALERT_TIMEOUT_S)

    def test_a_refusal_or_a_network_error_is_a_status_never_an_exception(self):
        def refuse(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, 401, "no", {}, None)

        def down(req, timeout=None):
            raise OSError("down")

        with mock.patch.object(qw.urllib.request, "urlopen", refuse):
            self.assertEqual(self.post(token="tok"), "http-401")
        with mock.patch.object(qw.urllib.request, "urlopen", down):
            self.assertEqual(self.post(token="tok"), "error")


if __name__ == "__main__":
    unittest.main()
