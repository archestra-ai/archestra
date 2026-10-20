import type { McpDeploymentStatusEntry } from "@archestra/shared";
import type McpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";

/**
 * The runtime state of each install, as the deployment feed sends it and as
 * the server's attention order reads it: the runtime's entry, or "not created"
 * when the runtime holds none. Nothing at all while the runtime is not
 * running (off, starting or failed): its summary says nothing true about any
 * deployment then, and a "not created" for every install would flag every
 * healthy one as not running.
 */
export function projectMcpDeploymentStatuses(
  summary: typeof McpServerRuntimeManager.statusSummary,
  serverIds: Iterable<string>,
): Record<string, McpDeploymentStatusEntry> {
  if (summary.status !== "running") return {};
  const result: Record<string, McpDeploymentStatusEntry> = {};
  for (const serverId of serverIds) {
    const status = summary.mcpServers[serverId];
    result[serverId] = status
      ? {
          state: status.state,
          message: status.message,
          error: status.error,
          restartCount: status.restartCount,
          podAge: status.podAge,
          podName: status.podName,
          deploymentName: status.deploymentName ?? undefined,
        }
      : {
          state: "not_created",
          message: "Deployment not created",
          error: null,
        };
  }
  return result;
}
