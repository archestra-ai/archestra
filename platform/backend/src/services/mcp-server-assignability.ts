/**
 * Whether an MCP server connection may be assigned to an agent or app, and the
 * guard that refuses an owner, scope or team change that would strand a tool
 * pinned to one. It reads models only, so the resource permissions that run
 * the guard can sit below the tool assignment service.
 */
import AgentToolModel from "@/models/agent-tool";
import AppToolModel from "@/models/app-tool";
import MemberModel from "@/models/member";
import TeamModel from "@/models/team";
import {
  type AgentScope,
  ApiError,
  type ResourceVisibilityScope,
  type ToolOwnerContext,
} from "@/types";

export type PrefetchedMcpServer = {
  id: string;
  ownerId: string | null;
  catalogId: string | null;
  teamId?: string | null;
  scope: ResourceVisibilityScope;
  serverType?: "app" | "builtin" | "local" | "remote" | "device";
};

/** Whether one MCP server connection may be assigned to this agent or app. */
export async function isMcpServerAssignableToTarget(params: {
  mcpServer: Pick<
    PrefetchedMcpServer,
    "ownerId" | "serverType" | "teamId" | "scope"
  >;
  target: {
    organizationId: string;
    scope: AgentScope;
    authorId: string | null;
    teamIds: string[];
  };
}): Promise<boolean> {
  const { mcpServer, target } = params;
  if (mcpServer.scope === "personal") {
    return false;
  }

  if (mcpServer.scope === "org") {
    return true;
  }

  if (mcpServer.teamId) {
    if (target.scope === "org") {
      return true;
    }
    if (target.scope === "team") {
      return target.teamIds.includes(mcpServer.teamId);
    }
    if (target.scope === "personal" && target.authorId) {
      if (
        await TeamModel.isUserInAnyTeam([mcpServer.teamId], target.authorId)
      ) {
        return true;
      }
      return isOrgAdmin(target.authorId, target.organizationId);
    }
    return false;
  }

  if (!mcpServer.ownerId) {
    return true;
  }

  if (target.scope === "personal") {
    return target.authorId === mcpServer.ownerId;
  }

  if (target.scope === "org") {
    const ownerMembership = await MemberModel.getByUserId(
      mcpServer.ownerId,
      target.organizationId,
    );
    return ownerMembership != null;
  }

  return TeamModel.isUserInAnyTeam(target.teamIds, mcpServer.ownerId);
}

export async function filterMcpServersAssignableToTarget<
  TMcpServer extends Pick<
    PrefetchedMcpServer,
    "ownerId" | "serverType" | "teamId" | "scope"
  >,
>(params: {
  mcpServers: TMcpServer[];
  target: {
    organizationId: string;
    scope: AgentScope;
    authorId: string | null;
    teamIds: string[];
  };
}): Promise<TMcpServer[]> {
  const { target } = params;
  // Personal connections always resolve from the caller at runtime. They are
  // never valid static choices, including for their owner or an Admin.
  const mcpServers = params.mcpServers.filter(
    (mcpServer) => mcpServer.scope !== "personal",
  );
  if (mcpServers.length === 0) {
    return [];
  }

  const ownerIds = [
    ...new Set(
      mcpServers
        .map((server) => server.ownerId)
        .filter((ownerId): ownerId is string => ownerId != null),
    ),
  ];
  const teamServerTeamIds = [
    ...new Set(
      mcpServers
        .map((server) => server.teamId)
        .filter((teamId): teamId is string => teamId != null),
    ),
  ];

  const [orgMemberOwnerIds, targetTeamMemberOwnerIds, authorTeamIds] =
    await Promise.all([
      target.scope === "org"
        ? MemberModel.findUserIdsInOrganization({
            organizationId: target.organizationId,
            userIds: ownerIds,
          })
        : Promise.resolve([]),
      target.scope === "team"
        ? TeamModel.findUserIdsInAnyTeam({
            teamIds: target.teamIds,
            userIds: ownerIds,
          })
        : Promise.resolve([]),
      target.scope === "personal" &&
      target.authorId &&
      teamServerTeamIds.length > 0
        ? TeamModel.getUserTeamIds(target.authorId)
        : Promise.resolve([]),
    ]);

  const orgMemberOwnerIdSet = new Set(orgMemberOwnerIds);
  const targetTeamMemberOwnerIdSet = new Set(targetTeamMemberOwnerIds);
  const authorTeamIdSet = new Set(authorTeamIds);
  const needsOrgAdminCheck =
    target.scope === "personal" &&
    !!target.authorId &&
    teamServerTeamIds.some((teamId) => !authorTeamIdSet.has(teamId));
  const authorIsOrgAdmin =
    needsOrgAdminCheck && target.authorId
      ? await isOrgAdmin(target.authorId, target.organizationId)
      : false;

  return mcpServers.filter((mcpServer) =>
    isMcpServerAssignableToPrefetchedTarget({
      mcpServer,
      target,
      orgMemberOwnerIdSet,
      targetTeamMemberOwnerIdSet,
      authorTeamIdSet,
      authorIsOrgAdmin,
    }),
  );
}

/**
 * Guard for the surfaces that change an agent owner, scope, or teams (the REST
 * update route and the MCP edit tools): refuses the change while a static pin
 * still points at a connection the agent would lose. One implementation, so
 * both surfaces reject the same requests with the same wording. A change that
 * moves neither ownership, scope, nor teams reads nothing.
 */
export async function assertNoStaticPinsBrokenByTargetChange(
  params: {
    currentTarget: ToolOwnerContext;
    nextTarget: ToolOwnerContext;
  } & ({ agentId: string; appId?: never } | { appId: string; agentId?: never }),
): Promise<void> {
  const { currentTarget, nextTarget } = params;
  const teamsChanged =
    nextTarget.teamIds.length !== currentTarget.teamIds.length ||
    nextTarget.teamIds.some(
      (teamId) => !currentTarget.teamIds.includes(teamId),
    );
  if (
    currentTarget.scope === nextTarget.scope &&
    currentTarget.authorId === nextTarget.authorId &&
    !teamsChanged
  ) {
    return;
  }

  const brokenPins = await findStaticPinsBrokenByTargetChange(params);
  if (brokenPins.length === 0) {
    return;
  }

  const toolNames = [...new Set(brokenPins.map((pin) => pin.toolName))]
    .sort()
    .join(", ");
  const connections = [
    ...new Set(brokenPins.map((pin) => pin.mcpServerName)),
  ].sort();
  const connectionLabel = connections.length > 1 ? "s" : "";
  const resourceLabel = params.appId !== undefined ? "app" : "agent";
  throw new ApiError(
    400,
    `These tools are pinned to a connection this ${resourceLabel} would lose access to: ${toolNames} (connection${connectionLabel}: ${connections.join(", ")}). Unassign them or switch them to dynamic credentials before changing the ${resourceLabel}'s owner, teams, or scope.`,
  );
}

// ===== Internal helpers =====

async function isOrgAdmin(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const membership = await MemberModel.getByUserId(userId, organizationId);
  return membership?.role === "admin";
}

/**
 * Static pins a scope/team change would break: assignments bound to one
 * connection that is assignable to the agent as it stands today, but would not
 * be once it has `nextTarget`'s scope and teams. Assignment-time validation
 * only ever sees the assignment being written, so this reads the same rule
 * from the other end — the connection set moving out from under pins that
 * already exist. Nothing is duplicated: both ends run
 * {@link isMcpServerAssignableToTarget}'s logic.
 *
 * Pins that are already unassignable today are deliberately not reported. They
 * are pre-existing drift the change does not cause, and blocking on them would
 * make the agent's teams uneditable rather than repair anything.
 */
async function findStaticPinsBrokenByTargetChange(
  params: {
    currentTarget: ToolOwnerContext;
    nextTarget: ToolOwnerContext;
  } & ({ agentId: string; appId?: never } | { appId: string; agentId?: never }),
): Promise<{ toolName: string; mcpServerName: string }[]> {
  const pins =
    params.appId !== undefined
      ? await AppToolModel.findStaticPinnedAssignmentsByApp(params.appId)
      : await AgentToolModel.findStaticPinnedAssignmentsByAgent(params.agentId);
  if (pins.length === 0) {
    return [];
  }

  const mcpServers = [
    ...new Map(pins.map((pin) => [pin.mcpServer.id, pin.mcpServer])).values(),
  ];
  const [assignableNow, assignableNext] = await Promise.all([
    filterMcpServersAssignableToTarget({
      mcpServers,
      target: params.currentTarget,
    }),
    filterMcpServersAssignableToTarget({
      mcpServers,
      target: params.nextTarget,
    }),
  ]);
  const assignableNowIds = new Set(assignableNow.map((server) => server.id));
  const assignableNextIds = new Set(assignableNext.map((server) => server.id));

  return pins
    .filter(
      (pin) =>
        assignableNowIds.has(pin.mcpServer.id) &&
        !assignableNextIds.has(pin.mcpServer.id),
    )
    .map((pin) => ({
      toolName: pin.toolName,
      mcpServerName: pin.mcpServer.name,
    }));
}

function isMcpServerAssignableToPrefetchedTarget(params: {
  mcpServer: Pick<PrefetchedMcpServer, "ownerId" | "teamId" | "scope">;
  target: {
    scope: AgentScope;
    authorId: string | null;
    teamIds: string[];
  };
  orgMemberOwnerIdSet: Set<string>;
  targetTeamMemberOwnerIdSet: Set<string>;
  authorTeamIdSet: Set<string>;
  authorIsOrgAdmin: boolean;
}): boolean {
  const {
    authorIsOrgAdmin,
    authorTeamIdSet,
    mcpServer,
    orgMemberOwnerIdSet,
    target,
    targetTeamMemberOwnerIdSet,
  } = params;

  if (mcpServer.scope === "personal") {
    return false;
  }

  if (mcpServer.scope === "org") {
    return true;
  }

  if (mcpServer.teamId) {
    if (target.scope === "org") {
      return true;
    }
    if (target.scope === "team") {
      return target.teamIds.includes(mcpServer.teamId);
    }
    if (target.scope === "personal" && target.authorId) {
      return authorTeamIdSet.has(mcpServer.teamId) || authorIsOrgAdmin;
    }
    return false;
  }

  if (!mcpServer.ownerId) {
    return true;
  }

  if (target.scope === "personal") {
    return target.authorId === mcpServer.ownerId;
  }

  if (target.scope === "org") {
    return orgMemberOwnerIdSet.has(mcpServer.ownerId);
  }

  return targetTeamMemberOwnerIdSet.has(mcpServer.ownerId);
}
