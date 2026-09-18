import { buildImageRuntimeInstallScript } from "@/services/agent-runtime/image-runtime/bootstrap";
import { AGENT_IMAGE_RUNTIME } from "@/services/agent-runtime/image-runtime/contract";
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
${buildImageRuntimeInstallScript({ activate: true })}
runtime=${AGENT_IMAGE_RUNTIME}
trap '"$runtime" stop 2>/dev/null || true; exit 0' TERM INT
"$runtime" initialize

while :; do
  # Record human input, not pane output: a logging daemon must not keep an idle
  # workspace alive. Persist it so detached clients still count at reaping time.
  activity="$("$runtime" activity)"
  case "$activity" in
    ''|*[!0-9]*) ;;
    *)
      previous="$(cat "$root/development-activity" 2>/dev/null || echo 0)"
      if [ "$activity" -gt "$previous" ]; then printf '%s\n' "$activity" > "$root/development-activity"; fi
      ;;
  esac
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
    "$runtime" reset
    "$runtime" start-recording "$turn.log"
    rm -f ${AGENT_RUNTIME_READABLE_TRANSCRIPT_FILE}
    printf '%s\n' "touch '$turn.running'; export ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX='$turn'; /bin/sh '$request'; status=\$?; sleep 2; printf '%s\\n' \"\$status\" > '$turn.result.tmp'; mv '$turn.result.tmp' '$turn.result'; exit \"\$status\"" > "$turn.session"
    "$runtime" launch "$turn.session"
    startup_polls=0
    dead_polls=0
    while [ ! -f "$turn.result" ]; do
      if [ -f "$turn.cancel" ]; then
        "$runtime" reset
        printf '130\n' > "$turn.result.tmp"
        mv "$turn.result.tmp" "$turn.result"
        break
      fi
      # A crashed pane must fail the turn rather than leave it working forever.
      # A driver may still report the previous process just after launch.
      startup_polls=$((startup_polls + 1))
      if { [ -f "$turn.running" ] || [ "$startup_polls" -ge 30 ]; } && ! "$runtime" alive; then
        dead_polls=$((dead_polls + 1))
        if [ "$dead_polls" -ge 3 ] && [ ! -f "$turn.result" ]; then
          printf '75\n' > "$turn.result.tmp"
          mv "$turn.result.tmp" "$turn.result"
          break
        fi
      else
        dead_polls=0
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
    mv "$turn.result" "$turn.exit"
    # The request can contain turn-scoped credentials; keep only its outcome.
    rm -f "$request" "$turn.session" "$turn.running"
  done
  sleep 1
done`;
}
