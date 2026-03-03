/**
 * Default Kubernetes namespace for MCP server pods.
 */
export const DEFAULT_MCP_SERVER_NAMESPACE = "default";

/**
 * Default Kubernetes namespace for connector CronJobs.
 */
export const DEFAULT_CONNECTOR_NAMESPACE = "archestra-connectors";

/**
 * Common K8s label keys used across Archestra resources.
 */
export const K8S_LABEL_KEYS = {
  APP: "app",
  MCP_SERVER_ID: "mcp-server-id",
  MCP_SERVER_NAME: "mcp-server-name",
  CONNECTOR_ID: "connector-id",
  TEAM_ID: "team-id",
} as const;
