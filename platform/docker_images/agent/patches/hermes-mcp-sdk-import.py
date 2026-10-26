"""Import the MCP SDK before Hermes starts its discovery thread.

Hermes imports the MCP SDK lazily, on the background discovery thread, while
the main thread is still importing the agent. That first import pulls in
OpenTelemetry, whose entry-point lookup runs at import time and is cached for
the whole process. Under concurrent startup the lookup can come back without
OpenTelemetry's context entry point, or an SDK module fails to import. Hermes
then treats the SDK, or its HTTP transport, as unavailable for the rest of the
process: discovery ends without contacting the gateway, and every retry fails
the same way. Import the SDK on the caller's thread first. The build fails when
the anchor moves.
"""

import importlib.util
import sys
from pathlib import Path

ANCHOR = (
    "        thread = threading.Thread(target=copy_context().run, args=(_discover,), name=thread_name, daemon=True)\n"
)
PATCH = (
    "        # Archestra image patch: see docker_images/agent/patches/hermes-mcp-sdk-import.py\n"
    "        try:\n"
    "            from tools.mcp_tool import _ensure_mcp_sdk as _archestra_ensure_mcp_sdk\n"
    "            _archestra_ensure_mcp_sdk()\n"
    "        except Exception:\n"
    "            logger.warning(\"MCP SDK import failed before discovery\", exc_info=True)\n"
) + ANCHOR

# Locate without importing: importing these modules runs startup code.
mcp_startup = Path(importlib.util.find_spec("hermes_cli").origin).with_name("mcp_startup.py")
mcp_tool = Path(importlib.util.find_spec("tools").origin).with_name("mcp_tool.py")
source = mcp_startup.read_text()
if (
    source.count(ANCHOR) != 1
    or "def start_background_mcp_discovery(*, logger, thread_name: str) -> None:" not in source
    or "def _ensure_mcp_sdk() -> bool:" not in mcp_tool.read_text()
):
    sys.exit(f"Hermes MCP discovery startup changed; review {Path(__file__).name}")
mcp_startup.write_text(source.replace(ANCHOR, PATCH))
