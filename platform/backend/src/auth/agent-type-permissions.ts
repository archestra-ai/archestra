// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type Action,
  getResourceForAgentType,
  hasScopedPermission,
  type Resource,
  ResourcePermissionActionSchema,
  ScopedResourceSchema,
} from "@archestra/shared";
import { buildForbiddenErrorMessage } from "@archestra/shared/access-control";
import { ResourcePermissions } from "@/services/resource-permissions";
import { type AgentScope, type AgentType, ApiError } from "@/types";
import { getPermissionsForUserContext, userHasPermission } from "./utils";

/** @public — re-exported for testability */
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
    throw new ApiError(
      403,
      buildForbiddenErrorMessage({
        missingPermissions: { [resource]: [params.action] },
      }),
    );
  }
}

/**
 * Returns true if the user holds `update` on every agent of the given type — a
 * grant at `*` scope. Role actions no longer confer this.
 */
export async function isAgentTypeAdmin(params: {
  userId: string;
  organizationId: string;
  agentType: AgentType;
}): Promise<boolean> {
  const checker = await getAgentTypePermissionChecker(params);
  return checker.isAdmin(params.agentType);
}

/**
 * Returns true if the user has read permission on ANY of the agent-type resources.
 * Used when no agentType filter is provided on list endpoints.
 */
export async function hasAnyAgentTypeReadPermission(params: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  return hasAnyAgentTypePermission({ ...params, action: "read" });
}

/**
 * Returns true if the user holds `update` at `*` scope on ANY of the agent-type
 * resources. Used when no agentType filter is provided on list endpoints to
 * determine whether to bypass per-agent access filtering.
 */
export async function hasAnyAgentTypeAdminPermission(params: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  const checker = await getAgentTypePermissionChecker(params);
  return checker.hasAnyAdminPermission();
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
  const [permissions, grants] = await Promise.all([
    getPermissionsForUserContext(params),
    ResourcePermissions.resolveAll(params),
  ]);
  const allowsScoped = (target: {
    agentType: AgentType;
    agentId: string;
    action: Action | "manage-permissions";
  }) => {
    const resource = ScopedResourceSchema.safeParse(
      getResourceForAgentType(target.agentType),
    );
    const action = ResourcePermissionActionSchema.safeParse(target.action);
    return (
      resource.success &&
      action.success &&
      hasScopedPermission({
        grants,
        required: {
          organizationId: params.organizationId,
          resource: resource.data,
          action: action.data,
          scope: target.agentId,
        },
      })
    );
  };
  return {
    allowsScoped,
    hasBaseAction: (agentType, action) =>
      permissions[getResourceForAgentType(agentType)]?.includes(action) ??
      false,
    require(
      agentType: AgentType,
      requested: Action | { action: Action; scope: string },
    ): void {
      const action =
        typeof requested === "string" ? requested : requested.action;
      const resource = getResourceForAgentType(agentType);
      if (
        !(permissions[resource]?.includes(action) ?? false) &&
        !(
          typeof requested !== "string" &&
          allowsScoped({ agentType, agentId: requested.scope, action })
        )
      ) {
        throw new ApiError(
          403,
          buildForbiddenErrorMessage({
            missingPermissions: { [resource]: [action] },
          }),
        );
      }
    },
    isAdmin(agentType: AgentType): boolean {
      return allowsScoped({ agentType, agentId: "*", action: "update" });
    },
    hasAnyReadPermission(): boolean {
      return AGENT_TYPE_RESOURCES.some(
        (r) =>
          (permissions[r]?.includes("read") ?? false) ||
          grants.some(
            (grant) => grant.resource === r && grant.action === "read",
          ),
      );
    },
    getAgentTypesWithPermission(action: Action): AgentType[] {
      return GENERIC_AGENT_TYPES.filter((agentType) => {
        const resource = getResourceForAgentType(agentType);
        return (
          (permissions[resource]?.includes(action) ?? false) ||
          grants.some(
            (grant) => grant.resource === resource && grant.action === action,
          )
        );
      });
    },
    getAgentTypesWithScopedPermission(action: Action): AgentType[] {
      return GENERIC_AGENT_TYPES.filter((agentType) =>
        grants.some(
          (grant) =>
            grant.resource === getResourceForAgentType(agentType) &&
            grant.action === action,
        ),
      );
    },
    hasAnyAdminPermission(): boolean {
      return AGENT_TYPE_RESOURCES.some((r) =>
        grants.some(
          (grant) =>
            grant.resource === r &&
            grant.action === "update" &&
            grant.scope === "*",
        ),
      );
    },
  };
}

/**
 * Authorizes a modification of one existing agent. The caller must hold the
 * action on that agent through a grant — on the agent itself, or at `*` scope.
 * Role actions (`admin`, `team-admin`) and the agent's legacy scope, teams and
 * author confer nothing: those were converted into grants by the cutover.
 *
 * Throws ApiError(403) if the caller lacks the grant.
 */
export function requireAgentModifyPermission(params: {
  checker: AgentTypePermissionChecker;
  agentType: AgentType;
  agentId: string;
  action: "update" | "delete" | "manage-permissions";
}): void {
  if (
    params.checker.allowsScoped({
      agentType: params.agentType,
      agentId: params.agentId,
      action: params.action,
    })
  )
    return;
  throw new ApiError(
    403,
    params.action === "manage-permissions"
      ? "You do not have permission to manage access to this resource"
      : "You do not have permission to modify this resource",
  );
}

// ===== Types =====

/** @public — exported for testability */
export interface AgentTypePermissionChecker {
  /** Throws ApiError(403) if the user lacks the action on the agent type's resource. */
  require(
    agentType: AgentType,
    action: Action | { action: Action; scope: string },
  ): void;
  /** Returns true if a grant gives the user the action on this agent (or at `*`). */
  allowsScoped(params: {
    agentType: AgentType;
    agentId: string;
    action: Action | "manage-permissions";
  }): boolean;
  hasBaseAction?(agentType: AgentType, action: Action): boolean;
  /** Returns true if the user holds `update` at `*` scope on the agent type's resource. */
  isAdmin(agentType: AgentType): boolean;
  /** Returns true if the user has read on any of the agent-type resources. */
  hasAnyReadPermission(): boolean;
  /** Returns agent types for which the user has the requested permission. */
  getAgentTypesWithPermission(action: Action): AgentType[];
  getAgentTypesWithScopedPermission?(action: Action): AgentType[];
  /** Returns true if the user holds `update` at `*` scope on any agent-type resource. */
  hasAnyAdminPermission(): boolean;
}

// ===== Internal helpers =====

// The LLM Proxy is managed exclusively through its dedicated routes, so the
// generic agent surface only ever deals in these resources.
const AGENT_TYPE_RESOURCES: Resource[] = ["agent", "mcpGateway"];

/**
 * Agent types that flow through the generic agent CRUD routes. `llm_proxy`
 * rows live in the same table but are managed through the dedicated LLM Proxy
 * routes, so they are never enumerated here.
 */
const GENERIC_AGENT_TYPES: AgentType[] = ["profile", "mcp_gateway", "agent"];

async function hasAnyAgentTypePermission(params: {
  userId: string;
  organizationId: string;
  action: Action;
}): Promise<boolean> {
  const permissions = await getPermissionsForUserContext(params);
  return AGENT_TYPE_RESOURCES.some(
    (r) => permissions[r]?.includes(params.action) ?? false,
  );
}
