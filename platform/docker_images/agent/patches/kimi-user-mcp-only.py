"""Load MCP servers only from Kimi Code's user mcp.json.

The launcher trusts the runtime's working directory (KIMI_CODE_TRUST_WORKSPACE)
so the TUI does not stop on its folder-trust dialog and the repository's own
AGENTS.md and skills still load. Kimi 2.3.3 also loads the project MCP files
of a trusted folder (`<git root>/.mcp.json`, `<cwd>/.kimi-code/mcp.json`), so a
cloned repository could start stdio servers with the runtime's environment, or
replace the `archestra` gateway server, and it has no flag that turns that off.
Every MCP load, live reload and listing goes through `loadMcpServersDetailed`;
make it always take its user-only branch. Anchor checks force review when the
pinned CLI changes.
"""

from pathlib import Path
import sys

path = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/kimi/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs")
source = path.read_text()
anchor = "\tif (input.includeProject === false) {\n\t\tconst user = await readMcpJson(input.fs, paths.user);\n"
if source.count(anchor) != 1 or source.count("includeProject: this.trust.isTrusted()") != 3:
    sys.exit("Kimi Code MCP config loading changed; review kimi-user-mcp-only.py")
patch = anchor.replace("input.includeProject === false", "true /* Archestra: user mcp.json only */")
path.write_text(source.replace(anchor, patch))
