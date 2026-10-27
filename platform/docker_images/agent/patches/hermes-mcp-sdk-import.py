"""Import the MCP SDK before Hermes starts its discovery thread.

Hermes imports the MCP SDK lazily, on the background discovery thread, while
the main thread is still importing the agent. That first import pulls in
OpenTelemetry, whose entry-point lookup runs at import time and is cached for
the whole process. Under concurrent startup the lookup can come back without
OpenTelemetry's context entry point, or an SDK module fails to import. Hermes
then treats the SDK, or its HTTP transport, as unavailable for the rest of the
process: discovery ends without contacting the gateway, and every retry fails
the same way.

Import the SDK on the caller's thread, outside the discovery lock, before any
discovery thread starts. This puts the import (under a second) on the startup
path that upstream defers; the runtime needs the gateway tools before its first
turn, so startup waits for discovery anyway. The build fails when the anchor
moves or the patch is already applied.
"""

import importlib.util
import sys
from pathlib import Path

MARKER = "# Archestra image patch: see docker_images/agent/patches/hermes-mcp-sdk-import.py"
ANCHOR = (
    "    home_key = hermes_home_key()\n"
    "    with _mcp_discovery_lock:\n"
    "        if home_key in _mcp_discovery_started:\n"
)
PATCH = f'''    {MARKER}
    if _has_configured_mcp_servers():
        try:
            from tools import mcp_tool as _archestra_mcp_tool

            if not (_archestra_mcp_tool._ensure_mcp_sdk() and _archestra_mcp_tool._MCP_HTTP_AVAILABLE):
                logger.warning("MCP SDK or its HTTP transport is unavailable; MCP servers cannot connect")
        except Exception:
            logger.warning("MCP SDK import failed before discovery", exc_info=True)
''' + ANCHOR

# Locate without importing: importing these modules runs startup code.
mcp_startup = Path(importlib.util.find_spec("hermes_cli").origin).with_name("mcp_startup.py")
mcp_tool = Path(importlib.util.find_spec("tools").origin).with_name("mcp_tool.py")
source = mcp_startup.read_text()
mcp_tool_source = mcp_tool.read_text()
if (
    MARKER in source
    or source.count(ANCHOR) != 1
    or "def start_background_mcp_discovery(*, logger, thread_name: str) -> None:" not in source
    or "def _has_configured_mcp_servers() -> bool:" not in source
    or "def _ensure_mcp_sdk() -> bool:" not in mcp_tool_source
    or "_MCP_HTTP_AVAILABLE" not in mcp_tool_source
):
    sys.exit(f"Hermes MCP discovery startup changed; review {Path(__file__).name}")
mcp_startup.write_text(source.replace(ANCHOR, PATCH))
