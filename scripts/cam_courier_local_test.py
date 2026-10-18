"""End-to-end tests for scripts/cam_courier_local.sh with FAKE yt-dlp, ffmpeg and curl.
Run from the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

No network and nothing of the real machine is touched: the fake tools sit first on PATH
(COURIER_BIN_DIR), the pacer state, the run lock and the token file live in a temp dir.
"""

import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import courier_schedule as cs  # noqa: E402
import yt_pacer as yp  # noqa: E402

N_CAMS = len(cs.grabbable(cs.load_registry()))  # every courier cam in config

SCRIPT = HERE / "cam_courier_local.sh"
NOON = "2026-10-17T16:03:00Z"  # 12:03 EDT, outside every golden window

FAKE_YTDLP = r"""#!/bin/bash
echo "yt-dlp $*" >> "$FAKE_LOG"
vid="${@: -1}"; vid="${vid##*v=}"
case ",$FAKE_BOT," in *",$vid,"*)
  echo "ERROR: [youtube] $vid: Sign in to confirm you’re not a bot. Use --cookies" >&2; exit 1;; esac
case ",$FAKE_FAIL," in *",$vid,"*) echo "ERROR: Video unavailable" >&2; exit 1;; esac
echo "https://manifest.googlevideo.com/api/manifest/hls_playlist/expire/9999999999/ei/$vid"
"""
FAKE_FFMPEG = r"""#!/bin/bash
echo "ffmpeg $*" >> "$FAKE_LOG"
for last; do :; done
head -c 30000 /dev/zero > "$last"
"""
FAKE_CURL = r"""#!/bin/bash
echo "curl $*" >> "$FAKE_LOG"
out=""; prev=""
for a in "$@"; do
  [[ "$prev" == "-o" ]] && out="$a"
  prev="$a"
done
body="${FAKE_BODY:-}"; [[ -z "$body" ]] && body='{"ok":true}'
echo "$body" > "$out"
printf '%s' "${FAKE_HTTP:-200}"
"""


class CourierShellTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = Path(self.tmp.name)
        self.bin = d / "bin"
        self.bin.mkdir()
        for name, body in (("yt-dlp", FAKE_YTDLP), ("ffmpeg", FAKE_FFMPEG), ("curl", FAKE_CURL)):
            f = self.bin / name
            f.write_text(body)
            f.chmod(f.stat().st_mode | stat.S_IXUSR)
        self.log = d / "calls.log"
        self.log.write_text("")
        self.token = d / "token"
        self.token.write_text("tok")
        self.state = d / "state"
        self.env = dict(
            os.environ,
            COURIER_BIN_DIR=str(self.bin), FAKE_LOG=str(self.log), TOKEN_FILE=str(self.token),
            YTPACE_DIR=str(self.state), COURIER_LOCK_DIR=str(d / "lock"), YTPACE_MIN_GAP_S="0",
            COURIER_URL="http://courier.invalid", FAKE_BOT="", FAKE_FAIL="",
        )

    def run_script(self, *args, **env):
        e = dict(self.env, **env)
        return subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True, env=e, timeout=120)

    def calls(self, tool):
        return [l for l in self.log.read_text().splitlines() if l.startswith(tool + " ")]

    def notes(self):
        return yp.Pacer(self.state, quiet=True).courier_notes()

    def test_a_forced_run_grabs_every_cam_in_config_and_uploads_each(self):
        r = self.run_script("--force")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(self.calls("yt-dlp")), N_CAMS)
        ups = self.calls("curl")
        self.assertEqual(len(ups), N_CAMS)
        self.assertTrue(any("cam=pensacola-sria-west-cam" in u for u in ups))
        self.assertTrue(any("cam=deerfield-spinner-uw" in u for u in ups))
        self.assertIn(f"done (all): {N_CAMS}/{N_CAMS} cams uploaded", r.stdout)
        last, fails = self.notes()
        self.assertEqual(len(last), N_CAMS)
        self.assertEqual(fails, {})

    def test_a_routine_run_takes_only_a_few_due_cams_and_names_no_cam_itself(self):
        r = self.run_script(COURIER_NOW=NOON)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(self.calls("yt-dlp")), cs.routine_run_cap(N_CAMS))  # the run cap, not every cam
        self.assertLess(cs.routine_run_cap(N_CAMS), N_CAMS)
        self.assertEqual(len(self.calls("curl")), cs.routine_run_cap(N_CAMS))
        text = SCRIPT.read_text()
        for needle in ("deerfield-beach-cam", "rdeoEeJ00xA", "HKIc6CYlMzI", "ftl-elbo-beach-cam", "pensacola-sria-west-cam"):
            self.assertNotIn(needle, text)  # the cam list lives in config, not in the shell

    def test_a_routine_run_at_night_is_silent_and_does_nothing(self):
        r = self.run_script(COURIER_NOW="2026-10-17T05:03:00Z")  # 01:03 EDT
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")
        self.assertEqual(self.calls("yt-dlp"), [])

    def test_a_golden_run_outside_every_window_is_silent_and_does_nothing(self):
        r = self.run_script("--golden-only", COURIER_NOW=NOON)
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), "")
        self.assertEqual(self.calls("yt-dlp"), [])

    def test_a_golden_run_inside_a_window_grabs_only_the_cams_of_that_beach(self):
        r = self.run_script("--golden-only", COURIER_NOW="2026-10-17T22:30:00Z")  # Deerfield + Fort Lauderdale sunset window
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        ups = " ".join(self.calls("curl"))
        self.assertIn("cam=deerfield-beach-cam", ups)
        self.assertNotIn("cam=pensacola-sria-west-cam", ups)
        tiers = {c[1] for c in json.loads((self.state / "state.json").read_text())["calls"]}
        self.assertEqual(tiers, {"golden"})

    def test_a_bot_check_stops_the_run_and_every_later_run_for_20_minutes(self):
        r = self.run_script("--force", FAKE_BOT="hIeFPNHfuoY")  # the second cam's stream
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(self.calls("yt-dlp")), 2)  # beach cam ok, surf cam hit the bot check, the rest never tried
        self.assertEqual(len(self.calls("curl")), 1)
        self.assertIn("BOT CHECK", r.stderr + r.stdout)
        self.assertIn("backoff", r.stdout)
        doc = json.loads((self.state / "state.json").read_text())
        self.assertGreater(doc["backoff"]["until"] - time.time(), 19 * 60)
        before = len(self.calls("yt-dlp"))
        r2 = self.run_script("--force")
        self.assertEqual(r2.returncode, 0)
        self.assertIn("backoff active", r2.stdout)
        self.assertEqual(len(self.calls("yt-dlp")), before)  # not one more call from any job

    def test_a_failing_cam_gets_a_cooldown_and_the_other_cams_still_run(self):
        r = self.run_script("--force", FAKE_FAIL="H33wtprQqSM")  # the pier cam
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(self.calls("curl")), N_CAMS - 1)
        last, fails = self.notes()
        self.assertEqual(list(fails), ["deerfield-pier-cam"])
        self.assertNotIn("deerfield-pier-cam", last)
        self.assertIn(f"{N_CAMS - 1}/{N_CAMS} cams uploaded", r.stdout)

    def test_a_remembered_stream_id_replaces_the_one_in_config(self):
        yp.Pacer(self.state, quiet=True).cache_put("vid:deerfield-pier-cam", "REDISCOVERED1", 3600)
        self.run_script("--force")
        self.assertTrue(any("v=REDISCOVERED1" in c for c in self.calls("yt-dlp")))
        self.assertFalse(any("v=H33wtprQqSM" in c for c in self.calls("yt-dlp")))

    def test_an_upload_the_worker_refuses_is_logged_with_its_http_code_and_counts_as_a_failure(self):
        r = self.run_script("--force", FAKE_HTTP="400")
        self.assertIn("upload failed (HTTP 400)", r.stdout)
        self.assertEqual(r.returncode, 1)
        _, fails = self.notes()
        self.assertEqual(len(fails), N_CAMS)

    def test_a_refusal_is_logged_with_the_workers_reply_body(self):
        body = '{"ok":false,"error":"bad body","reason":"too-small","bytes":3000}'
        r = self.run_script("--force", FAKE_HTTP="400", FAKE_BODY=body)
        self.assertIn("upload failed (HTTP 400)", r.stdout)
        self.assertIn('"reason":"too-small"', r.stdout)

    def test_a_blank_frame_refusal_says_so_and_cools_the_cam_down(self):
        body = '{"ok":false,"error":"blank frame","reason":"blank","bytes":30000}'
        r = self.run_script("--force", FAKE_HTTP="422", FAKE_BODY=body)
        self.assertIn("refused the frame as blank (HTTP 422", r.stdout)
        self.assertIn('"reason":"blank"', r.stdout)
        self.assertEqual(r.returncode, 1)
        _, fails = self.notes()
        self.assertEqual(len(fails), 7)  # a stream with no picture is retried later, not every run

    def test_an_over_budget_run_skips_without_failing_or_cooling_the_cams(self):
        r = self.run_script("--force", YTPACE_CAP_ROUTINE="0")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.calls("yt-dlp"), [])
        self.assertIn("over the yt-dlp call budget", r.stdout)
        _, fails = self.notes()
        self.assertEqual(fails, {})

    def test_the_dry_run_grabs_nothing_and_writes_no_cam_state(self):
        r = self.run_script("--dry-run", COURIER_NOW=NOON)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("dry run", r.stdout)
        self.assertIn("|", r.stdout)
        self.assertEqual(self.calls("yt-dlp"), [])
        self.assertEqual(self.calls("curl"), [])

    def test_two_runs_at_once_do_not_double_grab(self):
        lock = Path(self.tmp.name) / "lock"
        # a live "courier" holds the lock: this run must exit at once
        holder = subprocess.Popen(["bash", "-c", "exec -a cam_courier_local.sh sleep 5"])
        self.addCleanup(lambda: (holder.kill(), holder.wait()))
        lock.mkdir()
        (lock / "owner").write_text(f"{holder.pid} tok\n")
        r = self.run_script("--force")
        self.assertEqual(r.returncode, 0)
        self.assertIn("still going", r.stdout)
        self.assertEqual(self.calls("yt-dlp"), [])


if __name__ == "__main__":
    unittest.main()
