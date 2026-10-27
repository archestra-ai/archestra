"""Send Archestra's tool-call IDs back to the proxy unchanged.

Before each request, Kimi Code 2.3.3 rewrites every tool-call ID in the history
to at most 64 characters and adds `_2`, `_3`, ... to keep the shortened IDs
unique. The Archestra proxy gives each tool call a signed ID that records its
session, and that ID is longer than 64 characters. The rewritten IDs no longer
match, so the proxy finds no record of any tool result: a remedy the gateway
authorized reads as not run, and the call it released has its output withheld.
Remove the length limit from every protocol's policy; Kimi still replaces
characters a provider rejects, and the proxy restores the provider's original
IDs before a request reaches the model. The anchor checks force review when
the pinned CLI changes.
"""

from pathlib import Path
import sys

POLICIES = {
    "ANTHROPIC_TOOL_CALL_ID_POLICY": "sanitizeToolCallId",
    "OPENAI_CHAT_TOOL_CALL_ID_POLICY": "sanitizeToolCallId",
    "OPENAI_RESPONSES_TOOL_CALL_ID_POLICY": "sanitizeOpenAIResponsesCallId",
}

path = Path(sys.argv[1] if len(sys.argv) > 1 else "/opt/kimi/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs")
source = path.read_text()
if "if (maxLength === void 0) return `${base}${suffix}`;" not in source:
    sys.exit("Kimi Code tool-call ID truncation changed; review kimi-long-tool-call-ids.py")
for policy, sanitize in POLICIES.items():
    anchor = f"\t{policy} = {{\n\t\tnormalize: (id) => {sanitize}(id, 64),\n\t\tmaxLength: 64\n\t}};\n"
    patch = f"\t{policy} = {{\n\t\tnormalize: (id) => {sanitize}(id) /* Archestra: keep the proxy's signed IDs */,\n\t\tmaxLength: void 0\n\t}};\n"
    if source.count(anchor) != 1 or source.count(f"trait?.toolCallIdPolicy ?? {policy}") != 1:
        sys.exit(f"Kimi Code {policy} changed; review kimi-long-tool-call-ids.py")
    source = source.replace(anchor, patch)
path.write_text(source)
