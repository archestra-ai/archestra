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

calculate_percentage() {
  value=$1
  percentage=$2
  case "$value" in
    "" | *[!0-9]*) return 1 ;;
  esac

  awk -v value="$value" -v percentage="$percentage" \
    'BEGIN { result = int(value * percentage / 100); if (result > 0) printf "%d\n", result }'
}

# Prefer the cgroup hard limit. Keep 40% outside V8 old-space for young-space,
# native/external allocations, thread stacks, and the other web-container
# processes. If no limit exists, use the request with Node's documented 75%
# example ratio; requests guide scheduling but are not an OOM boundary.
if calculated=$(calculate_percentage "${ARCHESTRA_NODE_MEMORY_LIMIT_MIB:-}" 60); then
  if [ -n "$calculated" ]; then
    printf "%s\n" "$calculated"
    exit 0
  fi
fi

if calculated=$(calculate_percentage "${ARCHESTRA_NODE_MEMORY_REQUEST_MIB:-}" 75); then
  if [ -n "$calculated" ]; then
    printf "%s\n" "$calculated"
  fi
fi
