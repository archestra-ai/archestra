import {
  type Action,
  getResourceForAgentType,
  type Resource,
} from "@archestra/shared";
import { buildForbiddenErrorMessage } from "@archestra/shared/access-control";
import { TeamModel } from "@/models";
import {
  type AgentScope,
  type AgentType,
  AgentTypeSchema,
  ApiError,
} from "@/types";
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
  const permissions = await getPermissionsForUserContext(params);
  return {
    require(agentType: AgentType, action: Action): void {
      const resource = getResourceForAgentType(agentType);
      if (!(permissions[resource]?.includes(action) ?? false)) {
        throw new ApiError(
          403,
          buildForbiddenErrorMessage({
            missingPermissions: { [resource]: [action] },
          }),
        );
      }
    },
    isAdmin(agentType: AgentType): boolean {
      const resource = getResourceForAgentType(agentType);
      return permissions[resource]?.includes("admin") ?? false;
    },
    isTeamAdmin(agentType: AgentType): boolean {
      const resource = getResourceForAgentType(agentType);
      return permissions[resource]?.includes("team-admin") ?? false;
    },
    hasAnyReadPermission(): boolean {
      return AGENT_TYPE_RESOURCES.some(
        (r) => permissions[r]?.includes("read") ?? false,
      );
    },
    getAgentTypesWithPermission(action: Action): AgentType[] {
      return AgentTypeSchema.options.filter((agentType) => {
        const resource = getResourceForAgentType(agentType);
        return permissions[resource]?.includes(action) ?? false;
      });
    },
    hasAnyAdminPermission(): boolean {
      return AGENT_TYPE_RESOURCES.some(
        (r) => permissions[r]?.includes("admin") ?? false,
      );
    },
  };
}

/**
 * Enforces 3-tier scope-based authorization for agent modifications (create/update/delete).
 *
 * - Admin (`agent:admin`) → always allowed
 * - `scope=org` → requires `admin`
 * - `scope=team` → requires `team-admin` + membership in at least one of the agent's teams
 * - `scope=personal` → requires authorship (authorId === userId)
 *
 * Throws ApiError(403) if the user lacks permission.
 */
export function requireAgentModifyPermission(params: {
  checker: AgentTypePermissionChecker;
  agentType: AgentType;
  agentScope: AgentScope;
  agentAuthorId: string | null;
  agentTeamIds: string[];
  userTeamIds: string[];
  userId: string;
}): void {
  requireScopedModifyPermission({
    isAdmin: params.checker.isAdmin(params.agentType),
    isTeamAdmin: params.checker.isTeamAdmin(params.agentType),
    scope: params.agentScope,
    authorId: params.agentAuthorId,
    resourceTeamIds: params.agentTeamIds,
    userTeamIds: params.userTeamIds,
    userId: params.userId,
    resourceLabel: "agent",
  });
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

/**
 * Enforce that a non-admin only assigns teams they belong to. Admins may assign
 * any team in the organization, which is how an agent is set up on a team's
 * behalf.
 *
 * Teams already on the agent are exempt: a team-admin editing an agent that is
 * also shared with teams they don't belong to can still save unrelated changes,
 * and echoing the current assignment back is never rejected. Only newly added
 * teams are checked.
 */
export function assertAssignableAgentTeams(params: {
  checker: AgentTypePermissionChecker;
  agentType: AgentType;
  requestedTeamIds: string[];
  existingTeamIds: string[];
  userTeamIds: string[];
}): void {
  if (params.checker.isAdmin(params.agentType)) return;

  const existingTeamIdSet = new Set(params.existingTeamIds);
  const userTeamIdSet = new Set(params.userTeamIds);
  const invalidAdds = params.requestedTeamIds.filter(
    (id) => !existingTeamIdSet.has(id) && !userTeamIdSet.has(id),
  );
  if (invalidAdds.length > 0) {
    throw new ApiError(403, "You can only assign teams you are a member of");
  }
}

// ===== Types =====

/** @public — exported for testability */
export interface AgentTypePermissionChecker {
  /** Throws ApiError(403) if the user lacks the action on the agent type's resource. */
  require(agentType: AgentType, action: Action): void;
  /** Returns true if the user has admin on the agent type's resource. */
  isAdmin(agentType: AgentType): boolean;
  /** Returns true if the user has team-admin on the agent type's resource. */
  isTeamAdmin(agentType: AgentType): boolean;
  /** Returns true if the user has read on any of the three agent-type resources. */
  hasAnyReadPermission(): boolean;
  /** Returns agent types for which the user has the requested permission. */
  getAgentTypesWithPermission(action: Action): AgentType[];
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
  const permissions = await getPermissionsForUserContext(params);
  return AGENT_TYPE_RESOURCES.some(
    (r) => permissions[r]?.includes(params.action) ?? false,
  );
}
