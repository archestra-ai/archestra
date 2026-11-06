import { AGENT_RUNTIME_DIR } from "@/services/agent-runtime/runtime-contract";

/** Exit status of a run's Pod that stopped because its workspace volume is full. */
export const AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE = 76;

/**
 * Exit status of a run's Pod that stopped because its workspace volume refuses
 * writes for another reason, such as a read-only or failing volume.
 *
 * @public — the docs name this status; tests assert it.
 */
export const AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE = 77;

/**
 * An EXIT trap for the shell that is the run's PID 1: the Pod's startup, then
 * the supervisor.
 *
 * The runtime directory is on the workspace volume, next to the home
 * directory and, for privileged runs, the Docker data, so a run can fill it.
 * All three are subPaths of the one claim, so they share one filesystem: a
 * write through any of them takes the same blocks and inodes, and the probe
 * and `df` on the runtime directory see the whole claim. The manifests tests
 * pin that layout.
 * Under `set -e`, the first write the volume refuses then ends PID 1 with
 * status 1 or 2, and Kubernetes reports "exit code 1" and nothing else. When
 * PID 1 ends that way, the trap tries one small write. Only if the volume
 * refuses it does the exit change: to the full-volume status when no space or
 * no inodes are left for the run's user, else to the unwritable status. The
 * reason goes to the container's termination message, which Kubernetes shows
 * with the Pod's failure. Any other exit keeps its status.
 */
export function buildWorkspaceExitTrapScript(): string {
  return String.raw`archestra_workspace_exit() {
  status=$?
  case "$status" in 1|2) ;; *) return ;; esac
  if { printf 'probe\n' > ${PROBE_FILE}; } 2>/dev/null; then
    rm -f ${PROBE_FILE} 2>/dev/null || true
    return
  fi
  rm -f ${PROBE_FILE} 2>/dev/null || true
  space="$(df -Pk ${AGENT_RUNTIME_DIR} 2>/dev/null | awk 'NR == 2 && $2 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ { print $2, $4 }')" || space=""
  inodes="$(df -Pi ${AGENT_RUNTIME_DIR} 2>/dev/null | awk 'NR == 2 && $2 ~ /^[0-9]+$/ && $4 ~ /^[0-9]+$/ { print $2, $4 }')" || inodes=""
  used=""
  # A filesystem that tracks no inodes reports 0 of 0; only 0 free of some is full.
  case "$inodes" in *" 0") [ "${"$"}{inodes% *}" = 0 ] || used=" (no room for more files)" ;; esac
  if [ -z "$used" ] && [ -n "$space" ] && [ "${"$"}{space#* }" -lt ${LOW_SPACE_KIB} ]; then
    used="$(echo "$space" | awk '{ if ($1 >= 1048576) printf " (%.1f of %.1f GiB used)", ($1 - $2) / 1048576, $1 / 1048576; else printf " (%d of %d MiB used)", ($1 - $2) / 1024, $1 / 1024 }')" || used=" (no space left)"
  fi
  if [ -n "$used" ]; then
    code=${AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE}
    reason="${FULL_REASON_START}$used${FULL_REASON_END}"
  elif [ -n "$space" ]; then
    code=${AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE}
    reason="${UNWRITABLE_WITH_SPACE_REASON}"
  else
    code=${AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE}
    reason="${UNWRITABLE_REASON}"
  fi
  echo "agent-runtime: $reason" >&2 || true
  { printf '%s' "$reason" > /dev/termination-log; } 2>/dev/null || true
  exit "$code"
}
trap archestra_workspace_exit EXIT`;
}

/**
 * What a Pod's exit status says about its workspace volume, for a failure
 * whose termination message the runtime could not write; undefined for
 * statuses the trap does not set.
 */
export function workspaceExitExplanation(exitCode: number): string | undefined {
  if (exitCode === AGENT_RUNTIME_WORKSPACE_FULL_EXIT_CODE)
    return `${FULL_REASON_START}${FULL_REASON_END}`;
  if (exitCode === AGENT_RUNTIME_WORKSPACE_UNWRITABLE_EXIT_CODE)
    return UNWRITABLE_REASON;
  return undefined;
}

// ===================== internals =====================

const PROBE_FILE = `${AGENT_RUNTIME_DIR}/.workspace-probe`;
/** Below this much free space, a volume that refuses a write is full. */
const LOW_SPACE_KIB = 64 * 1024;
/** The full-volume reason; the trap puts the used space between the halves. */
const FULL_REASON_START = "The workspace volume is full";
const FULL_REASON_END =
  ", so the run stopped. Ask an administrator for a larger workspace volume, then start a new run.";
const UNWRITABLE_WITH_SPACE_REASON =
  "The workspace volume cannot be written although it has space, so the run stopped. It may be read-only or failing. Ask the cluster operator to check it.";
const UNWRITABLE_REASON =
  "The workspace volume cannot be written, so the run stopped. It may be full, read-only or failing.";
