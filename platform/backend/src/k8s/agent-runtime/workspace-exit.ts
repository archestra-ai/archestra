import { AGENT_RUNTIME_DIR } from "@/services/agent-runtime/runtime-contract";

/** Exit status of a run's Pod that stopped because its workspace volume is full. */
export const AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE = 76;

/**
 * Exit status of a run's Pod that stopped because its workspace volume refuses
 * writes although it has space: it is read-only or failing.
 */
export const AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE = 77;

/**
 * An EXIT trap for the shell that is the run's PID 1: the Pod's startup, then
 * the supervisor.
 *
 * The runtime directory is on the workspace volume, next to the home
 * directory and, for privileged runs, the Docker data, so a run can fill it.
 * Under `set -e`, the first write the volume refuses then ends PID 1 with
 * status 1 or 2, and Kubernetes reports "exit code 1" and nothing else. The
 * trap checks the volume when PID 1 ends that way. A full volume (no space or
 * no inodes left) or one that refuses writes gets its own exit status, and
 * the reason goes to the container's termination message, which Kubernetes
 * shows with the Pod's failure. Any other exit keeps its status.
 */
export function buildWorkspaceExitTrapScript(): string {
  return String.raw`archestra_workspace_exit() {
  status=$?
  case "$status" in 1|2) ;; *) return ;; esac
  space="$(df -Pk ${AGENT_RUNTIME_DIR} 2>/dev/null | awk 'NR == 2 { print $2, $4 }')" || space=""
  inodes="$(df -Pi ${AGENT_RUNTIME_DIR} 2>/dev/null | awk 'NR == 2 { print $4 }')" || inodes=""
  total="${"$"}{space% *}"
  available="${"$"}{space#* }"
  writable=0
  if printf 'probe\n' > ${PROBE_FILE} 2>/dev/null; then writable=1; fi
  rm -f ${PROBE_FILE} 2>/dev/null || true
  used=""
  case "$inodes" in ''|*[!0-9]*) ;; 0) used=" (no room for more files)" ;; esac
  case "$total:$available" in
    *[!0-9:]*|:*|*:) ;;
    *)
      if [ -z "$used" ] && [ "$available" -lt ${LOW_SPACE_KIB} ]; then
        used="$(awk -v total="$total" -v available="$available" 'BEGIN { if (total >= 1048576) printf " (%.1f of %.1f GiB used)", (total - available) / 1048576, total / 1048576; else printf " (%d of %d MiB used)", (total - available) / 1024, total / 1024 }')" || used=" (no space left)"
      fi
      ;;
  esac
  if [ -n "$used" ]; then
    code=${AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE}
    reason="The workspace volume is full$used, so the run stopped. Start a new run with a larger workspace volume."
  elif [ "$writable" = 1 ]; then
    return
  elif [ -n "$available" ]; then
    code=${AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE}
    reason="The workspace volume cannot be written although it has space, so the run stopped. It may be read-only or failing. Ask the cluster operator to check it."
  else
    code=${AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE}
    reason="The workspace volume cannot be written, so the run stopped. It may be full, read-only or failing."
  fi
  echo "agent-runtime: $reason" >&2 || true
  printf '%s' "$reason" > /dev/termination-log 2>/dev/null || true
  exit "$code"
}
trap archestra_workspace_exit EXIT`;
}

// ===================== internals =====================

const PROBE_FILE = `${AGENT_RUNTIME_DIR}/.workspace-probe`;
/** Below this much free space, a refused write means the volume is full. */
const LOW_SPACE_KIB = 64 * 1024;
