import {
  type Action,
  type AgentType,
  getResourceForAgentType,
  type Resource,
} from "@shared";
import { UserModel } from "@/models";
import { ApiError } from "@/types";
import { userHasPermission } from "./utils";

export { getResourceForAgentType };

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

/**
 * Fetches permissions once and returns check functions for agent-type resources.
 * Use this to avoid N+1 DB queries when multiple permission checks are needed
 * in a single request handler.
 */
export async function getAgentTypePermissionChecker(params: {
  userId: string;
  organizationId: string;
}): Promise<AgentTypePermissionChecker> {
  const permissions = await UserModel.getUserPermissions(
    params.userId,
    params.organizationId,
  );
  return {
    require(agentType: AgentType, action: Action): void {
      const resource = getResourceForAgentType(agentType);
      if (!(permissions[resource]?.includes(action) ?? false)) {
        throw new ApiError(403, "Forbidden");
      }
    },
    isAdmin(agentType: AgentType): boolean {
      const resource = getResourceForAgentType(agentType);
      return permissions[resource]?.includes("admin") ?? false;
    },
    hasAnyReadPermission(): boolean {
      return AGENT_TYPE_RESOURCES.some(
        (r) => permissions[r]?.includes("read") ?? false,
      );
    },
    hasAnyAdminPermission(): boolean {
      return AGENT_TYPE_RESOURCES.some(
        (r) => permissions[r]?.includes("admin") ?? false,
      );
    },
  };
}

// ===== Types =====

export interface AgentTypePermissionChecker {
  /** Throws ApiError(403) if the user lacks the action on the agent type's resource. */
  require(agentType: AgentType, action: Action): void;
  /** Returns true if the user has admin on the agent type's resource. */
  isAdmin(agentType: AgentType): boolean;
  /** Returns true if the user has read on any of the three agent-type resources. */
  hasAnyReadPermission(): boolean;
  /** Returns true if the user has admin on any of the three agent-type resources. */
  hasAnyAdminPermission(): boolean;
}

// ===== Internal helpers =====

const AGENT_TYPE_RESOURCES: Resource[] = ["agent", "mcpGateway", "llmProxy"];

async function hasAnyAgentTypePermission(params: {
  userId: string;
  organizationId: string;
  action: Action;
}): Promise<boolean> {
  const permissions = await UserModel.getUserPermissions(
    params.userId,
    params.organizationId,
  );
  return AGENT_TYPE_RESOURCES.some(
    (r) => permissions[r]?.includes(params.action) ?? false,
  );
}
