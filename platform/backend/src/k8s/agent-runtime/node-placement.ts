import config from "@/config";

/**
 * The nodeSelector an Agent Runtime pod gets. A privileged run (nested
 * Docker, node-level access) goes to ARCHESTRA_AGENT_RUNTIME_PRIVILEGED_NODE_SELECTOR
 * when it is set, so it can land on a dedicated tainted pool away from
 * unprivileged runs; otherwise every run uses ARCHESTRA_AGENT_RUNTIME_NODE_SELECTOR.
 * The manifest turns each pair into a matching NoSchedule toleration.
 * Launches and the warm pool share this, or a launch could never claim a spare.
 */
export function resolveAgentRuntimeNodeSelector(params: {
  privileged: boolean;
}): Record<string, string> {
  const { nodeSelector, privilegedNodeSelector } = config.agentRuntime;
  if (params.privileged && Object.keys(privilegedNodeSelector).length > 0) {
    return privilegedNodeSelector;
  }
  return nodeSelector;
}
