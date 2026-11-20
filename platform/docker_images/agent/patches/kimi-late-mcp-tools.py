"""Offer the gateway's tools on every request, even when they connect late.

Kimi Code 2.6.3 builds an agent's tool list once, when the agent is created,
and no longer waits for its MCP servers first. The gateway connects a moment
later, so its tools are registered but never reach a request: the model sees
only Kimi's built-in tools. Upstream reaches late tools through `select_tools`,
which runs only for models that declare dynamically loaded tools; the
Archestra model does not. Before each request, add every registered MCP tool
the agent's tool policy allows and the request lacks. The anchor checks force
review when the pinned CLI changes.
"""

from pathlib import Path
import sys

path = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/kimi/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs")
source = path.read_text()
anchor = "\t\trequestTools(base, disclosure = this.enabled(), dynamic = false, messages = this.history()) {\n"
patch = anchor + (
    "\t\t\tif (!disclosure && base !== void 0) {\n"
    "\t\t\t\t/* Archestra: add MCP tools that connected after the agent's tool list was built */\n"
    "\t\t\t\tconst names = new Set(base.map((tool) => tool.name));\n"
    "\t\t\t\tconst late = this.activeEntries(this.currentTools(), false)"
    ".filter((tool) => isMcpToolName(tool.name) && !names.has(tool.name))"
    ".map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS }));\n"
    "\t\t\t\tif (late.length > 0) base = [...base, ...late].toSorted((left, right) => left.name.localeCompare(right.name));\n"
    "\t\t\t}\n"
)
if (
    source.count(anchor) != 1
    or source.count("const tools = initialTools === void 0 ? this.requestFactory.baselineTools() : [...initialTools];") != 1
    or source.count("\t\tactiveEntries(entries, disclosure) {\n") != 1
    or source.count("\t\tcurrentTools() {\n") != 1
    or source.count("function isMcpToolName(name) {") != 1
):
    sys.exit("Kimi Code request tool assembly changed; review kimi-late-mcp-tools.py")
path.write_text(source.replace(anchor, patch))
