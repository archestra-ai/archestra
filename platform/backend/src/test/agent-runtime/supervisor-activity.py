from pathlib import Path
import subprocess
import time

from terminal import Viewer, until

RUNTIME = "/var/run/archestra/runtime"


def activity():
    try:
        return int(Path("/var/run/archestra/development-activity").read_text())
    except (FileNotFoundError, ValueError):
        return 0


viewer = Viewer([RUNTIME, "attach"])
try:
    until(lambda: activity() > 0, "Attachment was not recorded as activity")
    initial = activity()
    Path("/tmp/daemon.sh").write_text("while :; do echo daemon-output; sleep 1; done")
    subprocess.run([RUNTIME, "launch", "/tmp/daemon.sh"], check=True)
    time.sleep(2)
    assert activity() == initial, "Daemon output refreshed idle retention"
    viewer.send("hello")
    until(lambda: activity() > initial, "Terminal input was not recorded as activity")
    typed = activity()
    time.sleep(1.1)
    viewer.disconnect()
    until(lambda: activity() > typed, "Detachment was not recorded as activity")
finally:
    viewer.close()
