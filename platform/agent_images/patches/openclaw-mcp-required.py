"""Make failed Archestra gateway discovery fatal before model tool assembly.

OpenClaw awaits discovery, but converts connection/list errors into an empty
catalog. This image requires its configured gateway. Fail instead of running
with only local tools. Anchor checks force review when the pinned CLI changes.
"""

from pathlib import Path
import json
import subprocess
import sys

listing = json.loads(subprocess.check_output(["pnpm", "list", "--global", "--json", "openclaw"], text=True))
package = Path(listing[0]["dependencies"]["openclaw"]["path"])
files = list((package / "dist").glob("agent-bundle-mcp-materialize-*.js"))
if len(files) != 1:
    sys.exit("OpenClaw MCP materialization changed; review openclaw-mcp-required.py")
path = files[0]
source = path.read_text()
anchor = "\t\tcatalog = await params.runtime.getCatalog();\n"
if source.count(anchor) != 1:
    sys.exit("OpenClaw MCP catalog loading changed; review openclaw-mcp-required.py")
source = 'import { spawnSync as reportArchestraMcpFailure } from "node:child_process";\n' + source
patch = anchor + '''\t\t// Archestra's configured gateway is required before a model turn.
\t\tif (!catalog.servers.archestra) {
\t\t\treportArchestraMcpFailure("archestra-mcp-startup-failure", [], { stdio: "ignore" });
\t\t\tthrow new Error("Archestra MCP gateway discovery failed. Check gateway availability and access, then retry.");
\t\t}
'''
path.write_text(source.replace(anchor, patch))
