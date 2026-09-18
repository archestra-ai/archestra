#!/bin/sh
# Only old image helpers use these options as task state. This bridge is excluded
# from the driver ABI and is enabled only for the bundled tmux compatibility path.
set -eu

operation="${1:-}"
[ "$#" -eq 0 ] || shift
case "$operation" in
  retained)
    [ "$#" -le 1 ] || exit 64
    if [ "$#" -eq 1 ]; then
      tmux set-option -t '=agent:' @archestra_retained_task "$1"
    else
      tmux show-option -qv -t '=agent:' @archestra_retained_task
    fi
    ;;
  attention)
    [ "$#" -eq 0 ] || exit 64
    flag="$(tmux show-option -qv -t '=agent:' @archestra_attention)"
    case "$flag" in 0|1) ;; *) flag=0 ;; esac
    printf '%s\n' "$flag"
    tmux show-option -qv -t '=agent:' @archestra_attention_label
    ;;
  clear)
    [ "$#" -eq 0 ] || exit 64
    tmux set-option -t '=agent:' @archestra_retained_task ''
    tmux set-option -t '=agent:' @archestra_attention 0
    tmux set-option -t '=agent:' @archestra_attention_label ''
    ;;
  *) echo 'Unknown legacy terminal state operation' >&2; exit 64 ;;
esac
