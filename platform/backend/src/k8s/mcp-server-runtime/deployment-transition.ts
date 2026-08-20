/** Serializes Kubernetes lifecycle changes for one physical MCP deployment. */
export const MCP_DEPLOYMENT_TRANSITION_LEASE_SCOPE =
  "mcp-idle-hibernation-transition";

/** Bounds acquisition and work for one deployment lifecycle transition. */
export const MCP_DEPLOYMENT_TRANSITION_DEADLINE_MS = 120_000;
