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
import { TeamModel } from "@/models";
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

/**
 * Resource-agnostic 3-tier scope authorization, shared by agents and skills.
 *
 * - `isAdmin` → always allowed
 * - `scope=org` → requires admin
 * - `scope=team` → requires team-admin + membership in one of the resource's teams
 * - `scope=personal` → requires authorship
 *
 * `resourceLabel` is the singular noun used in error messages (e.g. "agent",
 * "skill"). Throws ApiError(403) if the user lacks permission.
 */
export function requireScopedModifyPermission(params: {
  isAdmin: boolean;
  isTeamAdmin: boolean;
  scope: AgentScope;
  authorId: string | null;
  resourceTeamIds: string[];
  userTeamIds: string[];
  userId: string;
  resourceLabel: string;
}): void {
  const { resourceLabel } = params;

  // Admins bypass all checks
  if (params.isAdmin) {
    return;
  }

  switch (params.scope) {
    case "org":
      throw new ApiError(
        403,
        `Only admins can manage org-scoped ${resourceLabel}s`,
      );

    case "team": {
      if (!params.isTeamAdmin) {
        throw new ApiError(
          403,
          `You need team-admin permission to manage team-scoped ${resourceLabel}s`,
        );
      }
      const userTeamIdSet = new Set(params.userTeamIds);
      const isMemberOfAnyTeam = params.resourceTeamIds.some((id) =>
        userTeamIdSet.has(id),
      );
      if (params.resourceTeamIds.length === 0 || !isMemberOfAnyTeam) {
        throw new ApiError(
          403,
          `You can only manage ${resourceLabel}s in teams you are a member of`,
        );
      }
      return;
    }

    case "personal":
      if (params.authorId !== params.userId) {
        throw new ApiError(
          403,
          `You can only manage your own personal ${resourceLabel}s`,
        );
      }
      return;

    // Fail closed: an out-of-union scope (data corruption, manual write, or a
    // future scope shipped before this code is updated) must be denied, not
    // fall through and implicitly grant.
    default:
      throw new ApiError(403, `Unknown ${resourceLabel} scope`);
  }
}

/**
 * Validate an agent's team assignments before persisting. A `team`-scoped agent
 * must have at least one team (otherwise it matches no team membership and is
 * invisible to everyone, including its author), and every assigned team must
 * exist within the caller's organization — a stale, bogus, or foreign-org id
 * fails with a clean 400 instead of an FK violation mid-write.
 *
 * Existence is checked for any non-empty assignment rather than only at `team`
 * scope: `agent_team` rows are written whenever teams are supplied, and the
 * foreign key points at the global `team` table, so an id belonging to another
 * organization would otherwise persist unnoticed. Mirrors
 * {@link assertMcpCatalogTeams} and its skill equivalent.
 */
export async function assertAgentTeams(params: {
  scope: AgentScope;
  teamIds: string[];
  organizationId: string;
}): Promise<void> {
  if (params.scope === "team" && params.teamIds.length === 0) {
    throw new ApiError(
      400,
      "A team-scoped agent must be assigned at least one team",
    );
  }
  if (params.teamIds.length === 0) return;

  const teams = await TeamModel.findByIds(params.teamIds);
  const validIds = new Set(
    teams
      .filter((team) => team.organizationId === params.organizationId)
      .map((team) => team.id),
  );
  const missing = params.teamIds.filter((id) => !validIds.has(id));
  if (missing.length > 0) {
    throw new ApiError(400, `Unknown team id(s): ${missing.join(", ")}`);
  }
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
