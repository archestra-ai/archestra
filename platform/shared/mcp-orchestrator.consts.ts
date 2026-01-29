/**
 * Default values for MCP Orchestrator K8s deployment configuration.
 * These values are shared between the backend (K8sDeployment) and frontend (form placeholders).
 */
export const MCP_ORCHESTRATOR_DEFAULTS = {
  /** Default number of pod replicas */
  replicas: 1,
  /** Default memory request for containers */
  resourceRequestMemory: "128Mi",
  /** Default CPU request for containers */
  resourceRequestCpu: "50m",
} as const;
