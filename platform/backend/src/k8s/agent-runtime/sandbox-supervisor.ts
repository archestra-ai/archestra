import {
  AGENT_RUNTIME_READABLE_TRANSCRIPT_FILE,
  AGENT_RUNTIME_READABLE_TRANSCRIPT_MAX_BYTES,
} from "@/services/agent-runtime/runtime-contract";

/**
 * PID 1 owns the workspace, not the agent command. Requests are published by
 * the control plane using atomic rename. A started request is never replayed
 * after a Pod replacement: its side effects may already have happened.
 */
export function buildSandboxSupervisorScript(): string {
  return String.raw`set -eu
umask 077
root=/var/run/archestra
mkdir -p "$root/turns"
command -v setsid >/dev/null 2>&1 || { echo 'Agent Runtime requires setsid (util-linux)' >&2; exit 78; }
printf '%s' structured > "$root/session-interface"
native_pid=''
descendants() (
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    descendants "$child"
    printf '%s ' "$child"
  done
)
trap '[ -z "$native_pid" ] || /bin/kill -TERM -- -"$native_pid" 2>/dev/null || true; exit 0' TERM INT

while :; do
  for request in "$root"/turns/*.request; do
    [ -f "$request" ] || continue
    turn="$(printf '%s' "$request" | sed 's/\.request$//')"
    [ ! -f "$turn.exit" ] || continue
    if [ -f "$turn.cancel" ]; then
      printf '130\n' > "$turn.exit.tmp"
      mv "$turn.exit.tmp" "$turn.exit"
      rm -f "$request" "$turn.session"
      continue
    fi
    if [ -f "$turn.started" ]; then
      # A replacement Pod cannot know which external effects completed.
      printf '75\n' > "$turn.exit.tmp"
      mv "$turn.exit.tmp" "$turn.exit"
      rm -f "$request" "$turn.session"
      continue
    fi
    touch "$turn.started"
    touch "$turn.log"
    rm -f ${AGENT_RUNTIME_READABLE_TRANSCRIPT_FILE}
    printf '%s\n' "touch '$turn.running'; export ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX='$turn'; /bin/sh '$request'; status=\$?; sleep 2; printf '%s\\n' \"\$status\" > '$turn.result.tmp'; mv '$turn.result.tmp' '$turn.result'; exit \"\$status\"" > "$turn.session"
    setsid /bin/sh "$turn.session" >> "$turn.log" 2>&1 &
    native_pid=$!
    while [ ! -f "$turn.result" ]; do
      if [ -f "$turn.cancel" ]; then
        children="$(descendants "$native_pid")"
        for child in $children; do kill -TERM "$child" 2>/dev/null || true; done
        [ -z "$native_pid" ] || /bin/kill -TERM -- -"$native_pid" 2>/dev/null || true
        if [ -n "$native_pid" ]; then
          polls=0
          while kill -0 "$native_pid" 2>/dev/null && [ "$polls" -lt 5 ]; do sleep 1; polls=$((polls + 1)); done
          for child in $children; do kill -KILL "$child" 2>/dev/null || true; done
          /bin/kill -KILL -- -"$native_pid" 2>/dev/null || true
        fi
        printf '130\n' > "$turn.result.tmp"
        mv "$turn.result.tmp" "$turn.result"
        break
      fi
      # Fail a crashed process without replaying any external side effects.
      if ! kill -0 "$native_pid" 2>/dev/null && [ ! -f "$turn.result" ]; then
        printf '75\n' > "$turn.result.tmp"
        mv "$turn.result.tmp" "$turn.result"
      fi
      sleep 1
    done
    # Publish the transcript before completion becomes visible to the backend.
    if [ -s ${AGENT_RUNTIME_READABLE_TRANSCRIPT_FILE} ] && command -v base64 >/dev/null 2>&1 && [ "$(wc -c < ${AGENT_RUNTIME_READABLE_TRANSCRIPT_FILE})" -le ${AGENT_RUNTIME_READABLE_TRANSCRIPT_MAX_BYTES} ]; then
      {
        printf '\033]777;archestra-readable-transcript=base64\007'
        base64 < ${AGENT_RUNTIME_READABLE_TRANSCRIPT_FILE} | tr -d '\n'
        printf '\033]777;archestra-readable-transcript=end\007'
      } | tee -a "$turn.log"
    fi
    [ -z "$native_pid" ] || wait "$native_pid" || true
    native_pid=''
    mv "$turn.result" "$turn.exit"
    # The request can contain turn-scoped credentials; keep only its outcome.
    rm -f "$request" "$turn.session" "$turn.running"
  done
  sleep 1
done`;
}
