/**
 * Available resources
 */
export type Resource =
  | "agent"
  | "tool"
  | "policy"
  | "interaction"
  | "dualLlmConfig"
  | "dualLlmResult"
  | "settings"
  | "member"
  | "organisation"
  | "invitation";

/**
 * Available actions
 */
export type Action = "create" | "read" | "update" | "delete";

/**
 * Permission string format: "resource:action"
 * Examples: "agent:create", "tool:read", "org:delete"
 */
export type Permission = `${Resource}:${Action}`;

/**
 * HTTP methods mapped to permission actions
 */
export const METHOD_TO_ACTION: Record<string, string> = {
  GET: "read",
  HEAD: "read",
  OPTIONS: "read",
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
};

/**
 * Extract resource from URL path
 * Examples:
 * /agents -> agent
 * /agents/123 -> agent
 * /tools/abc -> tool
 */
export const getResourceFromPath = (path: string): string | null => {
  // Remove leading slash and query params
  const cleanPath = path.split("?")[0].replace(/^\//, "");

  // Get first segment
  const resource = cleanPath.split("/")[0];

  // Map plural to singular (agents -> agent)
  const resourceMap: Record<string, string> = {
    agents: "agent",
    tools: "tool",
    "autonomy-policies": "policy",
    interactions: "interaction",
    "dual-llm-config": "dualLlmConfig",
    "dual-llm-results": "dualLlmResult",
    settings: "settings",
    organizations: "organization",
    members: "member",
    invitations: "invitation",
  };

  return resourceMap[resource] || null;
};
