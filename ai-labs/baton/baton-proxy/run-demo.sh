#!/usr/bin/env bash
# Run the whole baton-proxy demo: approver + proxy + demo agent.
#
# Works from any checkout or git worktree — all paths derive from this script's
# location. Extra args are forwarded to the demo agent (e.g. --task "...",
# --model ...). Ctrl-C or the demo finishing stops the background servers.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$CRATE_DIR"

PROXY_ADDR="127.0.0.1:8730"
APPROVER_ADDR="127.0.0.1:8731"

# --- resolve the OpenRouter key -------------------------------------------------
# In order: the environment, this checkout's ai-labs/.env, then the main
# checkout's ai-labs/.env (a linked worktree does not carry untracked files).
read_env_key() {
  [[ -f "$1" ]] || return 1
  local val
  val="$(grep -E '^(export )?OPENROUTER_API_KEY=' "$1" | tail -1 | sed -E 's/^(export )?OPENROUTER_API_KEY=//')"
  val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  [[ -n "$val" ]] && printf '%s' "$val"
}

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  key="$(read_env_key "$CRATE_DIR/../../.env" || true)"
  if [[ -z "$key" ]] && git -C "$CRATE_DIR" rev-parse --git-common-dir >/dev/null 2>&1; then
    main_root="$(cd "$CRATE_DIR" && cd "$(dirname "$(git rev-parse --git-common-dir)")" && pwd)"
    key="$(read_env_key "$main_root/ai-labs/.env" || true)"
  fi
  [[ -n "$key" ]] && export OPENROUTER_API_KEY="$key"
fi
if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "no OPENROUTER_API_KEY: set it, or add it to ai-labs/.env" >&2
  exit 1
fi

# --- build ---------------------------------------------------------------------
echo "building (--features demo)…"
cargo build --features demo --quiet

# --- start the servers ---------------------------------------------------------
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

APPROVER_LOG=/tmp/baton-approver.log
PROXY_LOG=/tmp/baton-proxy.log
TRAJECTORY_LOG=/tmp/baton-trajectory.jsonl
WIRE_DIR="$CRATE_DIR/wire-logs"   # raw model request/response, kept in-project
: > "$TRAJECTORY_LOG"  # fresh per run

echo "starting baton-approver ($APPROVER_ADDR) and baton-proxy ($PROXY_ADDR)…"
./target/debug/baton-approver --addr "$APPROVER_ADDR" 2>"$APPROVER_LOG" &
pids+=($!)
RUST_LOG=info ./target/debug/baton-proxy --policy policy.toml --addr "$PROXY_ADDR" \
  --log "$TRAJECTORY_LOG" --wire-log-dir "$WIRE_DIR" 2>"$PROXY_LOG" &
pids+=($!)

wait_port() {
  local host="${1%:*}" port="${1#*:}"
  for _ in $(seq 1 50); do
    (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null && { exec 3>&-; return 0; }
    sleep 0.2
  done
  echo "timed out waiting for $1 (see /tmp/baton-*.log)" >&2
  return 1
}
wait_port "$APPROVER_ADDR"
wait_port "$PROXY_ADDR"

# --- run the demo (foreground: answer y/n at the approval prompt) ---------------
echo "running demo — answer y/n when the approval prompt appears."
echo
./target/debug/baton-demo-agent "$@"

# --- pretty-print the run (proxy renders its own log) ---------------------------
echo
./target/debug/baton-proxy render "$WIRE_DIR"/$(ls -t "$WIRE_DIR" 2>/dev/null | head -1) || true

wire_file="$(ls -t "$WIRE_DIR"/model-wire-*.jsonl 2>/dev/null | head -1)"
echo
echo "logs (pretty-print any with: baton-proxy render <file>):"
echo "  raw model wire (req/resp):  ${wire_file:-$WIRE_DIR/model-wire-<timestamp>.jsonl}"
echo "  trajectory (per-turn JSON): $TRAJECTORY_LOG"
echo "  proxy stderr:               $PROXY_LOG"
echo "  approver stderr:            $APPROVER_LOG"
