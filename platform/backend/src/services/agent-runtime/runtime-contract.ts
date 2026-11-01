/** Filesystem contract shared by maintained Agent Runtime images and backends. */
export const AGENT_RUNTIME_DIR = "/var/run/archestra";
/** Full Secret-volume mount: subPath mounts would never receive token updates. */
export const AGENT_RUNTIME_CREDENTIALS_DIR = `${AGENT_RUNTIME_DIR}/credentials`;
export const AGENT_RUNTIME_CREDENTIALS_FILE = `${AGENT_RUNTIME_CREDENTIALS_DIR}/current.json`;
export const AGENT_RUNTIME_CREDENTIALS_SECRET_KEY =
  "ARCHESTRA_AGENT_RUNTIME_RENEWABLE_CREDENTIALS";
export const AGENT_RUNTIME_STEER_FIFO = `${AGENT_RUNTIME_DIR}/steer`;
/** The name of the tier the Pod runs at. */
export const AGENT_RUNTIME_TIER_ENV = "ARCHESTRA_AGENT_RUNTIME_TIER";
/** The run's system prompt, with the Agent's own text first. */
export const AGENT_RUNTIME_SYSTEM_PROMPT_ENV =
  "ARCHESTRA_AGENT_RUNTIME_SYSTEM_PROMPT";
/** The name of the largest tier a run of this Agent may ask for. */
export const AGENT_RUNTIME_MAX_TIER_ENV = "ARCHESTRA_AGENT_RUNTIME_MAX_TIER";
/**
 * JSON: the tiers a run of this Agent may move to, smallest first, each with
 * its name, CPU and memory, and `current` on the one the Pod runs at.
 */
export const AGENT_RUNTIME_TIERS_ENV = "ARCHESTRA_AGENT_RUNTIME_TIERS";
/**
 * The Pod's size as Kubernetes quantities, so tools and models can size their
 * work. A runtime Pod usually has no CPU limit: its CPU request is the share
 * it can count on.
 */
export const AGENT_RUNTIME_CPU_REQUEST_ENV =
  "ARCHESTRA_AGENT_RUNTIME_POD_CPU_REQUEST";
export const AGENT_RUNTIME_CPU_LIMIT_ENV =
  "ARCHESTRA_AGENT_RUNTIME_POD_CPU_LIMIT";
export const AGENT_RUNTIME_MEMORY_REQUEST_ENV =
  "ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_REQUEST";
export const AGENT_RUNTIME_MEMORY_LIMIT_ENV =
  "ARCHESTRA_AGENT_RUNTIME_POD_MEMORY_LIMIT";
/** Whole CPUs to run in parallel: the CPU limit, else the request, rounded up. */
export const AGENT_RUNTIME_CPUS_ENV = "ARCHESTRA_AGENT_RUNTIME_POD_CPUS";
/**
 * Thread counts of common toolchains, set to the Pod's CPUs. Without them Go
 * programs (the TypeScript 7 compiler, gh, kubectl), Cargo and Rayon size
 * themselves for every CPU of the node, not the Pod's share. An Agent's own
 * environment can set them to something else.
 */
export const AGENT_RUNTIME_TOOLCHAIN_PARALLELISM_ENVS = [
  "GOMAXPROCS",
  "CARGO_BUILD_JOBS",
  "RAYON_NUM_THREADS",
] as const;
/** Stable command that joins the interactive session from any exec client. */
export const AGENT_RUNTIME_ATTACH_SCRIPT = `${AGENT_RUNTIME_DIR}/attach`;
/** Startup hook used by interactive shells opened directly in an Agent Runtime pod. */
export const AGENT_RUNTIME_SHELL_INIT_SCRIPT = `${AGENT_RUNTIME_DIR}/shell-init`;
/** Stable input location shared by every runtime backend and Agent image. */
export const AGENT_RUNTIME_ATTACHMENTS_DIR = `${AGENT_RUNTIME_DIR}/attachments`;
export const AGENT_RUNTIME_ATTACHMENTS_MANIFEST = `${AGENT_RUNTIME_DIR}/attachments.json`;
export const AGENT_RUNTIME_INPUTS_READY_FILE = `${AGENT_RUNTIME_DIR}/inputs-ready`;
export const AGENT_RUNTIME_READABLE_TRANSCRIPT_FILE = `${AGENT_RUNTIME_DIR}/readable-transcript.json`;

/**
 * A maintained runtime can leave a normalized transcript in the shared run
 * directory. The bootstrap base64-frames it on stdout after the PTY closes so
 * the control plane can persist it independently without exposing raw provider
 * events in the terminal recording.
 */
export const AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_START =
  "\u001b]777;archestra-readable-transcript=base64\u0007";
export const AGENT_RUNTIME_READABLE_TRANSCRIPT_PROTOCOL_END =
  "\u001b]777;archestra-readable-transcript=end\u0007";

/** A second readable copy stays useful without doubling very large run logs. */
export const AGENT_RUNTIME_READABLE_TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Stable, portable run name: `agent-run-<slug40>-<id8>`.
 *
 * It is frozen before launch so a display-name change cannot orphan a live
 * run. The conservative character set works for the Kubernetes backend
 * and remains safe as an identifier for VM and managed-sandbox adapters.
 */
export function constructStableRunName(
  displayName: string,
  id: string,
): string {
  const slug =
    displayName
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9.-]/g, "")
      .replace(/-+/g, "-")
      .replace(/\.+/g, ".")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 40)
      .replace(/[^a-z0-9]+$/, "") || "session";
  return `agent-run-${slug}-${id.slice(0, 8)}`;
}

/**
 * The key a run's LLM traffic is logged under (`interactions.session_id`):
 * its frozen run name.
 *
 * pod-run hands the name to the image as `ARCHESTRA_AGENT_RUNTIME_WORKSPACE_ID`,
 * and the run headers an image sends on every model and gateway request
 * carry it as `X-Archestra-Session-Id` and `X-Appa-Session-ID`. The proxy keys
 * interactions by the first, or by the second when a client sends only that
 * one, and refuses a run-bound request whose OpenAPPA session names another
 * workspace. The platform's own requests for a run (its title) and every
 * link to `/llm/logs/:id` therefore use this key. It is not the task id,
 * which a continued session renews each turn, and not the workspace row's
 * UUID.
 */
export function agentRunLlmSessionId(run: { workloadName: string }): string {
  return run.workloadName;
}
