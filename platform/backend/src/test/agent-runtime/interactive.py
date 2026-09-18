import json
import os
from pathlib import Path

print("READY", flush=True)
Path("/tmp/cli-pid").write_text(str(os.getpid()))
for line in iter(input, "exit"):
    with Path("/tmp/received.jsonl").open("a") as received:
        received.write(json.dumps(line) + "\n")
    if line == "size":
        cols, rows = os.get_terminal_size()
        print(f"SIZE {cols}x{rows}", flush=True)
    else:
        print("ECHO " + line, flush=True)
