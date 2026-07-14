#!/usr/bin/env bash
# Pretty-print a baton-proxy log — the raw model-wire log (request / model /
# proxy per turn) or the compact trajectory decision log. Highlights the turns
# the proxy rewrote.
#
# Usage:
#   pretty-log.sh [FILE]     # defaults to the newest wire-logs/*.jsonl
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILE="${1:-}"
if [[ -z "$FILE" ]]; then
  FILE="$(ls -t "$CRATE_DIR"/wire-logs/model-wire-*.jsonl 2>/dev/null | head -1 || true)"
fi
if [[ -z "$FILE" || ! -f "$FILE" ]]; then
  echo "no log file (pass one, or run the demo to create wire-logs/)" >&2
  exit 1
fi

COLOR=1; [[ -t 1 ]] || COLOR=0
FILE="$FILE" COLOR="$COLOR" python3 - <<'PY'
import json, os

C = os.environ["COLOR"] == "1"
def c(s, code): return f"\033[{code}m{s}\033[0m" if C else s
BOLD, DIM, RED, GRN, YEL, CYA = "1", "2", "31", "32", "33", "36"

def call_str(tc):
    fn = tc["function"]
    try:
        args = json.dumps(json.loads(fn["arguments"]), ensure_ascii=False)
    except Exception:
        args = fn["arguments"]
    if len(args) > 100: args = args[:99] + "…"
    return f'{fn["name"]}  {args}'

def response(resp):
    ch = resp.get("choices", [{}])[0]; msg = ch.get("message", {})
    if msg.get("tool_calls"):
        return [("call", call_str(tc)) for tc in msg["tool_calls"]]
    return [("text", (msg.get("content") or "").strip())]

def last_ctx(msgs):
    if not msgs: return ""
    m = msgs[-1]; role = m.get("role")
    if role == "tool":
        return f'tool-result: {str(m.get("content"))[:70].strip()}'
    if m.get("tool_calls"):
        return f'{role}: →{", ".join(t["function"]["name"] for t in m["tool_calls"])}'
    txt = m.get("content")
    txt = txt if isinstance(txt, str) else json.dumps(txt)
    return f'{role}: {txt[:70].strip()}'

path = os.environ["FILE"]
rows = [json.loads(l) for l in open(path) if l.strip()]
is_wire = rows and "returned_response" in rows[0]
print(c(f"── {os.path.basename(path)} · {len(rows)} " + ("turns" if is_wire else "decisions") + " ──", DIM))
print()

if is_wire:
    for d in rows:
        print(c(f"─── turn {d['turn']} " + "─" * 44, CYA))
        n = len(d["request"].get("messages", []))
        print(f"  {c('context in ', DIM)} {n} msgs · last: {last_ctx(d['request'].get('messages', []))}")
        model = response(d["model_response"]); proxy = response(d["returned_response"])
        for kind, s in model:
            label = "model wants" if kind == "call" else "model says "
            print(f"  {c(label, DIM)} {s}")
        if model != proxy:
            for _, s in proxy:
                print(f"  {c('proxy sends', DIM)} {c(s, YEL)}  {c('⟵ REWRITTEN by baton', BOLD + ';' + YEL)}")
        else:
            print(f"  {c('proxy       ', DIM)} {c('unchanged — passed through', GRN)}")
        print()
else:
    for i, d in enumerate(rows, 1):
        col = {"permitted": GRN, "needs_approval": YEL, "terminal": RED}.get(d["outcome"], "")
        tool = d["tool"] + (" → " + ", ".join(d["recipients"]) if d.get("recipients") else "")
        print(f'  {i}. {tool:44} {c(d["outcome"], col)}')
        if d.get("reason"):
            print(f'     {c(d["reason"], DIM)}')
PY
