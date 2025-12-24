#!/usr/bin/env bash
set -euo pipefail

# Usage: ./cursor-repro.sh <MCP_BASE_URL> <PROFILE_ID_OR_TOKEN>
# Example: ./cursor-repro.sh http://localhost:9000/v1/mcp my-profile-id

MCP_BASE_URL=${1:-http://localhost:9000/v1/mcp}
PROFILE=${2:-}
if [ -z "$PROFILE" ]; then
  echo "Usage: $0 <MCP_BASE_URL> <PROFILE_ID>"
  exit 2
fi

# Discovery (GET)
echo "---- GET discovery ----"
curl -sS -H "Authorization: Bearer ${PROFILE}" "$MCP_BASE_URL/${PROFILE}"

echo "\n---- POST initialize (JSON-RPC) ----"
INIT_RESP=$(curl -sS -X POST -H "Content-Type: application/json" -H "Authorization: Bearer ${PROFILE}" -d '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}' "$MCP_BASE_URL/${PROFILE}")
echo "$INIT_RESP"

# Extract session id from headers isn't possible with curl easily here; assume session id returned in body or use transport responses

# Example tool call (replace with a real tool name available on the agent)
# This example uses a dummy tool name 'tools/exampleTool', adjust accordingly
TOOL_PAYLOAD='{"jsonrpc":"2.0","method":"callTool","params":{"name":"tools/example","arguments":{}},"id":2}'

echo "\n---- POST callTool (JSON-RPC) ----"
curl -sS -X POST -H "Content-Type: application/json" -H "Authorization: Bearer ${PROFILE}" -d "$TOOL_PAYLOAD" "$MCP_BASE_URL/${PROFILE}" || true

echo "\nDemo script completed. If the server accepted initialize and returned JSON responses, the fix works."
