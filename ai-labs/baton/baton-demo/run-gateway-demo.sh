#!/usr/bin/env bash
# Run the whole baton-gateway demo: gateway + agent, one terminal.
#
# Works from any checkout or git worktree — all paths derive from this script's
# location. A leading -v/-vv is given to the gateway (engine decision path /
# label algebra); every other arg is forwarded to the agent (e.g. --task "...",
# --model ...). Ctrl-C or the demo finishing stops the background gateway.
#
# The gateway's narration (✓ permitted / ⚠ soft block / ✋ approval) prints to
# this terminal, interleaved with the agent — that interleaving is the demo.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="$CRATE_DIR/target"
cd "$CRATE_DIR"

GATEWAY_ADDR="127.0.0.1:8732"
DECISIONS_LOG=/tmp/baton-gateway-decisions.jsonl

GATEWAY_FLAGS=()
if [[ "${1:-}" == "-v" || "${1:-}" == "-vv" ]]; then
  GATEWAY_FLAGS+=("$1")
  shift
fi

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
cargo build --quiet

# --- start the gateway (narration stays on this terminal) -----------------------
pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

: > "$DECISIONS_LOG"  # fresh per run
echo "starting baton-gateway ($GATEWAY_ADDR)…"
"$TARGET_DIR/debug/baton-gateway" --addr "$GATEWAY_ADDR" --log "$DECISIONS_LOG" ${GATEWAY_FLAGS[@]+"${GATEWAY_FLAGS[@]}"} &
pids+=($!)

wait_port() {
  local host="${1%:*}" port="${1#*:}"
  for _ in $(seq 1 50); do
    (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null && { exec 3>&-; return 0; }
    sleep 0.2
  done
  echo "timed out waiting for $1" >&2
  return 1
}
wait_port "$GATEWAY_ADDR"

# --- run the agent (foreground: answer y/n at the approval prompt) ---------------
echo "running demo — answer y/n when the approval prompt appears."
echo
"$TARGET_DIR/debug/baton-gateway-agent" "$@"

echo
echo "decision log (one JSON line per decision): $DECISIONS_LOG"
