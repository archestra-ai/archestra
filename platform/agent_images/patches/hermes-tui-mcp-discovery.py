"""Require completed gateway discovery before the Hermes TUI builds an agent.

The running entry module must share its thread handle with server._make_agent.
A bounded join alone still races slow discovery after the bound expires. Check
completion and gateway connection outside Hermes's best-effort wait handlers,
so startup failure cannot silently become a model request without MCP tools.
The build fails when upstream anchors move; upgrades require reviewing this
patch and running the real-client startup tests.
"""

import importlib.util
import sys
from pathlib import Path

ENTRY_ANCHOR = "def main():\n"
ENTRY_PATCH = (
    "def main():\n"
    "    # Archestra image patch: see agent_images/patches/hermes-tui-mcp-discovery.py\n"
    "    if __name__ == \"__main__\":\n"
    "        sys.modules[\"tui_gateway.entry\"] = sys.modules[__name__]\n"
)
SERVER_ANCHOR = "    cfg = _load_cfg()\n    agent_cfg = cfg.get(\"agent\") or {}\n"
WAIT_START = "    # MCP tool discovery runs in a background daemon thread at startup so a\n"
WAIT_END = "    cfg = _load_cfg()\n"
SERVER_PATCH = '''    # The Archestra gateway is required before the tool snapshot is built.
    from tui_gateway.entry import join_mcp_discovery
    from hermes_cli.mcp_startup import _resolve_discovery_timeout
    from tools.mcp_tool import get_mcp_status
    import subprocess

    def reject_gateway(message):
        subprocess.run(["archestra-mcp-startup-failure"], check=False)
        raise RuntimeError(message)

    if not join_mcp_discovery(timeout=_resolve_discovery_timeout(None)):
        reject_gateway("Archestra MCP gateway discovery timed out. Retry when the gateway is available.")
    gateway = next((s for s in get_mcp_status() if s["name"] == "archestra"), None)
    if not gateway or not gateway["connected"]:
        reject_gateway("Archestra MCP gateway discovery failed. Check gateway availability and access, then retry.")

''' + SERVER_ANCHOR

# Locate without importing: importing entry runs its startup code.
entry = Path(importlib.util.find_spec("tui_gateway.entry").origin)
server = entry.with_name("server.py")
entry_source = entry.read_text()
server_source = server.read_text()
if (
    entry_source.count(ENTRY_ANCHOR) != 1
    or "_mcp_discovery_thread = _mcp_thread" not in entry_source
    or server_source.count(SERVER_ANCHOR) != 1
    or "def join_mcp_discovery(" not in entry_source
    or server_source.count(WAIT_START) != 1
):
    sys.exit(f"Hermes TUI startup changed; review {Path(__file__).name}")
entry.write_text(entry_source.replace(ENTRY_ANCHOR, ENTRY_PATCH))
wait_start = server_source.index(WAIT_START)
wait_end = server_source.index(WAIT_END, wait_start)
server_source = server_source[:wait_start] + server_source[wait_end:]
server.write_text(server_source.replace(SERVER_ANCHOR, SERVER_PATCH))
