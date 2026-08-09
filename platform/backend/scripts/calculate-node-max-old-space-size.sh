#!/bin/sh

set -eu

# An operator-supplied Node heap limit always wins.
case " ${NODE_OPTIONS:-} " in
  *" --max-old-space-size="* | *" --max_old_space_size="* | *" --max-old-space-size "* | *" --max_old_space_size "*)
    exit 0
    ;;
esac

# This explicit override supports a positive MiB value, or 0 to disable the
# automatically calculated CLI flag.
if [ "${ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB+x}" = "x" ]; then
  override=$ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB
  case "$override" in
    "" | *[!0-9]*)
      echo "ARCHESTRA_NODE_MAX_OLD_SPACE_SIZE_MIB must be a non-negative integer" >&2
      exit 1
      ;;
  esac

  awk -v value="$override" 'BEGIN { if (value > 0) printf "%d\n", value }'
  exit 0
fi

# Memory inside this container that is NOT available to this Node process,
# because something else in the container needs it. The web container runs the
# Next.js server and supervisord alongside the backend; the worker and renderer
# run a single Node process and set nothing here.
reserved_mib=${ARCHESTRA_NODE_MEMORY_RESERVED_MIB:-0}
case "$reserved_mib" in
  "" | *[!0-9]*)
    echo "ARCHESTRA_NODE_MEMORY_RESERVED_MIB must be a non-negative integer" >&2
    exit 1
    ;;
esac

calculate_percentage() {
  value=$1
  percentage=$2
  reserved=${3:-0}
  case "$value" in
    "" | *[!0-9]*) return 1 ;;
  esac

  # Subtract the reservation before taking the percentage, so the split is over
  # the memory this process can actually use. A reservation that swallows the
  # whole limit is ignored rather than obeyed: emitting nothing would silently
  # hand the process back Node's cgroup default, which is the opposite of what a
  # misconfigured reservation is asking for.
  awk -v value="$value" -v percentage="$percentage" -v reserved="$reserved" \
    'BEGIN {
       usable = value - reserved;
       if (usable <= 0) usable = value;
       result = int(usable * percentage / 100);
       if (result > 0) printf "%d\n", result
     }'
}

# Prefer the cgroup hard limit. Keep 40% of the usable memory outside V8
# old-space for young-space, native/external allocations, and thread stacks. If
# no limit exists, use the request with Node's documented 75% example ratio;
# requests guide scheduling but are not an OOM boundary.
if calculated=$(calculate_percentage "${ARCHESTRA_NODE_MEMORY_LIMIT_MIB:-}" 60 "$reserved_mib"); then
  if [ -n "$calculated" ]; then
    printf "%s\n" "$calculated"
    exit 0
  fi
fi

if calculated=$(calculate_percentage "${ARCHESTRA_NODE_MEMORY_REQUEST_MIB:-}" 75 "$reserved_mib"); then
  if [ -n "$calculated" ]; then
    printf "%s\n" "$calculated"
  fi
fi
