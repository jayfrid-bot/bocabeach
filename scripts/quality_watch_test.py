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
        held = {"id": "boca-inlet-surf", "name": "Inlet", "frameAt": "2026-10-13T17:20:00Z",
                "scoredAt": "2026-10-13T17:22:00Z", "provider": "gemini", "model": "gemini-2.5-flash",
                "claim": {"level": "moderate", "coveragePct": 35, "note": "rocks"}}
        opinion = {"provider": "clef", "model": "m", "level": "none", "coveragePct": 0, "note": None}
        body = qw.build_alert("boca-raton", held, opinion, [{"id": "x"}], {"level": "none", "pct": 0}, "ab" * 32, True)
        self.assertEqual(body, {
            "slug": "boca-raton", "camId": "boca-inlet-surf", "camName": "Inlet",
            "observedAt": "2026-10-13T17:20:00Z", "published": {"level": "none", "pct": 0},
            "claim": {"level": "moderate", "coveragePct": 35, "note": "rocks",
                      "provider": "gemini", "model": "gemini-2.5-flash"},
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
    HELD = {"id": "a", "level": None, "unconfirmed": True, "claim": {"level": "moderate", "coveragePct": 35, "note": "n"}}

    def test_confirmed_by_names_who_backed_it(self):
        self.assertEqual(qw.confirm_held(self.HELD, "owner")["confirmedBy"], "owner")
        self.assertEqual(qw.confirm_held(self.HELD, "owner")["level"], "moderate")

    def test_a_judged_claim_with_a_valid_level_replaces_the_stored_one(self):
        got = qw.confirm_held(self.HELD, "owner", {"level": "high", "coveragePct": 60, "note": "m"})
        self.assertEqual((got["level"], got["coveragePct"], got["note"]), ("high", 60, "m"))

    def test_a_judged_claim_with_no_valid_level_is_ignored(self):
        got = qw.confirm_held(self.HELD, "owner", {"level": "enormous"})
        self.assertEqual(got["level"], "moderate")


NOW = dt.datetime(2026, 10, 13, 13, 40, tzinfo=ZoneInfo("America/New_York"))  # 17:40Z
CREATED = "2026-10-13T17:35:00.000Z"
UNTIL = "2026-10-14T04:00:00.000Z"


def ov(cam="boca-inlet-surf", verdict="wrong", created=CREATED, until=UNTIL, claim=None):
    return {"signal": "seaweed", "camId": cam, "verdict": verdict, "createdAtUtc": created, "untilUtc": until, "claim": claim}


class ParseOverridesTests(unittest.TestCase):
    def test_parses_the_apps_reply(self):
        got = qw.parse_overrides({"ok": True, "overrides": [
            ov(verdict="right", claim={"level": "moderate", "coveragePct": 35, "note": None}), ov("boca-south")]})
        self.assertEqual(got, [
            {"camId": "boca-inlet-surf", "verdict": "right", "createdAt": CREATED, "untilUtc": UNTIL,
             "claim": {"level": "moderate", "coveragePct": 35, "note": None}},
            {"camId": "boca-south", "verdict": "wrong", "createdAt": CREATED, "untilUtc": UNTIL, "claim": None},
        ])

    def test_drops_the_malformed_and_other_signals(self):
        got = qw.parse_overrides({"overrides": [
            "junk", ov(cam=""), ov(created="never"), ov(until=None), dict(ov(), signal="clarity"), {"camId": 7}, ov("ok")]})
        self.assertEqual([o["camId"] for o in got], ["ok"])

    def test_not_a_dict_or_no_list_is_empty(self):
        for doc in (None, [], "x", {}, {"overrides": "no"}):
            self.assertEqual(qw.parse_overrides(doc), [])

    def test_an_unknown_verdict_counts_as_wrong(self):
        self.assertEqual(qw.parse_overrides({"overrides": [dict(ov(), verdict="maybe")]})[0]["verdict"], "wrong")


class FetchOverridesTests(unittest.TestCase):
    def fetch(self, **kw):
        with contextlib.redirect_stderr(io.StringIO()):
            return qw.fetch_overrides("boca-raton", **kw)

    def test_no_token_means_no_overrides_and_no_request(self):
        with mock.patch.object(qw.urllib.request, "urlopen") as op:
            self.assertEqual(self.fetch(token=""), [])
            op.assert_not_called()

    def test_asks_for_the_beach_with_the_bearer_token(self):
        seen = {}

        class Reply(FakeResponse):
            def read(self, n=-1):
                return json.dumps({"ok": True, "overrides": [ov()]}).encode()

        def fake(req, timeout=None):
            seen.update(url=req.full_url, auth=req.get_header("Authorization"), timeout=timeout)
            return Reply()

        with mock.patch.object(qw.urllib.request, "urlopen", fake):
            got = self.fetch(token="tok", url="https://x/api/quality/overrides")
        self.assertEqual(seen, {"url": "https://x/api/quality/overrides?slug=boca-raton", "auth": "Bearer tok",
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
    def state(self, overrides, spent=None):
        return qw.owner_state(qw.parse_overrides({"overrides": overrides}), spent, NOW)

    def test_a_running_wrong_suppresses_its_cam(self):
        self.assertEqual(self.state([ov()])["wrong"], {"boca-inlet-surf": CREATED})

    def test_a_right_is_listed_oldest_first_and_is_not_a_suppression(self):
        st = self.state([ov("b", "right", created="2026-10-13T17:30:00.000Z"), ov("a", "right", created="2026-10-13T17:20:00.000Z")])
        self.assertEqual([o["camId"] for o in st["right"]], ["a", "b"])
        self.assertEqual(st["wrong"], {})

    def test_an_ended_override_is_ignored(self):
        self.assertEqual(self.state([ov(until="2026-10-13T17:39:59.000Z")]), {"wrong": {}, "right": []})

    def test_a_spent_wrong_is_ignored_but_a_newer_one_is_not(self):
        self.assertEqual(self.state([ov()], {"boca-inlet-surf": CREATED})["wrong"], {})
        newer = "2026-10-13T17:39:00.000Z"
        self.assertEqual(self.state([ov(created=newer)], {"boca-inlet-surf": CREATED})["wrong"], {"boca-inlet-surf": newer})

    def test_the_latest_wrong_for_a_cam_wins(self):
        newer = "2026-10-13T17:39:00.000Z"
        self.assertEqual(self.state([ov(created=newer), ov()])["wrong"], {"boca-inlet-surf": newer})

    def test_no_overrides_no_state(self):
        self.assertEqual(qw.owner_state([], None, NOW), {"wrong": {}, "right": []})
        self.assertEqual(qw.owner_state([], "junk", NOW), {"wrong": {}, "right": []})


class SpentTests(unittest.TestCase):
    WRONG = {"a": CREATED, "b": CREATED}

    def test_a_fresh_read_below_moderate_spends_the_override(self):
        cams = [{"id": "a", "level": "none"}, {"id": "b", "level": "low"}, {"id": "c", "level": "none"}]
        self.assertEqual(qw.spent_by(self.WRONG, cams), {"a": CREATED, "b": CREATED})

    def test_moderate_a_carried_read_or_no_level_does_not(self):
        cams = [{"id": "a", "level": "moderate"}, {"id": "b", "level": "none", "carried": True}]
        self.assertEqual(qw.spent_by(self.WRONG, cams), {})
        self.assertEqual(qw.spent_by(self.WRONG, [{"id": "a", "level": None, "lowSun": True}]), {})
        self.assertEqual(qw.spent_by(self.WRONG, []), {})
        self.assertEqual(qw.spent_by(self.WRONG, None), {})

    def test_prune_keeps_only_todays_entries(self):
        got = qw.prune_spent({"a": CREATED, "b": "2026-10-12T17:35:00.000Z", "c": "junk"}, NOW)
        self.assertEqual(got, {"a": CREATED})
        self.assertEqual(qw.prune_spent(None, NOW), {})


class ApplyOwnerConfirmationsTests(unittest.TestCase):
    HELD_AT = "2026-10-13T17:30:00Z"

    def prev(self):
        held = {"id": "a", "name": "A", "level": None, "coveragePct": None, "note": None, "unconfirmed": True,
                "claim": {"level": "moderate", "coveragePct": 35, "note": "rock?"}, "scoredAt": self.HELD_AT, "water": "clear"}
        other = {"id": "b", "name": "B", "level": "none", "coveragePct": 0, "scoredAt": self.HELD_AT}
        group = {"hour": 13, "cams": [held, other]}
        return {"latest": group, "lastSeaweed": {"hour": 13, "cams": [dict(held), dict(other)]},
                "pendingClaims": {"a": {"level": "moderate", "claimedAt": self.HELD_AT, "frameAt": self.HELD_AT},
                                  "b": {"level": "moderate", "claimedAt": self.HELD_AT}}}

    def right(self, cam="a", created=CREATED, claim=None):
        return {"camId": cam, "verdict": "right", "createdAt": created, "untilUtc": UNTIL, "claim": claim}

    def test_nothing_to_apply_returns_the_same_feed(self):
        p = self.prev()
        self.assertIs(qw.apply_owner_confirmations(p, []), p)

    def test_a_held_reading_is_published_with_confirmed_by_owner(self):
        out = qw.apply_owner_confirmations(self.prev(), [self.right()])
        for key in ("latest", "lastSeaweed"):
            a, b = out[key]["cams"]
            self.assertEqual((a["level"], a["coveragePct"], a["note"], a["confirmedBy"]), ("moderate", 35, "rock?", "owner"))
            self.assertNotIn("unconfirmed", a)
            self.assertNotIn("claim", a)
            self.assertEqual(a["water"], "clear")
            self.assertEqual((b["level"], b.get("confirmedBy")), ("none", None))

    def test_the_pending_claim_becomes_a_confirmed_marker_and_other_cams_are_untouched(self):
        out = qw.apply_owner_confirmations(self.prev(), [self.right()])
        self.assertEqual(out["pendingClaims"]["a"]["confirmed"], True)
        self.assertEqual(out["pendingClaims"]["a"]["confirmedBy"], "owner")
        self.assertNotIn("confirmed", out["pendingClaims"]["b"])

    def test_the_owners_judged_level_is_what_is_published(self):
        out = qw.apply_owner_confirmations(self.prev(), [self.right(claim={"level": "high", "coveragePct": 55, "note": "x"})])
        self.assertEqual(out["latest"]["cams"][0]["level"], "high")

    def test_a_claim_made_after_the_verdict_is_left_alone(self):
        p = self.prev()
        p["pendingClaims"]["a"]["claimedAt"] = "2026-10-13T17:38:00Z"
        p["latest"]["cams"][0]["scoredAt"] = "2026-10-13T17:38:00Z"
        out = qw.apply_owner_confirmations(p, [self.right()])
        self.assertTrue(out["latest"]["cams"][0]["unconfirmed"])
        self.assertNotIn("confirmed", out["pendingClaims"]["a"])

    def test_a_reading_that_is_not_held_is_left_alone(self):
        p = self.prev()
        p["latest"]["cams"][0] = {"id": "a", "level": "none", "scoredAt": self.HELD_AT}
        out = qw.apply_owner_confirmations(p, [self.right()])
        self.assertEqual(out["latest"]["cams"][0]["level"], "none")

    def test_the_input_is_not_changed(self):
        p = self.prev()
        before = json.dumps(p, sort_keys=True)
        qw.apply_owner_confirmations(p, [self.right()])
        self.assertEqual(json.dumps(p, sort_keys=True), before)

    def test_a_feed_with_no_groups_or_claims_is_fine(self):
        self.assertEqual(qw.apply_owner_confirmations({}, [self.right()]), {})


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
