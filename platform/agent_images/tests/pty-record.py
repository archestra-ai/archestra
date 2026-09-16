"""Process ownership tests for the PTY recorder; run inside an agent image."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


RECORDER = shutil.which("archestra-pty-record")


def until(check, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.02)
    raise AssertionError("Condition did not become true")


def process_gone(pid):
    return not (Path("/proc") / str(pid)).exists()


class PtyRecorderContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not RECORDER:
            raise unittest.SkipTest("archestra-pty-record is not installed")
        if not Path("/proc").is_dir() or sys.platform != "linux":
            raise unittest.SkipTest("the subreaper contract requires Linux /proc")

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="archestra-pty-record-"))

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def recorder(self, name, *command):
        return subprocess.Popen(
            [
                RECORDER,
                "--pid-file",
                str(self.root / f"{name}.json"),
                str(self.root / f"{name}.log"),
                "--",
                *command,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_original_exit_status_is_preserved(self):
        process = self.recorder(
            "status",
            "python3",
            "-u",
            "-c",
            "import os; os.write(1, b'output\\n'); raise SystemExit(7)",
        )
        _, error = process.communicate(timeout=5)
        self.assertEqual(process.returncode, 7, error.decode(errors="replace"))
        state = json.loads((self.root / "status.json").read_text())
        self.assertEqual(state["exit"], 7)
        self.assertIn(b"output", (self.root / "status.log").read_bytes())

    def test_double_fork_setsid_descendant_is_killed_before_next_turn(self):
        script = """
import os, sys, time
from pathlib import Path
root = Path(sys.argv[1])
first = os.fork()
if first == 0:
    os.setsid()
    second = os.fork()
    if second == 0:
        pid = root / 'grandchild.pid'
        pid.write_text(str(os.getpid()))
        (root / 'ready').write_text('ready')
        time.sleep(1.0)
        (root / 'late-side-effect').write_text('late')
        while True:
            time.sleep(1)
    os._exit(0)
while not (root / 'ready').exists():
    time.sleep(.01)
raise SystemExit(0)
"""
        process = self.recorder("old", "python3", "-u", "-c", script, str(self.root))
        grandchild_pid = self.root / "grandchild.pid"
        until(grandchild_pid.exists)
        process.communicate(timeout=5)
        self.assertEqual(process.returncode, 0)
        grandchild = int(grandchild_pid.read_text())
        until(lambda: process_gone(grandchild))

        next_process = self.recorder(
            "next",
            "python3",
            "-u",
            "-c",
            "from pathlib import Path; Path(__import__('sys').argv[1]).write_text('next')",
            str(self.root / "next-turn"),
        )
        next_process.communicate(timeout=5)
        self.assertEqual(next_process.returncode, 0)
        self.assertEqual((self.root / "next-turn").read_text(), "next")
        time.sleep(1.2)
        self.assertFalse((self.root / "late-side-effect").exists())

    def test_signal_stop_reaps_detached_descendant(self):
        script = """
import os, signal, sys, time
from pathlib import Path
root = Path(sys.argv[1])
signal.signal(signal.SIGTERM, signal.SIG_IGN)
first = os.fork()
if first == 0:
    os.setsid()
    second = os.fork()
    if second == 0:
        pid = root / 'grandchild.pid'
        pid.write_text(str(os.getpid()))
        time.sleep(1.0)
        (root / 'late-side-effect').write_text('late')
        while True: time.sleep(1)
    os._exit(0)
while True:
    time.sleep(1)
"""
        process = self.recorder("old", "python3", "-u", "-c", script, str(self.root))
        grandchild_pid = self.root / "grandchild.pid"
        until(grandchild_pid.exists)
        process.terminate()
        process.communicate(timeout=5)
        grandchild = int(grandchild_pid.read_text())
        until(lambda: process_gone(grandchild))

        next_process = self.recorder(
            "next",
            "python3",
            "-u",
            "-c",
            "from pathlib import Path; Path(__import__('sys').argv[1]).write_text('next')",
            str(self.root / "next-turn"),
        )
        next_process.communicate(timeout=5)
        self.assertEqual(next_process.returncode, 0)
        self.assertEqual((self.root / "next-turn").read_text(), "next")
        time.sleep(1.2)
        self.assertFalse((self.root / "late-side-effect").exists())


if __name__ == "__main__":
    unittest.main()
