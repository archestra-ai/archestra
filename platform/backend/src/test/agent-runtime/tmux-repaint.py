import base64
import json
import subprocess

from terminal import Viewer

RUNTIME = "/var/run/archestra/runtime"
first = Viewer([RUNTIME, "attach"], cols=60, rows=8)
second = Viewer([RUNTIME, "attach"], cols=60, rows=8)
try:
    first.expect("VISIBLE-FINAL-FRAME")
    second.expect("VISIBLE-FINAL-FRAME")
    first.send("\x02d")
    assert first.wait() == 0
    first.drain()
    subprocess.run([RUNTIME, "alive"], check=True)
    clients = subprocess.check_output([
        "tmux", "list-clients", "-t", "=agent", "-F", "#{client_pid}"
    ])
    assert len(clients.splitlines()) == 1
    second.send("follow-up\n")
    second.expect("SECOND-VIEWER-STILL-LIVE")
    subprocess.run([RUNTIME, "stop"], check=True)
    assert second.wait() == 0
    second.drain()
    print(json.dumps([
        base64.b64encode(bytes(viewer.output)).decode() for viewer in (first, second)
    ]))
finally:
    first.close()
    second.close()
