import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import { ApiError } from "@/types";

export async function validateK8sNamespace(namespace: string): Promise<void> {
  // Need to list namespaces to reject non-existing ones because
  // canWriteToNamespace returns allowed: true for non-existent namespaces
  const availableNamespaces = await McpServerRuntimeManager.listNamespaces();
  if (!availableNamespaces.includes(namespace)) {
    throw new ApiError(
      400,
      `Kubernetes namespace "${namespace}" does not exist in the cluster.`,
    );
  }

  let canWrite: boolean;
  try {
    canWrite = await McpServerRuntimeManager.canWriteToNamespace(namespace);
  } catch (err) {
    throw new ApiError(
      500,
      `Failed to verify access to Kubernetes namespace "${namespace}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!canWrite) {
    throw new ApiError(
      400,
      `No write access to Kubernetes namespace "${namespace}". Ensure the service account has permission to create deployments there.`,
    );
  }
}
