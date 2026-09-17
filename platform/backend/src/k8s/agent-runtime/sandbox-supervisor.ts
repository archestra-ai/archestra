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

# Failure sidecars are retained beside the exit ledger. The values below are
# supervisor-owned, bounded templates; provider output never enters them.
publish_failure() {
  turn="$1"
  code="$2"
  phase="$3"
  message="$4"
  resolution="$5"
  printf '{"version":1,"code":"%s","phase":"%s","message":"%s","resolution":"%s"}\n' "$code" "$phase" "$message" "$resolution" > "$turn.failure.tmp"
  mv "$turn.failure.tmp" "$turn.failure"
  if command -v archestra-agent-event >/dev/null 2>&1; then
    publish_event_context "$turn" "$turn.request"
    if [ -f "$turn.events/context.json" ]; then
      printf '{"type":"turn.finished","outcome":"failed","error":{"code":"%s","phase":"%s","message":"%s","resolution":"%s"}}\n' "$code" "$phase" "$message" "$resolution" |
        ARCHESTRA_AGENT_RUNTIME_TASK_ID="${"$"}{turn##*/}" archestra-agent-event emit \
          --context "$turn.events/context.json" --source supervisor --event-key "failure:$code" >/dev/null ||
        echo 'Agent Runtime failure event could not be saved' >&2
    fi
  fi
}

# Bind the turn before Herdr creates its recorder. The request contains the
# server-selected run UUID; parsing only this generated assignment avoids
# making the context identity depend on mutable process state.
publish_event_context() {
  turn="$1"
  request="$2"
  command -v archestra-agent-event >/dev/null 2>&1 || return 0
  attempt_id="$(sed -n "s/^export ARCHESTRA_AGENT_RUNTIME_RUN_ID='\\([^']*\\)'$/\\1/p" "$request")"
  if [ -z "$attempt_id" ] && [ "${"$"}{turn##*/}" = "${"$"}{ARCHESTRA_AGENT_RUNTIME_TASK_ID:-}" ]; then
    attempt_id="${"$"}{ARCHESTRA_AGENT_RUNTIME_RUN_ID:-}"
  fi
  case "$attempt_id" in
    ''|*[!a-fA-F0-9-]*) return 0 ;;
  esac
  export ARCHESTRA_AGENT_RUNTIME_ATTEMPT_ID="$attempt_id"
  task_id="${"$"}{turn##*/}"
  if ! ARCHESTRA_AGENT_RUNTIME_TASK_ID="$task_id" archestra-agent-event context \
    --path "$turn.events/context.json" \
    --task "$task_id" \
    --attempt "$attempt_id" >/dev/null 2>&1; then
    echo 'Agent Runtime event context could not be initialized' >&2
  fi
}

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
      publish_failure "$turn" runtime_restarted startup \
        'The runtime restarted before this turn finished.' \
        'Review the retained output before retrying: some actions may already have completed, so the turn was not replayed automatically.'
      printf '75\n' > "$turn.exit.tmp"
      mv "$turn.exit.tmp" "$turn.exit"
      rm -f "$request" "$turn.session"
      continue
    fi
    touch "$turn.started"
    : > "$turn.log"
    publish_event_context "$turn" "$request"
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
        publish_failure "$turn" terminal_start_failed terminal \
          'The runtime could not start the agent terminal.' \
          'Check the runtime startup logs and image configuration, then retry the run.'
        printf '75\n' > "$turn.result.tmp"
        mv "$turn.result.tmp" "$turn.result"
      fi
    else
      printf '%s\n' "touch '$turn.running'; export ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX='$turn'; /bin/sh '$turn.request'; status=\$?; sleep 2; printf '%s\\n' \"\$status\" > '$turn.result.tmp'; mv '$turn.result.tmp' '$turn.result'; exit \"\$status\"" > "$turn.session"
      if ! tmux respawn-pane -k -t agent "/bin/sh '$turn.session'"; then
        publish_failure "$turn" terminal_start_failed terminal \
          'The runtime could not start the agent terminal.' \
          'Check the runtime startup logs and image configuration, then retry the run.'
        printf '75\n' > "$turn.result.tmp"
        mv "$turn.result.tmp" "$turn.result"
      fi
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
          publish_failure "$turn" agent_process_exited terminal \
            'The agent process stopped before reporting a result.' \
            'Open the run logs to inspect the last output. Check the runtime image and memory limits before retrying.'
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
