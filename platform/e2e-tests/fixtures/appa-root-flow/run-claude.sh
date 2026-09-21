#!/usr/bin/env bash
# One headless Claude Code run against the LLM proxy, with OpenAPPA enforcing.
#
#   run-claude.sh <session-id> <prompt> [transcript-path]
#
# Everything is real: the client, the proxy, the runtime and the provider. Only
# the policy's authority and sanitizers are the fixture this run controls
# (externals-fixture.mjs). See README.md for setup and the scenarios.
set -euo pipefail
umask 077

session="${1:?usage: run-claude.sh <session-id> <prompt> [transcript-path]}"
prompt="${2:?usage: run-claude.sh <session-id> <prompt> [transcript-path]}"

# One base directory. Every path below derives from it, and every secret this
# script writes stays inside it.
APPA_LAB_HOME="${APPA_LAB_HOME:-${TMPDIR:-/tmp}/appa-root-flow}"
lab="$APPA_LAB_HOME/lab"
client_home="$APPA_LAB_HOME/claude"
transcripts="$APPA_LAB_HOME/transcripts/claude"
transcript="${3:-$transcripts/$session.jsonl}"

base_url="${ARCHESTRA_BASE_URL:-http://localhost:9000}"
agent="${ARCHESTRA_AGENT_ID:?set ARCHESTRA_AGENT_ID — see README.md, \"Setup\" step 2}"
gateway="${ARCHESTRA_GATEWAY_ID:?set ARCHESTRA_GATEWAY_ID — see README.md, \"Setup\" step 3}"
token="${ARCHESTRA_GATEWAY_TOKEN:?set ARCHESTRA_GATEWAY_TOKEN — see README.md, \"Setup\" step 4}"
proxy_key="${ARCHESTRA_PROXY_KEY:?set ARCHESTRA_PROXY_KEY — see README.md, \"Setup\" step 5}"

# The label the client registers the gateway under. Any label works: the gateway
# signs each tool it lists, in the tool's description, and the proxy verifies
# and strips that signature, so `mcp__<label>__archestra__*` resolves to the
# built-in APPA tools whatever the label is. A server that copies the names
# carries no valid signature and stays foreign. The default matches no gateway
# name, so every run exercises that.
gateway_label="${ARCHESTRA_GATEWAY_LABEL:-gw}"

# Every directory this script writes into, whether or not a transcript path was
# passed on the command line.
mkdir -p "$lab" "$client_home" "$transcripts" "$(dirname "$transcript")"

mcp_config="$client_home/.mcp.json"
cat > "$mcp_config" <<EOF
{
  "mcpServers": {
    "$gateway_label": {
      "type": "http",
      "url": "$base_url/v1/mcp/$gateway",
      "headers": {
        "Authorization": "Bearer $token",
        "X-Appa-Session-ID": "$session"
      }
    }
  }
}
EOF

cd "$lab"
export ANTHROPIC_BASE_URL="$base_url/v1/anthropic/$agent"
# `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`: the platform's own Connect
# page pairs the base URL with this variable (CLAUDE_CODE_PROXY_ENV_KEYS in
# shared/consts.ts). Claude Code sends this one as `Authorization`, and the
# other as `x-api-key`, which the proxy does not accept as a platform
# credential.
export ANTHROPIC_AUTH_TOKEN="$proxy_key"
unset ANTHROPIC_API_KEY
# The session id travels on the provider traffic as well, so the proxy and the
# gateway bind the same OpenAPPA root.
export ANTHROPIC_CUSTOM_HEADERS="X-Appa-Session-ID: $session"
export CLAUDE_CONFIG_DIR="$client_home"
export MAX_THINKING_TOKENS=0

# The prompt goes on stdin: `--allowed-tools` is variadic and would otherwise
# swallow a positional prompt as one more tool name.
printf '%s' "$prompt" | timeout 300 claude \
  --print \
  --output-format stream-json \
  --verbose \
  --permission-mode acceptEdits \
  --strict-mcp-config \
  --mcp-config "$mcp_config" \
  --model claude-sonnet-4-5-20250929 \
  --allowed-tools \
  "mcp__${gateway_label}__archestra__get_remedy_plans" \
  "mcp__${gateway_label}__archestra__execute_remedy_plan" \
  "Read" "Bash" "Write" "Glob" "Grep" \
  > "$transcript" 2> "$transcripts/$session.err" || true

echo "transcript: $transcript"
echo "stderr:     $transcripts/$session.err"
