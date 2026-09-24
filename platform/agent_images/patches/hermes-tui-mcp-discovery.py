"""Make the Hermes TUI wait for MCP discovery before its first agent build.

Hermes 0.19 starts the TUI gateway as `python -m tui_gateway.entry`, so the
discovery thread handle lives in `__main__`. `_make_agent` then imports
`tui_gateway.entry` by name, gets a second copy whose handle is None, and never
waits. The first turn races discovery and can go out without the gateway tools.
Registering the running module under its package name makes both lookups see
the same handle. The build fails if the anchor moves, so a Hermes upgrade that
changes this code is noticed instead of silently unpatched.
"""

import importlib.util
import sys
from pathlib import Path

ANCHOR = "def main():\n"
PATCH = (
    "def main():\n"
    "    # Archestra image patch: see agent_images/patches/hermes-tui-mcp-discovery.py\n"
    "    if __name__ == \"__main__\":\n"
    "        sys.modules[\"tui_gateway.entry\"] = sys.modules[__name__]\n"
)

# Locate the module without importing it: import runs its startup code.
path = Path(importlib.util.find_spec("tui_gateway.entry").origin)
source = path.read_text()
if source.count(ANCHOR) != 1 or "_mcp_discovery_thread = _mcp_thread" not in source:
    sys.exit(f"Hermes TUI entry changed; review {Path(__file__).name}")
path.write_text(source.replace(ANCHOR, PATCH))
