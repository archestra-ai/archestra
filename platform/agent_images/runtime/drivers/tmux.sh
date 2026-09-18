#!/bin/sh
# Terminal mechanics only: the common runtime supplies processes and task policy.
set -eu
command -v tmux >/dev/null 2>&1 || {
  echo 'Agent Runtime requires a terminal driver or tmux' >&2
  exit 78
}
root="${ARCHESTRA_AGENT_RUNTIME_DIR:-/var/run/archestra}"
operation="${1:-}"
[ "$#" -eq 0 ] || shift
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

case "$operation" in
  describe)
    printf '%s\n' archestra-terminal-driver-v2
    ;;
  create)
    [ "$#" -eq 3 ] || exit 64
    tmux new-session -d -x "$2" -y "$3" -s agent "exec /bin/sh $(quote "$1")"
    rm -f "$root/runtime-terminal-final-frame" "$root"/runtime-terminal-final-frame.tmp.*
    tmux set-option -t '=agent:' mouse on
    tmux set-option -t '=agent:' remain-on-exit on
    tmux set-option -t '=agent:' @archestra_attention 0
    tmux set-option -t '=agent:' status-left '#{?#{==:#{@archestra_attention},1},#[fg=yellow,bold]#{@archestra_attention_label}#[default] ,}[#S] '
    tmux set-hook -t '=agent:' client-detached "run-shell $(quote "date +%s > $(quote "$root/development-activity")")"
    ;;
  replace)
    [ "$#" -eq 1 ] || exit 64
    tmux respawn-pane -k -t '=agent:' "exec /bin/sh $(quote "$1")"
    ;;
  ready)
    tmux has-session -t '=agent' 2>/dev/null
    ;;
  alive)
    [ "$(tmux display-message -p -t '=agent:' '#{pane_dead}' 2>/dev/null)" = 0 ]
    ;;
  inside)
    [ -n "${TMUX:-}" ]
    ;;
  attach)
    attachment="$(tmux display-message -p -t '=agent:' '#{pid}:#{pane_id}')"
    pane="${attachment#*:}"
    tmux set-option -t '=agent:' mouse on
    status=0
    tmux attach -t '=agent' || status=$?
    # tmux restores the caller's screen on detach. Repaint the owned frame so
    # viewers keep useful output without filtering bytes printed by the agent.
    if [ "$(tmux display-message -p -t "$pane" '#{pid}:#{pane_id}' 2>/dev/null)" = "$attachment" ] && frame="$(tmux capture-pane -p -e -t "$pane" 2>/dev/null)"; then
      printf '\033[?1049l\033[0m\033[H\033[2J%s\n' "$frame"
    elif [ -f "$root/runtime-terminal-final-frame" ]; then
      {
        IFS= read -r saved_attachment || saved_attachment=''
        if [ "$saved_attachment" = "$attachment" ]; then
          printf '\033[?1049l\033[0m\033[H\033[2J'
          cat
        fi
      } < "$root/runtime-terminal-final-frame" 2>/dev/null || true
    fi
    exit "$status"
    ;;
  submit)
    [ "$#" -eq 1 ] || exit 64
    tmux send-keys -t '=agent:' -l -- "$1"
    # Paste guards may consume an immediate Enter as part of the pasted text.
    sleep 1
    tmux send-keys -t '=agent:' Enter
    ;;
  capture)
    if [ "${1:-}" = scrollback ]; then
      tmux capture-pane -p -e -S - -t '=agent:'
    else
      tmux capture-pane -p -e -t '=agent:'
    fi
    ;;
  geometry)
    tmux has-session -t '=agent' 2>/dev/null || exit 1
    tmux display-message -p -t '=agent:' '#{pane_width}x#{pane_height}'
    ;;
  present-attention)
    [ "$#" -eq 2 ] || exit 64
    case "$1" in 0|1) ;; *) exit 64 ;; esac
    tmux set-option -t '=agent:' @archestra_attention "$1"
    tmux set-option -t '=agent:' @archestra_attention_label "$2"
    ;;
  start-recording)
    [ "$#" -eq 1 ] || exit 64
    tmux pipe-pane -t '=agent:'
    tmux pipe-pane -t '=agent:' "tee -a $(quote "$1") >> /proc/1/fd/1"
    ;;
  activity)
    tmux list-clients -t '=agent' -F '#{client_activity}' 2>/dev/null || true
    ;;
  stop)
    if attachment="$(tmux display-message -p -t '=agent:' '#{pid}:#{pane_id}' 2>/dev/null)" && frame="$(tmux capture-pane -p -e -t '=agent:' 2>/dev/null)"; then
      snapshot="$root/runtime-terminal-final-frame"
      umask 077
      { printf '%s\n' "$attachment"; printf '%s\n' "$frame"; } > "$snapshot.tmp.$$" && mv "$snapshot.tmp.$$" "$snapshot" || rm -f "$snapshot.tmp.$$"
    fi
    tmux kill-session -t '=agent' 2>/dev/null || true
    ;;
  *) echo 'Unknown terminal driver operation' >&2; exit 64 ;;
esac
