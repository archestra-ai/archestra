import type { Action, Resource } from "@shared";
import type { AgentType } from "@/types";
import { ApiError } from "@/types";
import { userHasPermission } from "./utils";

/**
 * Maps an agent's `agentType` to the corresponding RBAC resource.
 *
 * - "agent" → "agent"
 * - "mcp_gateway" → "mcpGateway"
 * - "llm_proxy" → "llmProxy"
 * - "profile" → "agent" (legacy profiles use the "agent" resource)
 */
export function getResourceForAgentType(agentType: AgentType): Resource {
  switch (agentType) {
    case "mcp_gateway":
      return "mcpGateway";
    case "llm_proxy":
      return "llmProxy";
    case "agent":
    case "profile":
      return "agent";
  }
}

/**
 * Checks that the user has the given action on the resource corresponding to `agentType`.
 * Throws ApiError(403) if not.
 */
export async function requireAgentTypePermission(params: {
  userId: string;
  organizationId: string;
  agentType: AgentType;
  action: Action;
}): Promise<void> {
  const resource = getResourceForAgentType(params.agentType);
  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    resource,
    params.action,
  );
  if (!allowed) {
    throw new ApiError(403, "Forbidden");
  }
}

/**
 * Returns true if the user has "admin" on the resource for the given agentType.
 */
export async function isAgentTypeAdmin(params: {
  userId: string;
  organizationId: string;
  agentType: AgentType;
}): Promise<boolean> {
  const resource = getResourceForAgentType(params.agentType);
  return userHasPermission(
    params.userId,
    params.organizationId,
    resource,
    "admin",
  );
}

/**
 * Returns true if the user has read permission on ANY of the three agent-type resources.
 * Used when no agentType filter is provided on list endpoints.
 */
export async function hasAnyAgentTypeReadPermission(params: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  return hasAnyAgentTypePermission({ ...params, action: "read" });
}

/**
 * Returns true if the user has admin permission on ANY of the three agent-type resources.
 * Used when no agentType filter is provided on list endpoints to determine
 * whether to bypass team-based access filtering.
 */
export async function hasAnyAgentTypeAdminPermission(params: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  return hasAnyAgentTypePermission({ ...params, action: "admin" });
}

// ===== Internal helpers =====

async function hasAnyAgentTypePermission(params: {
  userId: string;
  organizationId: string;
  action: Action;
}): Promise<boolean> {
  const resources: Resource[] = ["agent", "mcpGateway", "llmProxy"];
  for (const resource of resources) {
    const allowed = await userHasPermission(
      params.userId,
      params.organizationId,
      resource,
      params.action,
    );
    if (allowed) return true;
  }
  return false;
}
