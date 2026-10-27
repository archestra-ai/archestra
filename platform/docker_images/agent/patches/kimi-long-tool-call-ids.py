"""Send Archestra's tool-call IDs back to the proxy unchanged.

Before each Chat Completions request, Kimi Code 2.3.3 rewrites every tool-call
ID in the history to at most 64 characters and adds `_2`, `_3`, ... to keep the
shortened IDs unique. The Archestra proxy gives each tool call a signed ID that
records its session, and that ID is longer than 64 characters. The rewritten
IDs no longer match, so the proxy finds no record of any tool result: a remedy
the gateway authorized reads as not run, and the call it released has its
output withheld. Raise the limit to the proxy's own bound on tool-call IDs; the
proxy restores the provider's original IDs before a request reaches the model.
The anchor check forces review when the pinned CLI changes.
"""

from pathlib import Path
import sys

path = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/kimi/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs")
source = path.read_text()
anchor = (
    "\tOPENAI_CHAT_TOOL_CALL_ID_POLICY = {\n"
    "\t\tnormalize: (id) => sanitizeToolCallId(id, 64),\n"
    "\t\tmaxLength: 64\n"
    "\t};\n"
)
if source.count(anchor) != 1 or source.count("trait?.toolCallIdPolicy ?? OPENAI_CHAT_TOOL_CALL_ID_POLICY") != 1:
    sys.exit("Kimi Code tool-call ID normalization changed; review kimi-long-tool-call-ids.py")
patch = anchor.replace("64", "1024 /* Archestra: keep the proxy's signed IDs */", 1).replace("maxLength: 64", "maxLength: 1024")
path.write_text(source.replace(anchor, patch))
