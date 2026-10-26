"""Require completed gateway discovery before the Hermes TUI builds an agent.

Hermes waits for MCP discovery before it snapshots an agent's tools, but
swallows every failure and builds the agent with whatever tools exist, and no
config key makes a server required. Replace that wait with one bounded join
and a gateway connection check, so startup failure cannot silently become a
model request without MCP tools. The build fails when upstream anchors move;
upgrades require reviewing this patch and running the real-client startup
tests.
"""

import importlib.util
import sys
from pathlib import Path

ANCHOR = (
    '    for _mod in ("hermes_cli.mcp_startup", "tui_gateway.entry"):\n'
    "        with contextlib.suppress(Exception):\n"
    "            importlib.import_module(_mod).wait_for_mcp_discovery()\n"
    "    cfg = _load_cfg()\n"
)
# Replaces upstream's wait, which can run up to twice the discovery timeout
# before this check would start.
PATCH = '''    # Archestra image patch: see docker_images/agent/patches/hermes-tui-mcp-discovery.py
    from hermes_cli import mcp_startup as _archestra_mcp
    from tools.mcp_tool_discovery import get_mcp_status as _archestra_mcp_status

    def _archestra_reject(message):
        subprocess.run(["archestra-mcp-startup-failure"], check=False)
        raise RuntimeError(message)

    # An agent can be built before the deferred discovery thread starts.
    # Joining an absent thread reports success without discovering any tools.
    _archestra_mcp.start_background_mcp_discovery(
        logger=logger, thread_name="archestra-mcp-discovery"
    )
    if not _archestra_mcp.join_mcp_discovery(
        timeout=_archestra_mcp._resolve_discovery_timeout(None)
    ):
        _archestra_reject("Archestra MCP gateway discovery timed out. Retry when the gateway is available.")
    _archestra_gateway = next(
        (s for s in _archestra_mcp_status() if s.get("name") == "archestra"), None
    )
    if not _archestra_gateway or not _archestra_gateway.get("connected"):
        _archestra_reject("Archestra MCP gateway discovery failed. Check gateway availability and access, then retry.")
    cfg = _load_cfg()
'''

# Locate without importing: importing these modules runs startup code.
server = Path(importlib.util.find_spec("tui_gateway").origin).with_name("server.py")
mcp_startup = Path(importlib.util.find_spec("hermes_cli").origin).with_name("mcp_startup.py")
discovery = Path(importlib.util.find_spec("tools").origin).with_name("mcp_tool_discovery.py")
server_source = server.read_text()
if (
    server_source.count(ANCHOR) != 1
    or "\nimport subprocess\n" not in server_source
    or "def join_mcp_discovery(" not in mcp_startup.read_text()
    or "def start_background_mcp_discovery(" not in mcp_startup.read_text()
    or "def _resolve_discovery_timeout(" not in mcp_startup.read_text()
    or "def get_mcp_status(" not in discovery.read_text()
):
    sys.exit(f"Hermes TUI startup changed; review {Path(__file__).name}")
server.write_text(server_source.replace(ANCHOR, PATCH))
