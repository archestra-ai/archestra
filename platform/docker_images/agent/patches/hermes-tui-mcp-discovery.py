"""Require completed gateway discovery before Hermes builds any agent.

Hermes's TUI now uses the persistent gateway, bypassing its old TUI agent
factory. Guard the shared AIAgent constructor before it snapshots tools. Hermes
swallows every failure and builds the agent with whatever tools exist, and no
config key makes a server required. Use one bounded join
and a gateway connection check, so startup failure cannot silently become a
model request without MCP tools. The build fails when upstream anchors move;
upgrades require reviewing this patch and running the real-client startup
tests.
"""

import importlib.util
import sys
from pathlib import Path

ANCHOR = '        init_kwargs = {k: v for k, v in locals().items() if k not in ("self", "tool_delay")}\n'
# Apply the same required-gateway check to every constructor path, including
# the persistent gateway used by the TUI from Hermes 0.22.5 onward.
PATCH = '''    # Archestra image patch: see docker_images/agent/patches/hermes-tui-mcp-discovery.py
    import subprocess
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
    # The persistent gateway exposes its HTTP session before tools/list
    # succeeds. A transport alone is not a usable gateway tool snapshot.
    if not _archestra_gateway or not _archestra_gateway.get("connected") or not _archestra_gateway.get("tools"):
        _archestra_reject("Archestra MCP gateway discovery failed. Check gateway availability and access, then retry.")
'''
# The shared constructor is one level deeper than the old TUI factory.
PATCH = ANCHOR + ''.join('    ' + line if line.strip() else line for line in PATCH.splitlines(keepends=True))

# Locate without importing: importing these modules runs startup code.
agent = Path(importlib.util.find_spec("run_agent").origin)
mcp_startup = Path(importlib.util.find_spec("hermes_cli").origin).with_name("mcp_startup.py")
discovery = Path(importlib.util.find_spec("tools").origin).with_name("mcp_tool_discovery.py")
agent_source = agent.read_text()
if (
    agent_source.count(ANCHOR) != 1
    or "# Archestra image patch: see docker_images/agent/patches/hermes-tui-mcp-discovery.py" in agent_source
    or "def __init__(" not in agent_source
    or "def join_mcp_discovery(" not in mcp_startup.read_text()
    or "def start_background_mcp_discovery(" not in mcp_startup.read_text()
    or "def _resolve_discovery_timeout(" not in mcp_startup.read_text()
    or "def get_mcp_status(" not in discovery.read_text()
):
    sys.exit(f"Hermes TUI startup changed; review {Path(__file__).name}")
agent.write_text(agent_source.replace(ANCHOR, PATCH))
