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
command -v tmux >/dev/null 2>&1 || { echo 'Agent Runtime requires tmux' >&2; exit 78; }
# A retained terminal workspace must keep its native CLI session after an image upgrade.
if [ ! -f "$root/session-interface" ]; then
  interface=terminal
  if [ "$(printenv ARCHESTRA_AGENT_RUNTIME_INTERFACE || true)" = structured ] && command -v archestra-agent-session >/dev/null 2>&1; then
    interface=structured
    for started in "$root"/turns/*.started; do [ ! -f "$started" ] || interface=terminal; done
  fi
  printf '%s' "$interface" > "$root/session-interface"
fi
native_pid=''
trap '[ -z "$native_pid" ] || /bin/kill -TERM -- -"$native_pid" 2>/dev/null || true; tmux kill-server 2>/dev/null || true; exit 0' TERM INT

tmux new-session -d -x 120 -y 40 -s agent 'while :; do sleep 1; done'
tmux set-option -t agent mouse on
tmux set-option -t agent remain-on-exit on
tmux set-option -t agent @archestra_attention 0
tmux set-option -t agent status-left '#{?#{==:#{@archestra_attention},1},#[fg=yellow,bold]#{@archestra_attention_label}#[default] ,}[#S] '
tmux set-hook -g client-detached 'run-shell "date +%s > /var/run/archestra/development-activity"'

while :; do
  # Record human input, not pane output: a logging daemon must not keep an idle
  # workspace alive. Persist it so detached clients still count at reaping time.
  activity="$(tmux list-clients -F '#{client_activity}' 2>/dev/null | sort -nr | head -1)"
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
    tmux set-option -t agent @archestra_retained_task ""
    tmux respawn-pane -k -t agent 'while :; do sleep 1; done'
    tmux pipe-pane -t agent
    tmux pipe-pane -t agent "tee -a '$turn.log' >> /proc/1/fd/1"
    rm -f ${AGENT_RUNTIME_READABLE_TRANSCRIPT_FILE}
    printf '%s\n' "touch '$turn.running'; export ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX='$turn'; /bin/sh '$request'; status=\$?; sleep 2; printf '%s\\n' \"\$status\" > '$turn.result.tmp'; mv '$turn.result.tmp' '$turn.result'; exit \"\$status\"" > "$turn.session"
    native_pid=''
    if [ "$(cat "$root/session-interface")" = structured ] && command -v archestra-agent-session >/dev/null 2>&1; then
      # The agent owns pipes, not a terminal. tmux remains available as a shell.
      tmux pipe-pane -t agent
      tmux respawn-pane -k -t agent "/bin/bash --noprofile --norc"
      setsid /bin/sh "$turn.session" >> "$turn.log" 2>&1 &
      native_pid=$!
    else
      tmux respawn-pane -k -t agent "/bin/sh '$turn.session'"
    fi
    startup_polls=0
    dead_polls=0
    while [ ! -f "$turn.result" ]; do
      if [ -f "$turn.cancel" ]; then
        [ -z "$native_pid" ] || /bin/kill -TERM -- -"$native_pid" 2>/dev/null || true
        if [ -n "$native_pid" ]; then
          polls=0
          while kill -0 "$native_pid" 2>/dev/null && [ "$polls" -lt 5 ]; do sleep 1; polls=$((polls + 1)); done
          /bin/kill -KILL -- -"$native_pid" 2>/dev/null || true
        fi
        tmux respawn-pane -k -t agent 'while :; do sleep 1; done'
        printf '130\n' > "$turn.result.tmp"
        mv "$turn.result.tmp" "$turn.result"
        break
      fi
      # A crashed pane must fail the turn rather than leave it working forever.
      # tmux may still report the previous dead process just after respawn.
      startup_polls=$((startup_polls + 1))
      if [ -n "$native_pid" ] && ! kill -0 "$native_pid" 2>/dev/null && [ ! -f "$turn.result" ]; then
        printf '75\n' > "$turn.result"
      fi
      if [ -z "$native_pid" ] && { [ -f "$turn.running" ] || [ "$startup_polls" -ge 30 ]; } && [ "$(tmux display-message -p -t agent '#{pane_dead}' 2>/dev/null || echo 1)" = 1 ]; then
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
    [ -z "$native_pid" ] || wait "$native_pid" || true
    native_pid=''
    mv "$turn.result" "$turn.exit"
    # The request can contain turn-scoped credentials; keep only its outcome.
    rm -f "$request" "$turn.session" "$turn.running"
  done
  sleep 1
done`;
}
