#!/usr/bin/env bash
# One headless Codex run against the LLM proxy, with OpenAPPA enforcing.
#
#   run-codex.sh <session-id> <prompt> [transcript-path]
#
# Codex speaks the OpenAI Responses protocol and is supported in direct tool
# mode only, so this config keeps `apply_patch` in its function form and never
# enables code mode. See README.md, "Client configuration", for why each flag
# below is here.
set -euo pipefail
umask 077

session="${1:?usage: run-codex.sh <session-id> <prompt> [transcript-path]}"
prompt="${2:?usage: run-codex.sh <session-id> <prompt> [transcript-path]}"

# One base directory. Every path below derives from it, and every secret this
# script writes stays inside it.
APPA_LAB_HOME="${APPA_LAB_HOME:-${TMPDIR:-/tmp}/appa-root-flow}"
lab="$APPA_LAB_HOME/lab"
client_home="$APPA_LAB_HOME/codex"
transcripts="$APPA_LAB_HOME/transcripts/codex"
transcript="${3:-$transcripts/$session.jsonl}"

base_url="${ARCHESTRA_BASE_URL:-http://localhost:9000}"
agent="${ARCHESTRA_AGENT_ID:?set ARCHESTRA_AGENT_ID — see README.md, \"Setup\" step 2}"
gateway="${ARCHESTRA_GATEWAY_ID:?set ARCHESTRA_GATEWAY_ID — see README.md, \"Setup\" step 3}"
token="${ARCHESTRA_GATEWAY_TOKEN:?set ARCHESTRA_GATEWAY_TOKEN — see README.md, \"Setup\" step 4}"
# Codex reads the provider credential from the environment by name (`env_key`
# below), so it is never written to the config file.
: "${ARCHESTRA_PROXY_KEY:?set ARCHESTRA_PROXY_KEY — see README.md, \"Setup\" step 5}"

# The label used to register the gateway. Any label works.
# Codex declares the gateway as an `mcp__<label>` namespace. The gateway signs
# each tool description that it lists. The proxy verifies and removes that signature.
# As a result, namespace members resolve to built-in APPA tools regardless of the label.
# An untrusted server that copies tool names lacks a valid signature and remains untrusted.
# The default label 'gw' matches no gateway name, so every run exercises signature verification.
gateway_label="${ARCHESTRA_GATEWAY_LABEL:-gw}"

# Every directory this script writes into, whether or not a transcript path was
# passed on the command line.
mkdir -p "$lab" "$client_home" "$transcripts" "$(dirname "$transcript")"

export CODEX_HOME="$client_home"

# The catalog path goes into the config as a TOML literal string, which cannot
# hold a single quote.
case "${ARCHESTRA_CODEX_MODEL_CATALOG:-}" in
  *"'"*) echo "ARCHESTRA_CODEX_MODEL_CATALOG must not contain a single quote" >&2; exit 1 ;;
esac

cat > "$CODEX_HOME/config.toml" <<EOF
# A model whose catalog declares MCP tools inline: the ones that defer them to
# the provider-side tool search never declare the APPA tools, and APPA refuses a
# session it cannot see the control and notice tools in.
#
# Override with ARCHESTRA_CODEX_MODEL only for a model you have checked. A model
# Codex has no catalog entry for falls back to generic metadata, and its router
# then rejects the notice tool as an unsupported call — the run limps through on
# restoration instead of executing the notice, which is not what you are testing.
model = "${ARCHESTRA_CODEX_MODEL:-gpt-5.1-codex}"
model_provider = "archestra"
approval_policy = "never"
sandbox_mode = "danger-full-access"

# Web search runs inside the provider, so no call reaches the proxy to gate and
# APPA refuses a session that declares it.
web_search = "disabled"

# A catalog file that replaces the model metadata Codex fetched, for a model
# whose fetched entry hides its tools (tool_mode "code_mode_only") or defers
# them to a tool search (supports_search_tool true). See the runbook, "Client
# configuration".
${ARCHESTRA_CODEX_MODEL_CATALOG:+model_catalog_json = '$ARCHESTRA_CODEX_MODEL_CATALOG'}

[tools]
# Direct tool mode: a free-form custom tool carries no arguments the proxy can
# gate, so APPA refuses the session that declares one.
apply_patch_tool_type = "function"

# Code mode wraps every call in an exec program the proxy cannot gate, and a
# model that runs it declares no tools at all; keep calls on the wire.
[features]
code_mode_host = false

[model_providers.archestra]
name = "Archestra"
base_url = "$base_url/v1/openai/$agent"
wire_api = "responses"
env_key = "ARCHESTRA_PROXY_KEY"

[model_providers.archestra.http_headers]
# The session id travels on the provider traffic as well, so the proxy and the
# gateway bind the same OpenAPPA root.
"X-Appa-Session-ID" = "$session"

[mcp_servers.$gateway_label]
url = "$base_url/v1/mcp/$gateway"

[mcp_servers.$gateway_label.http_headers]
"Authorization" = "Bearer $token"
"X-Appa-Session-ID" = "$session"
EOF

cd "$lab"
timeout 300 codex exec \
  --json \
  -c 'web_search="disabled"' \
  -c 'tools.apply_patch_tool_type="function"' \
  -c 'features.apply_patch_freeform=false' \
  --dangerously-bypass-approvals-and-sandbox \
  --cd "$lab" \
  "$prompt" < /dev/null > "$transcript" 2> "$transcripts/$session.err" || true

echo "transcript: $transcript"
echo "stderr:     $transcripts/$session.err"
