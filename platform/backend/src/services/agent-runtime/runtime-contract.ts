/** Filesystem contract shared by maintained Agent Runtime images and backends. */
export const AGENT_RUNTIME_DIR = "/var/run/archestra";
export const AGENT_RUNTIME_STEER_FIFO = `${AGENT_RUNTIME_DIR}/steer`;
/** Stable command that joins the interactive session from any exec client. */
export const AGENT_RUNTIME_ATTACH_SCRIPT = `${AGENT_RUNTIME_DIR}/attach`;
/** Startup hook used by interactive shells opened directly in an Agent Runtime pod. */
export const AGENT_RUNTIME_SHELL_INIT_SCRIPT = `${AGENT_RUNTIME_DIR}/shell-init`;
/** Stable input location shared by every runtime backend and Agent image. */
export const AGENT_RUNTIME_ATTACHMENTS_DIR = `${AGENT_RUNTIME_DIR}/attachments`;
export const AGENT_RUNTIME_ATTACHMENTS_MANIFEST = `${AGENT_RUNTIME_DIR}/attachments.json`;
export const AGENT_RUNTIME_INPUTS_READY_FILE = `${AGENT_RUNTIME_DIR}/inputs-ready`;

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
