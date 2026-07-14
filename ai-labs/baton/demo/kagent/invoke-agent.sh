#!/usr/bin/env bash
# Drive the ops-agent one turn over A2A and print its reply.
# Usage: ./invoke-agent.sh "your prompt"
set -euo pipefail

PROMPT="${1:?usage: invoke-agent.sh <prompt>}"
NS=kagent
AGENT=ops-agent

# The A2A server is on the kagent controller's HTTP port (default 8083):
#   <controller>:8083/api/a2a/<ns>/<agent>
kubectl port-forward -n "$NS" svc/kagent-controller 8083:8083 >/tmp/baton-a2a-pf.log 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
until curl -s -o /dev/null "http://127.0.0.1:8083/"; do sleep 1; done

curl -s -X POST "http://127.0.0.1:8083/api/a2a/${NS}/${AGENT}" \
  -H 'Content-Type: application/json' \
  -d "$(cat <<JSON
{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":$(printf '%s' "$PROMPT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}],"messageId":"demo-1"}}}
JSON
)"
