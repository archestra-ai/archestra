"""Shared behavior: only the public runtime commands and a normal PTY client."""

import json
import os
from pathlib import Path
import subprocess
import sys

from terminal import Viewer, until

RUNTIME = "/var/run/archestra/runtime"


def runtime(*args):
    return subprocess.check_output([RUNTIME, *args], text=True).strip()


def launch():
    runtime("initialize")
    assert runtime("geometry") == "120x40"
    Path("/tmp/interactive.sh").write_text(
        "exec python3 -u /tmp/runtime-fixtures/interactive.py\n"
    )
    runtime("launch", "/tmp/interactive.sh")
    until(lambda: Path("/tmp/cli-pid").exists(), "CLI never started")


def input_and_geometry():
    launch()
    viewer = Viewer([RUNTIME, "attach"])
    try:
        viewer.expect("READY")
        literal = '-n literal $(touch /tmp/injected); "quotes" and café [exited]'
        runtime("submit", literal)
        until(lambda: Path("/tmp/received.jsonl").exists(), "Input never reached CLI")
        assert json.loads(Path("/tmp/received.jsonl").read_text()) == literal
        assert not Path("/tmp/injected").exists(), "Input was evaluated as shell"
        assert literal in runtime("capture")
        viewer.resize(93, 31)
        until(lambda: runtime("geometry").startswith("93x"), "Resize did not reach terminal")
        geometry = runtime("geometry")
        assert 0 < int(geometry.split("x")[1]) <= 31
        viewer.send("size\n")
        viewer.expect("SIZE " + geometry)
        viewer.send("exit\n")
        until(
            lambda: subprocess.run([RUNTIME, "alive"]).returncode != 0,
            "Exited CLI remained alive",
        )
    finally:
        runtime("stop")
        viewer.close()


def independent_viewers():
    launch()
    original_pid = int(Path("/tmp/cli-pid").read_text())
    first, second = Viewer([RUNTIME, "attach"]), Viewer([RUNTIME, "attach"])
    try:
        first.expect("READY")
        second.expect("READY")
        first.disconnect()
        runtime("alive")
        os.kill(original_pid, 0)
        second.send("VIEWER_TWO\n")
        second.expect("ECHO VIEWER_TWO")
        with Path("/tmp/received.jsonl").open() as received:
            assert [json.loads(line) for line in received] == ["VIEWER_TWO"]
        runtime("stop")
        second.wait()
        assert subprocess.run([RUNTIME, "ready"]).returncode != 0
    finally:
        runtime("stop")
        first.close()
        second.close()


{"input": input_and_geometry, "viewers": independent_viewers}[sys.argv[1]]()
print("VERIFIED")
