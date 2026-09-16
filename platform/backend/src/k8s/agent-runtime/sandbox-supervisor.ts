import {
  AGENT_RUNTIME_HERDR_BINARY,
  AGENT_RUNTIME_READABLE_TRANSCRIPT_FILE,
  AGENT_RUNTIME_READABLE_TRANSCRIPT_MAX_BYTES,
  AGENT_RUNTIME_TERMINAL_BACKEND_FILE,
  AGENT_RUNTIME_TERMINAL_HELPER,
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
backend=tmux
if [ -f ${AGENT_RUNTIME_TERMINAL_BACKEND_FILE} ] && [ "$(cat ${AGENT_RUNTIME_TERMINAL_BACKEND_FILE} 2>/dev/null)" = herdr ] && command -v ${AGENT_RUNTIME_TERMINAL_HELPER} >/dev/null 2>&1 && command -v ${AGENT_RUNTIME_HERDR_BINARY} >/dev/null 2>&1; then
  backend=herdr
else
  command -v tmux >/dev/null 2>&1 || { echo 'Agent Runtime requires tmux or a ready Herdr terminal helper' >&2; exit 78; }
fi
trap 'if [ "$backend" = herdr ]; then ${AGENT_RUNTIME_TERMINAL_HELPER} stop >/dev/null 2>&1 || true; [ -z "${"$"}{terminal_pid:-}" ] || kill "$terminal_pid" 2>/dev/null || true; else tmux kill-server 2>/dev/null || true; fi; exit 0' TERM INT

if [ "$backend" = tmux ]; then
  tmux new-session -d -x 120 -y 40 -s agent 'while :; do sleep 1; done'
  tmux set-option -t agent mouse on
  tmux set-option -t agent remain-on-exit on
  tmux set-option -t agent @archestra_attention 0
  tmux set-option -t agent status-left '#{?#{==:#{@archestra_attention},1},#[fg=yellow,bold]#{@archestra_attention_label}#[default] ,}[#S] '
  tmux set-hook -g client-detached 'run-shell "date +%s > /var/run/archestra/development-activity"'
fi

while :; do
  if [ "$backend" = herdr ] && ! kill -0 "$terminal_pid" 2>/dev/null; then
    echo 'Agent Runtime Herdr terminal helper exited' >&2
    exit 78
  fi
  # Record human input, not pane output: a logging daemon must not keep an idle
  # workspace alive. Persist it so detached clients still count at reaping time.
  activity=
  if [ "$backend" = tmux ]; then activity="$(tmux list-clients -F '#{client_activity}' 2>/dev/null | sort -nr | head -1)"; fi
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
    : > "$turn.log"
    if [ "$backend" = tmux ]; then
      tmux set-option -t agent @archestra_retained_task ""
      tmux respawn-pane -k -t agent 'while :; do sleep 1; done'
      tmux pipe-pane -t agent
      tmux pipe-pane -t agent "tee -a '$turn.log' >> /proc/1/fd/1"
    fi
    rm -f ${AGENT_RUNTIME_READABLE_TRANSCRIPT_FILE}
    if [ "$backend" = herdr ]; then
      printf '%s\n' "touch '$turn.running'; export ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX='$turn'; export ARCHESTRA_AGENT_RUNTIME_INTERNAL=1; export HERDR_ENV=1; /bin/sh '$request'; status=\$?; sleep 2; printf '%s\\n' \"\$status\" > '$turn.result.tmp'; mv '$turn.result.tmp' '$turn.result'; exit \"\$status\"" > "$turn.session"
      start_failed=0
      if ! ${AGENT_RUNTIME_TERMINAL_HELPER} start "$turn" >>/proc/1/fd/1 2>>/proc/1/fd/2; then start_failed=1; fi
      if [ "$start_failed" = 1 ]; then
        printf '75\n' > "$turn.result.tmp"
        mv "$turn.result.tmp" "$turn.result"
      fi
    else
      printf '%s\n' "touch '$turn.running'; export ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX='$turn'; /bin/sh '$turn.request'; status=\$?; sleep 2; printf '%s\\n' \"\$status\" > '$turn.result.tmp'; mv '$turn.result.tmp' '$turn.result'; exit \"\$status\"" > "$turn.session"
      tmux respawn-pane -k -t agent "/bin/sh '$turn.session'"
    fi
    startup_polls=0
    dead_polls=0
    while [ ! -f "$turn.result" ]; do
      if [ -f "$turn.cancel" ]; then
        if [ "$backend" = herdr ]; then
          ${AGENT_RUNTIME_TERMINAL_HELPER} stop >/dev/null 2>&1 || true
        else
          tmux respawn-pane -k -t agent 'while :; do sleep 1; done'
        fi
        printf '130\n' > "$turn.result.tmp"
        mv "$turn.result.tmp" "$turn.result"
        break
      fi
      # A crashed terminal child must fail the turn rather than leave it
      # working forever. tmux may still report the previous dead process just
      # after respawn, while the helper reports the recorder identity directly.
      startup_polls=$((startup_polls + 1))
      pane_dead=0
      if [ "$backend" = herdr ]; then
        if ! ${AGENT_RUNTIME_TERMINAL_HELPER} alive >/dev/null 2>&1; then pane_dead=1; fi
      elif [ "$(tmux display-message -p -t agent '#{pane_dead}' 2>/dev/null || echo 1)" = 1 ]; then
        pane_dead=1
      fi
      if { [ -f "$turn.running" ] || [ "$startup_polls" -ge 30 ]; } && [ "$pane_dead" = 1 ]; then
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
