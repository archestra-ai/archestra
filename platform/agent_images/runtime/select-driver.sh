#!/bin/sh
# Images select a driver here; workspace publication pins the returned identity.
set -eu

invalid_selection() {
  echo 'Agent terminal driver must be tmux or an absolute executable path' >&2
  exit 78
}

if [ -e /etc/archestra/terminal-driver ] || [ -L /etc/archestra/terminal-driver ]; then
  [ -f /etc/archestra/terminal-driver ] || invalid_selection
  selection="$(sed 's/^[[:space:]]*//; s/[[:space:]]*$//; /^$/d' /etc/archestra/terminal-driver)"
else
  selection="$(command -v archestra-runtime-driver || true)"
  if [ -z "$selection" ]; then
    if [ -e /usr/local/bin/archestra-runtime-driver ]; then
      echo 'Agent terminal driver is not executable' >&2
      exit 78
    fi
    selection=tmux
  elif [ "${selection#/}" = "$selection" ]; then
    selection="$(pwd)/$selection"
  fi
fi

[ -n "$selection" ] || invalid_selection
[ "$(printf '%s\n' "$selection" | wc -l)" -eq 1 ] || invalid_selection

case "$selection" in
  tmux) ;;
  /*) [ -f "$selection" ] && [ -x "$selection" ] || invalid_selection ;;
  *) invalid_selection ;;
esac
printf '%s\n' "$selection"
