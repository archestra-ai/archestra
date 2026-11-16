import config from "@/config";

/**
 * The namespace an Agent's runtime pods (runs and warm spares) live in. The
 * Agent's Environment namespace wins; then ARCHESTRA_AGENT_RUNTIME_K8S_NAMESPACE,
 * which keeps runs apart from MCP servers; then the organization's default
 * Environment namespace; then the orchestrator namespace. Launches and the
 * warm pool share it, or a launch could never claim a spare.
 */
export function resolveAgentRuntimeNamespace(params: {
  environmentNamespace?: string | null;
  organizationNamespace?: string | null;
}): string {
  return (
    params.environmentNamespace ??
    config.agentRuntime.namespace ??
    params.organizationNamespace ??
    config.orchestrator.kubernetes.namespace
  );
}
