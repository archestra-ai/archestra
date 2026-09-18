#!/bin/sh
# Workspace policy and task metadata live here; drivers own terminal mechanics.
set -eu
umask 077

[ "$#" -ge 3 ] || exit 64
driver="$1"
legacy_bridge="$2"
operation="$3"
shift 3
root="${ARCHESTRA_AGENT_RUNTIME_DIR:-/var/run/archestra}"

validate_driver() {
  [ "$("$driver" describe)" = archestra-terminal-driver-v2 ] || {
    echo 'Unsupported Agent terminal driver protocol' >&2
    exit 78
  }
}

write_retained() {
  printf '%s\n' "$1" > "$root/runtime-retained-task.tmp.$$"
  mv "$root/runtime-retained-task.tmp.$$" "$root/runtime-retained-task"
}

write_attention() {
  printf '%s\n%s\n' "$1" "$2" > "$root/runtime-attention.tmp.$$"
  mv "$root/runtime-attention.tmp.$$" "$root/runtime-attention"
}

prepare_idle() {
  printf '#!/bin/sh\nwhile :; do sleep 1; done\n' > "$root/runtime-idle.sh.tmp.$$"
  mv "$root/runtime-idle.sh.tmp.$$" "$root/runtime-idle.sh"
}

clear_metadata() {
  rm -f "$root/runtime-retained-task"
  write_attention 0 ''
  [ -z "$legacy_bridge" ] || /bin/sh "$legacy_bridge" clear
  "$driver" present-attention 0 ''
}

case "$operation" in
  describe)
    printf '%s\n' archestra-image-runtime-v1
    ;;
  cancel|read-result)
    case "${1:-}" in
      ''|*[!a-zA-Z0-9-]*) echo 'Invalid runtime task ID' >&2; exit 64 ;;
    esac
    base="$root/turns/$1"
    if [ "$operation" = cancel ]; then
      [ ! -f "$base.exit" ] || exit 0
      touch "$base.cancel"
      if [ ! -f "$base.request" ] && [ ! -f "$base.started" ]; then
        printf '130\n' > "$base.exit.tmp"
        mv "$base.exit.tmp" "$base.exit"
      fi
      attempt=0
      while [ ! -f "$base.exit" ]; do
        attempt=$((attempt + 1))
        [ "$attempt" -lt 15 ] || exit 1
        sleep 1
      done
    elif [ -f "$base.exit" ]; then
      printf '%s\n' "$(cat "$base.exit")"
      if [ -f "$base.failure" ]; then
        head -c 4097 "$base.failure" 2>/dev/null || true
      fi
    fi
    ;;
  submit-fifo)
    [ "$#" -eq 1 ] || exit 64
    printf '%s\n' "$1" > "$root/steer"
    ;;
  initialize|reset)
    [ "$#" -eq 0 ] || exit 64
    validate_driver
    prepare_idle
    if [ "$operation" = initialize ]; then
      "$driver" create "$root/runtime-idle.sh" 120 40
    else
      "$driver" replace "$root/runtime-idle.sh"
    fi
    clear_metadata
    ;;
  launch)
    [ "$#" -eq 1 ] || exit 64
    validate_driver
    exec "$driver" replace "$1"
    ;;
  retained)
    [ "$#" -le 1 ] || exit 64
    validate_driver
    if [ "$#" -eq 1 ]; then
      [ -z "$legacy_bridge" ] || /bin/sh "$legacy_bridge" retained "$1"
      write_retained "$1"
    elif "$driver" alive; then
      # Images built before the facade publish completion tags through tmux.
      if [ -n "$legacy_bridge" ]; then
        write_retained "$(/bin/sh "$legacy_bridge" retained)"
      fi
      cat "$root/runtime-retained-task" 2>/dev/null || true
    fi
    ;;
  attention)
    [ "$#" -le 2 ] || exit 64
    validate_driver
    if [ "$#" -gt 0 ]; then
      case "$1" in 0|1) ;; *) exit 64 ;; esac
      "$driver" present-attention "$1" "${2:-}"
      write_attention "$1" "${2:-}"
    else
      if [ -n "$legacy_bridge" ]; then
        /bin/sh "$legacy_bridge" attention > "$root/runtime-attention.tmp.$$"
        mv "$root/runtime-attention.tmp.$$" "$root/runtime-attention"
      fi
      if [ -f "$root/runtime-attention" ]; then
        cat "$root/runtime-attention"
      else
        printf '0\n\n'
      fi
    fi
    ;;
  activity)
    validate_driver
    { cat "$root/development-activity" 2>/dev/null || true; "$driver" activity; } | sort -nr | head -1
    ;;
  ready|alive|inside|attach|submit|capture|geometry|start-recording|stop)
    validate_driver
    exec "$driver" "$operation" "$@"
    ;;
  *)
    echo 'Unknown image runtime operation' >&2
    exit 64
    ;;
esac
