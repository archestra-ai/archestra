# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml>=6.0"]
# ///
"""block destructive Bash commands before they run (PreToolUse guard)."""

import json
import re
import sys

payload = json.load(sys.stdin)
if payload.get("tool_name") == "Bash":
    command = payload.get("tool_input", {}).get("command", "")
    if re.search(r"\brm\s+-rf\s+/", command):
        print("refusing to run a destructive rm -rf on /", file=sys.stderr)
        sys.exit(2)
