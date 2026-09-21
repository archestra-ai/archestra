#!/usr/bin/env bash
# One headless OpenCode run against the LLM proxy, with OpenAPPA enforcing.
#
#   run-opencode.sh <session-id> <prompt> [transcript-path]
#
# OpenCode speaks Chat Completions. Both APPA tools are pre-allowed so the
# notice and the remedy run without a prompt, which is what headless mode needs.
# See README.md, "Client configuration", for why each permission below is here.
set -euo pipefail
umask 077

session="${1:?usage: run-opencode.sh <session-id> <prompt> [transcript-path]}"
prompt="${2:?usage: run-opencode.sh <session-id> <prompt> [transcript-path]}"

# One base directory. Every path below derives from it, and every secret this
# script writes stays inside it.
APPA_LAB_HOME="${APPA_LAB_HOME:-${TMPDIR:-/tmp}/appa-root-flow}"
lab="$APPA_LAB_HOME/lab"
client_home="$APPA_LAB_HOME/opencode"
transcripts="$APPA_LAB_HOME/transcripts/opencode"
transcript="${3:-$transcripts/$session.log}"

base_url="${ARCHESTRA_BASE_URL:-http://localhost:9000}"
agent="${ARCHESTRA_AGENT_ID:?set ARCHESTRA_AGENT_ID — see README.md, \"Setup\" step 2}"
gateway="${ARCHESTRA_GATEWAY_ID:?set ARCHESTRA_GATEWAY_ID — see README.md, \"Setup\" step 3}"
token="${ARCHESTRA_GATEWAY_TOKEN:?set ARCHESTRA_GATEWAY_TOKEN — see README.md, \"Setup\" step 4}"
proxy_key="${ARCHESTRA_PROXY_KEY:?set ARCHESTRA_PROXY_KEY — see README.md, \"Setup\" step 5}"

# The label the client registers the gateway under. It must be the client server
# name of a real gateway in this organization: that is the only thing that lets
# the proxy canonicalize OpenCode's `<label>_<tool>` decoration back to the
# built-in APPA tools. A label that matches no gateway leaves the tools foreign,
# and APPA refuses a session it cannot see its control and notice tools in.
gateway_label="${ARCHESTRA_GATEWAY_LABEL:-my_gateway}"

# Every directory this script writes into, whether or not a transcript path was
# passed on the command line.
mkdir -p "$lab" "$client_home" "$transcripts" "$(dirname "$transcript")"

# The provider credential is written into this config, so it stays inside
# APPA_LAB_HOME and is created under `umask 077`.
export OPENCODE_CONFIG="$client_home/opencode.json"

cat > "$OPENCODE_CONFIG" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "archestra": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Archestra",
      "options": {
        "baseURL": "$base_url/v1/openai/$agent",
        "apiKey": "$proxy_key",
        "headers": { "X-Appa-Session-ID": "$session" }
      },
      "models": { "gpt-4.1": { "name": "gpt-4.1" } }
    }
  },
  "mcp": {
    "$gateway_label": {
      "type": "remote",
      "url": "$base_url/v1/mcp/$gateway",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer $token",
        "X-Appa-Session-ID": "$session"
      }
    }
  },
  "permission": {
    "bash": "allow",
    "edit": "allow",
    "external_directory": "allow",
    "webfetch": "deny",
    "${gateway_label}_archestra__get_remedy_plans": "allow",
    "${gateway_label}_archestra__execute_remedy_plan": "allow"
  }
}
EOF

cd "$lab"
timeout 300 opencode run \
  --model archestra/gpt-4.1 \
  --print-logs \
  "$prompt" < /dev/null > "$transcript" 2> "$transcripts/$session.err" || true

echo "transcript: $transcript"
echo "stderr:     $transcripts/$session.err"
