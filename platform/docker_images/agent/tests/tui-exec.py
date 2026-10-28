"""archestra-tui-exec stops a failed turn's whole client process group."""
import os
from pathlib import Path
import pty
import select
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


if __name__ == "__main__":
    unittest.main()
