import type { Resource } from "./permission.types";

/**
 * Resource kinds whose *new* items can be pointed at a specific environment
 * instead of the org's implicit Default one.
 *
 * Limited to resources that carry exactly one environment (a nullable
 * `environment_id` where null means "the Default environment"). `skill` is
 * deliberately absent: a skill's environments are a 0..n *restriction* where an
 * empty set means "available everywhere", so defaulting a new skill into one
 * environment would narrow its reach rather than pick a home for it.
 */
export const ENVIRONMENT_DEFAULTABLE_RESOURCES = [
  "mcpRegistry",
  "app",
  "agent",
  "mcpGateway",
  "knowledgeSource",
] as const satisfies readonly Resource[];

export type EnvironmentDefaultableResource =
  (typeof ENVIRONMENT_DEFAULTABLE_RESOURCES)[number];

/**
 * Labels for the settings UI, in the order resources are listed there. Plural
 * because each row configures where *new items of that kind* land.
 */
export const ENVIRONMENT_DEFAULTABLE_RESOURCE_LABELS = {
  mcpRegistry: "MCP servers",
  app: "MCP Apps",
  agent: "Agents",
  mcpGateway: "MCP gateways",
  knowledgeSource: "Knowledge connectors",
} as const satisfies Record<EnvironmentDefaultableResource, string>;

/**
 * `internal_code` of a refused delete of an environment that deploys into a
 * cluster of its own: its workloads could not be removed from that cluster.
 * The delete can be repeated, or repeated without the cleanup.
 */
export const ENVIRONMENT_CLUSTER_CLEANUP_FAILED_CODE =
  "environment_cluster_cleanup_failed";

/**
 * `internal_code` of a refused delete of an environment that deploys into a
 * cluster of its own: an operation is still deploying into that cluster.
 */
export const ENVIRONMENT_CLUSTER_BUSY_CODE = "environment_cluster_busy";
