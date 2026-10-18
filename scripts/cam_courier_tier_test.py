"""Tests for the courier's slow-cam tier (scripts/cam_courier_local.sh). Run from the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

The script is not sourced (it runs on load). The test pulls out the CAMS array and the
two small functions and runs them in a real bash. No network.
"""

import json
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "cam_courier_local.sh"
TEXT = SCRIPT.read_text(encoding="utf-8")

# The ten Gulf and Keys cams added 2026-10-16: pulled every third hour only.
SLOW_IDS = {
    "siesta-beach-cam", "white-sands-ami-cam", "holmes-beach-cam", "margaritaville-fmb-cam",
    "pink-shell-fmb-cam", "enco-sterling-reef-cam", "enco-shores-of-panama-cam", "sharkys-pcb-cam",
    "fort-zachary-taylor-cam", "sunset-grille-marathon-cam",
}


def cams_array():
    body = re.search(r"^CAMS=\(\n(.*?)^\)", TEXT, flags=re.S | re.M).group(1)
    return re.findall(r'^\s*"([^"]+)"', body, flags=re.M)


def function_text(name):
    m = re.search(rf"^{name}\(\) \{{\n.*?^\}}", TEXT, flags=re.S | re.M)
    assert m, f"{name} not found"
    return m.group(0)


def due(tier, hour, force=0, golden=0):
    code = "\n".join([
        f"FORCE={force}; GOLDEN_ONLY={golden}",
        function_text("slow_cam_due"),
        function_text("cam_due"),
        f'cam_due "{tier}" "{hour}" && echo due || echo skip',
    ])
    return subprocess.run(["bash", "-c", code], capture_output=True, text=True, check=True).stdout.strip() == "due"


class TierTests(unittest.TestCase):
    def test_the_ten_new_cams_are_slow_and_the_older_ones_are_not(self):
        entries = cams_array()
        slow = {e.split(":")[0] for e in entries if e.endswith(":slow")}
        self.assertEqual(slow, SLOW_IDS)
        self.assertEqual(len(entries), 17)

    def test_every_sun_cam_is_in_the_array_with_its_youtube_id(self):
        entries = {e.split(":")[0]: e.split(":")[1] for e in cams_array()}
        for cam in json.loads((ROOT / "config" / "sun-cams.json").read_text(encoding="utf-8"))["cams"]:
            self.assertEqual(entries.get(cam["id"]), cam["youtube_id"], cam["id"])

    def test_a_normal_cam_is_always_due(self):
        for hour in ("00", "07", "10", "13"):
            self.assertTrue(due("", hour))
            self.assertTrue(due("", hour, golden=1))

    def test_a_slow_cam_is_due_only_at_a_surface_hour(self):
        due_hours = [f"{h:02d}" for h in range(24) if due("slow", f"{h:02d}")]
        self.assertEqual(due_hours, ["01", "04", "07", "10", "13", "16", "19", "22"])

    def test_the_eastern_daylight_runs_that_reach_a_slow_cam_are_five_a_day(self):
        # The hourly job only runs 06:00-20:00 Eastern (the script's own gate). In summer
        # (UTC-4) that keeps UTC hours 10..00; in winter (UTC-5) 11..01.
        for offset in (4, 5):
            hours = [h for h in range(24) if 6 <= (h - offset) % 24 <= 20 and due("slow", f"{h:02d}")]
            self.assertLessEqual(len(hours), 5)
            self.assertGreaterEqual(len(hours), 4)

    def test_a_slow_cam_skips_every_golden_run_even_at_a_surface_hour(self):
        self.assertFalse(due("slow", "13", golden=1))

    def test_force_grabs_a_slow_cam_at_any_hour(self):
        self.assertTrue(due("slow", "14", force=1))
        self.assertTrue(due("slow", "14", force=1, golden=1))


if __name__ == "__main__":
    unittest.main()
