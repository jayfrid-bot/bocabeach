"""Tests for scripts/courier_lock.sh (the courier's run lock). Run from the repo root:

    python3 -m unittest discover -s scripts -p "*_test.py" -v

Real bash subprocesses, a temp lock directory, no network. Each "run" is started
as `bash -c <code> cam_courier_local.sh`, so `ps -p <pid> -o command=` shows
cam_courier_local.sh exactly as a real courier run does.
"""

import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

LOCK_SH = Path(__file__).resolve().parent / "courier_lock.sh"


class LockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.lock = self.dir / "courier.lock"
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()
                p.wait()
            if p.stdout:
                p.stdout.close()
        self.tmp.cleanup()

    # --- helpers -----------------------------------------------------------

    def code(self, body, hook=""):
        return (
            "set -euo pipefail\n"
            f'log() {{ echo "log: $1"; }}\n'
            f'LOCK_DIR="{self.lock}"\nexport COURIER_LOCK_WAIT_S="${{COURIER_LOCK_WAIT_S:-1}}"\n'
            f'source "{LOCK_SH}"\n'
            f"{hook}\n{body}\n"
        )

    def start(self, body, hook="", **env):
        p = subprocess.Popen(
            ["bash", "-c", self.code(body, hook), "cam_courier_local.sh"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            env={**os.environ, **{k: str(v) for k, v in env.items()}},
        )
        self.procs.append(p)
        return p

    def run_to_end(self, body, hook="", timeout=20, **env):
        p = self.start(body, hook, **env)
        out, _ = p.communicate(timeout=timeout)
        return p.returncode, out

    def wait_for(self, path, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            if Path(path).exists():
                return
            time.sleep(0.02)
        self.fail(f"timed out waiting for {path}")

    def owner(self):
        try:
            return (self.lock / "owner").read_text().strip()
        except FileNotFoundError:
            return None

    HOLD = 'courier_lock_acquire; echo held > "$READY"; while [ ! -e "$STOP" ]; do sleep 0.05; done; courier_lock_release'

    def holder(self, name="p1"):
        ready, stop = self.dir / f"{name}.ready", self.dir / f"{name}.stop"
        p = self.start(self.HOLD, READY=ready, STOP=stop)
        self.wait_for(ready)
        return p, stop

    # --- basics ------------------------------------------------------------

    def test_acquire_writes_a_token_owner_and_release_removes_the_lock(self):
        code, out = self.run_to_end('courier_lock_acquire && cat "$LOCK_DIR/owner" && courier_lock_release')
        self.assertEqual(code, 0, out)
        pid, token = out.strip().splitlines()[-1].split(" ", 1)
        self.assertRegex(pid, r"^[1-9][0-9]*$")
        self.assertIn(pid, token)
        self.assertFalse(self.lock.exists())
        self.assertEqual(list(self.dir.glob("courier.lock*")), [], "no temp or stale debris")

    def test_two_runs_get_different_tokens(self):
        a = self.run_to_end('courier_lock_acquire; echo "$COURIER_LOCK_OWNER"; courier_lock_release')[1]
        b = self.run_to_end('courier_lock_acquire; echo "$COURIER_LOCK_OWNER"; courier_lock_release')[1]
        self.assertNotEqual(a.strip().splitlines()[-1], b.strip().splitlines()[-1])

    def test_a_live_courier_run_blocks_a_second_one(self):
        holder, stop = self.holder()
        before = self.owner()
        code, out = self.run_to_end("courier_lock_acquire")
        self.assertEqual(code, 1)
        self.assertIn("still going", out)
        self.assertEqual(self.owner(), before, "the holder's lock is untouched")
        stop.write_text("x")
        holder.wait(timeout=10)
        self.assertFalse(self.lock.exists(), "the holder released on the way out")

    # --- stale locks -------------------------------------------------------

    def make_lock(self, owner_text):
        self.lock.mkdir()
        if owner_text is not None:
            (self.lock / "owner").write_text(owner_text + "\n")

    def test_a_dead_pid_is_reclaimed(self):
        dead = subprocess.Popen(["true"])
        dead.wait()
        self.make_lock(f"{dead.pid} old-token")
        code, out = self.run_to_end("courier_lock_acquire")
        self.assertEqual(code, 0, out)
        self.assertIn("reclaiming", out)
        self.assertNotIn("old-token", self.owner() or "")

    def test_a_live_pid_that_is_not_a_courier_run_is_reclaimed(self):
        other = subprocess.Popen(["sleep", "30"])
        self.procs.append(other)
        self.make_lock(f"{other.pid} recycled-pid-token")
        code, out = self.run_to_end("courier_lock_acquire")
        self.assertEqual(code, 0, out)
        self.assertIn("not a live courier run", out)

    def test_a_malformed_pid_is_never_trusted(self):
        for bad in ["abc tok", "0 tok", "-1 tok", "12.5 tok", "1;2 tok", "tok"]:
            with self.subTest(owner=bad):
                if self.lock.exists():
                    subprocess.run(["rm", "-rf", str(self.lock)], check=True)
                self.make_lock(bad)
                code, out = self.run_to_end('courier_lock_acquire && courier_lock_release')
                self.assertEqual(code, 0, out)

    def test_a_dir_that_stays_ownerless_is_reclaimed_but_only_after_the_wait(self):
        self.make_lock(None)
        t0 = time.time()
        code, out = self.run_to_end("courier_lock_acquire", COURIER_LOCK_WAIT_S=1)
        self.assertEqual(code, 0, out)
        self.assertGreaterEqual(time.time() - t0, 0.9, "it waited instead of reclaiming at once")
        self.assertIn("no owner after 1s", out)

    # --- the two races Codex named ------------------------------------------

    def test_a_process_paused_between_mkdir_and_owner_write_is_not_robbed(self):
        # P1 wins mkdir, then stalls before it writes the owner file.
        paused, go = self.dir / "paused", self.dir / "go"
        hook = f'_courier_lock_hook() {{ : > "{paused}"; while [ ! -e "{go}" ]; do sleep 0.02; done; }}'
        ready, stop = self.dir / "p1.ready", self.dir / "p1.stop"
        p1 = self.start(self.HOLD, hook, READY=ready, STOP=stop)
        self.wait_for(paused)
        self.assertTrue(self.lock.is_dir())
        self.assertIsNone(self.owner(), "P1 is mid-acquire: no owner yet")

        # P2 starts now. It must NOT reclaim the ownerless dir at once. It waits
        # ~1 s; meanwhile P1 resumes and writes its owner.
        p2 = self.start("courier_lock_acquire && echo rc=0 || echo rc=1", COURIER_LOCK_WAIT_S=1)
        time.sleep(0.3)
        self.assertTrue(self.lock.is_dir(), "P2 did not reclaim the ownerless dir immediately")
        self.assertIsNone(p2.poll(), "P2 is still waiting")
        go.write_text("x")
        self.wait_for(ready)

        out, _ = p2.communicate(timeout=20)
        self.assertIn("still going", out)
        self.assertIn("rc=1", out, out)
        self.assertEqual(self.owner().split()[0], str(p1.pid), "P1 still owns the lock")
        stop.write_text("x")
        p1.wait(timeout=10)
        self.assertFalse(self.lock.exists())

    def test_an_old_runs_cleanup_cannot_delete_a_lock_another_run_took(self):
        # P1 holds, then (as if judged dead and reclaimed) its lock dir is replaced by P2's.
        ready, stop = self.dir / "p1.ready", self.dir / "p1.stop"
        p1 = self.start(self.HOLD, READY=ready, STOP=stop)
        self.wait_for(ready)
        subprocess.run(["rm", "-rf", str(self.lock)], check=True)  # the reclaim

        ready2, stop2 = self.dir / "p2.ready", self.dir / "p2.stop"
        p2 = self.start(self.HOLD, READY=ready2, STOP=stop2)
        self.wait_for(ready2)
        p2_owner = self.owner()
        self.assertEqual(p2_owner.split()[0], str(p2.pid))

        stop.write_text("x")  # P1 now runs its exit-time release
        p1.wait(timeout=10)
        self.assertTrue(self.lock.is_dir(), "P1's cleanup left P2's lock alone")
        self.assertEqual(self.owner(), p2_owner)

        stop2.write_text("x")
        p2.wait(timeout=10)
        self.assertFalse(self.lock.exists(), "P2 removes its own lock")

    def test_release_without_holding_anything_is_harmless(self):
        self.make_lock("999999 someone-elses-token")
        code, out = self.run_to_end("courier_lock_release")
        self.assertEqual(code, 0, out)
        self.assertEqual(self.owner(), "999999 someone-elses-token")

    def test_two_runs_started_together_never_both_win(self):
        results = self.dir / "results"
        results.mkdir()
        body = (
            'if courier_lock_acquire; then echo won > "$RESULTS/$$"; sleep 1.5; courier_lock_release; '
            'else echo lost > "$RESULTS/$$"; fi'
        )
        ps = [self.start(body, RESULTS=results) for _ in range(6)]
        for p in ps:
            p.communicate(timeout=30)
        verdicts = sorted(f.read_text().strip() for f in results.iterdir())
        self.assertEqual(verdicts.count("won"), 1, verdicts)
        self.assertEqual(verdicts.count("lost"), 5, verdicts)


if __name__ == "__main__":
    unittest.main()
