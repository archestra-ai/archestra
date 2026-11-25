"""Make failed Archestra gateway discovery fatal before model tool assembly.

OpenClaw awaits discovery, but converts connection/list errors into an empty
catalog. This image requires its configured gateway. Fail instead of running
with only local tools. Anchor checks force review when the pinned CLI changes.
The published bundle minifies local names, so the anchor matches any names.
"""

from pathlib import Path
import re
import sys

package = Path("/opt/agent-openclaw/node_modules/openclaw")
files = list((package / "dist").glob("agent-bundle-mcp-materialize-*.mjs"))
if len(files) != 1:
    sys.exit("OpenClaw MCP materialization changed; review openclaw-mcp-required.py")
path = files[0]
source = path.read_text()
anchor = re.compile(r"^(\t\t)const ([\w$]+) = await [\w$]+\.getCatalog\(\);\n", re.M)
matches = list(anchor.finditer(source))
if len(matches) != 1:
    sys.exit("OpenClaw MCP catalog loading changed; review openclaw-mcp-required.py")
match = matches[0]
indent, catalog = match.group(1), match.group(2)
patch = match.group(0) + f'''{indent}// Archestra's configured gateway is required before a model turn.
{indent}if (!{catalog}.servers.archestra) {{
{indent}\treportArchestraMcpFailure("archestra-mcp-startup-failure", [], {{ stdio: "ignore" }});
{indent}\tthrow new Error("Archestra MCP gateway discovery failed. Check gateway availability and access, then retry.");
{indent}}}
'''
source = source[: match.start()] + patch + source[match.end() :]
source = 'import { spawnSync as reportArchestraMcpFailure } from "node:child_process";\n' + source
path.write_text(source)
