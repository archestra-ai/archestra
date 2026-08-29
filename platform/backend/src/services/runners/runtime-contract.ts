/** Filesystem contract shared by maintained execution images and backends. */
export const RUNNER_RUNTIME_DIR = "/var/run/archestra";
export const RUNNER_STEER_FIFO = `${RUNNER_RUNTIME_DIR}/steer`;
/** Stable command that joins the interactive session from any exec client. */
export const RUNNER_ATTACH_SCRIPT = `${RUNNER_RUNTIME_DIR}/attach`;
/** Startup hook used by interactive shells opened directly in a runner pod. */
export const RUNNER_SHELL_INIT_SCRIPT = `${RUNNER_RUNTIME_DIR}/shell-init`;
/** Stable input location shared by every execution backend and Agent image. */
export const RUNNER_ATTACHMENTS_DIR = `${RUNNER_RUNTIME_DIR}/attachments`;
export const RUNNER_ATTACHMENTS_MANIFEST = `${RUNNER_RUNTIME_DIR}/attachments.json`;
export const RUNNER_INPUTS_READY_FILE = `${RUNNER_RUNTIME_DIR}/inputs-ready`;

/**
 * Stable, portable execution name: `runner-<slug40>-<id8>`.
 *
 * It is frozen before launch so a display-name change cannot orphan a live
 * execution. The conservative character set works for the Kubernetes backend
 * and remains safe as an identifier for VM and managed-sandbox adapters.
 */
export function constructStableExecutionName(
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
  return `runner-${slug}-${id.slice(0, 8)}`;
}
