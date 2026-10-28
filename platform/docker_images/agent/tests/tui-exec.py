"""archestra-tui-exec stops a failed turn's whole client process group and
captures the client's last screen."""
import os
from pathlib import Path
import pty
import re
import select
import shlex
import subprocess
import tempfile
import time
import unittest

BIN = Path(__file__).resolve().parents[1] / "bin"
if not BIN.is_dir():
    BIN = Path("/usr/local/bin")

# The leader marks the turn failed and exits on SIGTERM. A helper in its
# process group ignores SIGTERM and keeps writing, as a client backend that
# outlives its front end does.
CLIENT = """
( trap '' TERM; while :; do date +%s%N > "$1/helper.beat"; sleep 0.05; done ) &
echo $! > "$1/helper.pid"
trap 'exit 0' TERM
touch "$1/turn-complete.failed" "$1/turn-complete"
while :; do sleep 0.05; done
"""


class TuiExecTest(unittest.TestCase):
    def test_failed_turn_stops_every_process_in_the_client_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pid, fd = pty.fork()
            if pid == 0:
                os.environ.pop("TMUX_PANE", None)
                os.environ.pop("ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX", None)
                os.execv(str(BIN / "archestra-tui-exec"), ["archestra-tui-exec", str(root / "turn-complete"), str(root / "frame"), "/bin/sh", "-c", CLIENT, "client", str(root)])
            try:
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    if select.select([fd], [], [], 0.05)[0]:
                        try:
                            os.read(fd, 65536)
                        except OSError:
                            pass
                    exited, _ = os.waitpid(pid, os.WNOHANG)
                    if exited:
                        break
                else:
                    self.fail("archestra-tui-exec did not return after the failed turn")
                helper = int((root / "helper.pid").read_text())
                for _ in range(20):
                    if not Path(f"/proc/{helper}").exists() or "Z" in Path(f"/proc/{helper}/stat").read_text().split(")")[-1].split()[0]:
                        break
                    time.sleep(0.05)
                else:
                    self.fail("A process in the client's group outlived the failed turn")
                beat = (root / "helper.beat").stat().st_mtime
                time.sleep(0.3)
                self.assertEqual((root / "helper.beat").stat().st_mtime, beat, "The client's helper kept writing")
            finally:
                helper_pid = root / "helper.pid"
                if helper_pid.exists():
                    try:
                        os.kill(int(helper_pid.read_text()), 9)
                    except ProcessLookupError:
                        pass
                os.close(fd)
                try:
                    os.kill(pid, 9)
                    os.waitpid(pid, 0)
                except (ProcessLookupError, ChildProcessError):
                    pass

    def test_captured_screen_keeps_a_background_to_the_line_end(self):
        # A client's highlighted row paints its background to the pane's
        # edge with spaces; the capture must keep them, or the replayed row
        # stops at its last character.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            client = (
                "printf '\\033[48;5;235mab%38s\\033[0m\\n' ''; "
                'touch "$1/turn-complete.failed" "$1/turn-complete"; '
                "trap 'exit 0' TERM; while :; do sleep 0.05; done"
            )
            command = shlex.join([
                str(BIN / "archestra-tui-exec"),
                str(root / "turn-complete"),
                str(root / "frame"),
                "/bin/sh", "-c", client, "client", str(root),
            ])
            tmux = ["tmux", "-L", f"tui-exec-test-{os.getpid()}", "-f", "/dev/null"]
            environment = {
                key: value
                for key, value in os.environ.items()
                if key not in ("TMUX", "TMUX_PANE", "ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX")
            }
            subprocess.run(
                [*tmux, "new-session", "-d", "-x", "40", "-y", "5", command],
                check=True,
                env=environment,
            )
            try:
                frame = root / "frame"
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline and not (frame.exists() and frame.stat().st_size):
                    time.sleep(0.1)
                self.assertTrue(frame.exists(), "archestra-tui-exec wrote no frame")
                time.sleep(0.2)
                content = frame.read_text()
                self.assertTrue(content.startswith("\x1b]777;archestra-terminal-size=40x5\x07"))
                first_row = re.sub(r"\x1b\[[0-9;:]*m", "", content.split("\x07", 1)[1].split("\n")[0])
                self.assertEqual(first_row, "ab" + " " * 38)
            finally:
                subprocess.run(
                    [*tmux, "kill-server"],
                    check=False,
                    env=environment,
                    stderr=subprocess.DEVNULL,
                )


if __name__ == "__main__":
    unittest.main()
