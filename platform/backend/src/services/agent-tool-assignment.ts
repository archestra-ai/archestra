import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import {
  AgentModel,
  AgentToolModel,
  AppAccessModel,
  AppModel,
  AppToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  MemberModel,
  TeamModel,
  ToolModel,
} from "@/models";
import { resolveAppAssignableToolRows } from "@/services/apps/app-assignable-tools";
import type {
  AgentScope,
  CredentialResolutionMode,
  InternalMcpCatalog,
  ResourceVisibilityScope,
  Tool,
  ToolOwnerContext,
} from "@/types";

export type ToolAssignmentError = {
  code: "not_found" | "validation_error";
  error: { message: string; type: string };
};

export type PrefetchedMcpServer = {
  id: string;
  ownerId: string | null;
  catalogId: string | null;
  teamId?: string | null;
  scope: ResourceVisibilityScope;
};

type AgentToolAssignmentPrefetchedData = {
  existingAgentIds: Set<string>;
  toolsMap: Map<string, Tool>;
  catalogItemsMap: ReadonlyMap<string, InternalMcpCatalog>;
  mcpServersBasicMap: Map<string, PrefetchedMcpServer>;
};

interface AgentToolAssignmentRequest {
  /** Agent receiving the tool assignment. */
  agentId: string;
  /** Exact tool ID to assign. */
  toolId: string;
  /**
   * Preferred late-bound assignment mode.
   * When true, resolve credentials and execution target at tool call time.
   */
  resolveAtCallTime?: boolean;
  credentialResolutionMode?: CredentialResolutionMode;
  /** Static assignments pin the tool to one installed MCP server. */
  mcpServerId?: string | null;
  /** Optional prefetched lookup data used to avoid N+1 validation queries. */
  preFetchedData?: Partial<AgentToolAssignmentPrefetchedData>;
}

export async function assignToolToAgent(
  params: AgentToolAssignmentRequest,
): Promise<ToolAssignmentError | "duplicate" | "updated" | null> {
  const credentialResolutionMode = normalizeCredentialResolutionMode(params);
  const validationError = await validateAssignment({
    agentId: params.agentId,
    toolId: params.toolId,
    resolveAtCallTime: credentialResolutionMode === "dynamic",
    credentialResolutionMode,
    mcpServerId: params.mcpServerId,
    preFetchedData: params.preFetchedData,
  });

  if (validationError) {
    return validationError;
  }

  const result = await AgentToolModel.createOrUpdateCredentials(
    params.agentId,
    params.toolId,
    params.mcpServerId,
    credentialResolutionMode,
  );

  if (result.status === "unchanged") {
    return "duplicate";
  }

  if (result.status === "updated") {
    return "updated";
  }

  return null;
}

export async function validateAssignment(
  params: AgentToolAssignmentRequest,
): Promise<ToolAssignmentError | null> {
  const { agentId, toolId, preFetchedData } = params;
  const mcpServerId = params.mcpServerId;
  const credentialResolutionMode = normalizeCredentialResolutionMode(params);

  const agentExists = preFetchedData?.existingAgentIds
    ? preFetchedData.existingAgentIds.has(agentId)
    : await AgentModel.exists(agentId);

  if (!agentExists) {
    return {
      code: "not_found",
      error: {
        message: `Agent with ID ${agentId} not found`,
        type: "not_found",
      },
    };
  }

  const tool = preFetchedData?.toolsMap
    ? preFetchedData.toolsMap.get(toolId) || null
    : await ToolModel.findById(toolId);

  if (!tool) {
    return {
      code: "not_found",
      error: {
        message: `Tool with ID ${toolId} not found`,
        type: "not_found",
      },
    };
  }

  if (tool.clonedPendingDiscovery) {
    return {
      code: "validation_error",
      error: {
        message:
          "Tool is not available for assignment until its server is installed.",
        type: "validation_error",
      },
    };
  }

  const catalogValidationError = await validateCatalogRequirements({
    tool,
    mcpServerId,
    preFetchedData,
    credentialResolutionMode,
  });
  if (catalogValidationError) {
    return catalogValidationError;
  }

  if (mcpServerId) {
    const preFetchedServer =
      preFetchedData?.mcpServersBasicMap?.get(mcpServerId);
    const validationError = await validateAssignedMcpServer({
      getOwnerContext: () => getAssignmentTargetContext(agentId),
      mcpServerId,
      tool,
      preFetchedServer,
    });
    if (validationError) {
      return validationError;
    }
  }

  return null;
}

/**
 * Resolve a declarative tool-name list (the `tools` param of `scaffold_app` /
 * `set_app_tools`) to assignable tool rows — clean or fail, never a silent
 * partial set. Names resolve through {@link resolveAppAssignableToolRows}, the
 * shared surface `search_tools` and the app runtime resolve against, so a
 * duplicate name (unique only per catalog) collapses to the SAME canonical row
 * the model saw and the app will execute — never an ambiguity error the caller
 * cannot disambiguate. Built-ins are rejected and an unknown name errors with
 * the offenders listed. The resulting assignments use dynamic credential
 * resolution: the server (and so the credential) is picked per viewing user at
 * call time, which both makes the assignment valid without an explicit
 * mcpServerId and gives shared apps per-viewer auth.
 */
export async function resolveAppToolsByName(params: {
  agentId: string;
  userId: string;
  organizationId: string;
  toolNames: readonly string[];
  /** Environment to resolve tools within (the app's bound environment; the org
   * default for scaffold_app, where env selection is deferred). */
  environmentId: string | null;
}): Promise<
  { tools: Array<{ id: string; name: string }> } | ToolAssignmentError
> {
  const requested = [...new Set(params.toolNames)];

  const builtIns = requested.filter((name) =>
    archestraMcpBranding.isToolName(name),
  );
  if (builtIns.length > 0) {
    return appToolsValidationError(
      `Built-in tools cannot be assigned to apps (app HTML reaches the data store via archestra.storage automatically): ${builtIns.join(", ")}`,
    );
  }

  const byName = await resolveAppAssignableToolRows({
    agentId: params.agentId,
    userId: params.userId,
    organizationId: params.organizationId,
    environmentId: params.environmentId,
  });

  const unknown = requested.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    return appToolsValidationError(
      `Unknown tool name(s) for this organization: ${unknown.join(", ")}. Use search_tools to discover available tools.`,
    );
  }

  return {
    tools: requested.map((name) => {
      // biome-ignore lint/style/noNonNullAssertion: unknown names errored above
      const row = byName.get(name)!;
      return { id: row.id, name: row.name };
    }),
  };
}

/**
 * Replace an app's tool assignments with the resolved set, atomically (a
 * failure cannot leave a partial set). See {@link resolveAppToolsByName} for
 * why assignments are dynamic-mode.
 */
export async function replaceAppToolAssignments(
  appId: string,
  tools: ReadonlyArray<{ id: string }>,
): Promise<void> {
  await AppToolModel.replaceAssignments(
    appId,
    tools.map((tool) => ({
      toolId: tool.id,
      mcpServerId: null,
      credentialResolutionMode: "dynamic",
    })),
  );
}

function appToolsValidationError(message: string): ToolAssignmentError {
  return {
    code: "validation_error",
    error: { message, type: "validation_error" },
  };
}

/**
 * Assign an upstream tool to an *app*, mirroring `assignToolToAgent`. Reuses the
 * same catalog/server validation and scope-alignment rules with the app's owner
 * context, so a personal app cannot be handed a team- or owner-scoped server it
 * has no claim to.
 */
export async function assignToolToApp(params: {
  appId: string;
  organizationId: string;
  toolId: string;
  mcpServerId?: string | null;
  credentialResolutionMode?: CredentialResolutionMode;
}): Promise<ToolAssignmentError | "duplicate" | "updated" | null> {
  const credentialResolutionMode = normalizeCredentialResolutionMode(params);

  const app = await AppModel.findByIdInOrg(params.appId, params.organizationId);
  if (!app) {
    return {
      code: "not_found",
      error: {
        message: `App with ID ${params.appId} not found`,
        type: "not_found",
      },
    };
  }

  // Org-scoped: a tool from another organization is indistinguishable from a
  // nonexistent one, so this raw-id endpoint cannot attach or probe foreign tools.
  const tool = await ToolModel.findAppAssignableToolById(
    params.organizationId,
    params.toolId,
  );
  if (!tool) {
    return {
      code: "not_found",
      error: {
        message: `Tool with ID ${params.toolId} not found`,
        type: "not_found",
      },
    };
  }

  // Environment fence: a tool whose catalog is outside the app's bound
  // environment is not assignable. This is a same-org, wrong-environment tool —
  // distinct from the foreign-org not_found above — so it gets a clear 400.
  const inEnvironment = await ToolModel.isToolInEnvironment(
    params.toolId,
    app.environmentId,
  );
  if (!inEnvironment) {
    return {
      code: "validation_error",
      error: {
        message:
          "Tool is not available in the app's environment and cannot be assigned.",
        type: "validation_error",
      },
    };
  }

  if (tool.clonedPendingDiscovery) {
    return {
      code: "validation_error",
      error: {
        message:
          "Tool is not available for assignment until its server is installed.",
        type: "validation_error",
      },
    };
  }

  const catalogValidationError = await validateCatalogRequirements({
    tool,
    mcpServerId: params.mcpServerId,
    credentialResolutionMode,
  });
  if (catalogValidationError) {
    return catalogValidationError;
  }

  if (params.mcpServerId) {
    // Same org-scoping for the server: resolve within the org first so a
    // foreign-org server (even one sharing a global catalog with the tool) is
    // rejected as not_found before reaching the scope-assignability check.
    const mcpServer = await McpServerModel.findByIdInOrg(
      params.mcpServerId,
      params.organizationId,
    );
    if (!mcpServer) {
      return {
        code: "not_found",
        error: {
          message: `MCP server with ID ${params.mcpServerId} not found`,
          type: "not_found",
        },
      };
    }
    const validationError = await validateAssignedMcpServer({
      getOwnerContext: () => getAppAssignmentTargetContext(params.appId),
      mcpServerId: params.mcpServerId,
      tool,
      preFetchedServer: mcpServer,
    });
    if (validationError) {
      return validationError;
    }
  }

  const result = await AppToolModel.createOrUpdateCredentials(
    params.appId,
    params.toolId,
    params.mcpServerId,
    credentialResolutionMode,
  );

  if (result.status === "unchanged") {
    return "duplicate";
  }
  if (result.status === "updated") {
    return "updated";
  }
  return null;
}

async function validateCatalogRequirements(params: {
  tool: Tool;
  mcpServerId?: string | null;
  preFetchedData?: Partial<AgentToolAssignmentPrefetchedData>;
  credentialResolutionMode: CredentialResolutionMode;
}): Promise<ToolAssignmentError | null> {
  const { tool, mcpServerId, preFetchedData, credentialResolutionMode } =
    params;
  const usesLateBoundResolution =
    credentialResolutionMode === "dynamic" ||
    credentialResolutionMode === "enterprise_managed";

  if (!tool.catalogId) {
    return null;
  }

  const catalogItem = preFetchedData?.catalogItemsMap
    ? preFetchedData.catalogItemsMap.get(tool.catalogId) || null
    : await InternalMcpCatalogModel.findById(tool.catalogId, {
        expandSecrets: false,
      });

  if (catalogItem?.serverType === "local") {
    if (!mcpServerId && !usesLateBoundResolution) {
      return {
        code: "validation_error",
        error: {
          message:
            "An MCP server installation or non-static credential resolution is required for local MCP server tools",
          type: "validation_error",
        },
      };
    }
  }

  if (catalogItem?.serverType === "remote") {
    if (!mcpServerId && !usesLateBoundResolution) {
      return {
        code: "validation_error",
        error: {
          message:
            "An MCP server installation or non-static credential resolution is required for remote MCP server tools",
          type: "validation_error",
        },
      };
    }
  }

  return null;
}

function normalizeCredentialResolutionMode(params: {
  resolveAtCallTime?: boolean;
  credentialResolutionMode?: CredentialResolutionMode;
}) {
  if (params.credentialResolutionMode) {
    return params.credentialResolutionMode;
  }

  return (params.resolveAtCallTime ?? false) ? "dynamic" : "static";
}

async function validateAssignedMcpServer(params: {
  getOwnerContext: () => Promise<ToolOwnerContext>;
  mcpServerId: string;
  tool: Tool;
  preFetchedServer?: Pick<
    PrefetchedMcpServer,
    "id" | "ownerId" | "catalogId" | "teamId" | "scope"
  > | null;
}): Promise<ToolAssignmentError | null> {
  const { getOwnerContext, mcpServerId, tool, preFetchedServer } = params;

  const mcpServer =
    preFetchedServer !== undefined
      ? preFetchedServer
      : await McpServerModel.findById(mcpServerId);

  if (!mcpServer) {
    return {
      code: "not_found",
      error: {
        message: `MCP server with ID ${mcpServerId} not found`,
        type: "not_found",
      },
    };
  }

  if (tool.catalogId && mcpServer.catalogId !== tool.catalogId) {
    return {
      code: "validation_error",
      error: {
        message:
          "Assigned MCP server must come from the same catalog item as the tool",
        type: "validation_error",
      },
    };
  }

  const isAllowed = await isMcpServerAssignableToTarget({
    mcpServer,
    target: await getOwnerContext(),
  });

  if (!isAllowed) {
    return {
      code: "validation_error",
      error: {
        message: getAssignmentValidationMessage(mcpServer),
        type: "validation_error",
      },
    };
  }

  return null;
}

async function getAssignmentTargetContext(
  agentId: string,
): Promise<ToolOwnerContext> {
  const agent = await AgentModel.findById(agentId, undefined, true);

  if (!agent) {
    throw new Error(`Agent with ID ${agentId} not found`);
  }

  return {
    organizationId: agent.organizationId,
    scope: agent.scope,
    authorId: agent.authorId,
    teamIds: agent.teams.map((team) => team.id),
  };
}

async function getAppAssignmentTargetContext(
  appId: string,
): Promise<ToolOwnerContext> {
  const app = await AppModel.findById(appId);

  if (!app) {
    throw new Error(`App with ID ${appId} not found`);
  }

  const teamIds = await AppAccessModel.getTeamsForApp(appId);

  return {
    organizationId: app.organizationId,
    scope: app.scope,
    authorId: app.authorId,
    teamIds,
  };
}

async function isOrgAdmin(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const membership = await MemberModel.getByUserId(userId, organizationId);
  return membership?.role === "admin";
}

/** @public — exported for testability */
export async function isMcpServerAssignableToTarget(params: {
  mcpServer: Pick<PrefetchedMcpServer, "ownerId" | "teamId" | "scope">;
  target: {
    organizationId: string;
    scope: AgentScope;
    authorId: string | null;
    teamIds: string[];
  };
}): Promise<boolean> {
  const { mcpServer, target } = params;

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
  TMcpServer extends Pick<PrefetchedMcpServer, "ownerId" | "teamId" | "scope">,
>(params: {
  mcpServers: TMcpServer[];
  target: {
    organizationId: string;
    scope: AgentScope;
    authorId: string | null;
    teamIds: string[];
  };
}): Promise<TMcpServer[]> {
  const { mcpServers, target } = params;
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

function getAssignmentValidationMessage(
  mcpServer: Pick<PrefetchedMcpServer, "teamId">,
) {
  if (mcpServer.teamId) {
    return "This team connection is not shared with the selected team";
  }

  return "The credential owner must be a member of a team that this resource is assigned to";
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
