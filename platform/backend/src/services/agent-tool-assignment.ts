import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  MemberModel,
  TeamModel,
  ToolModel,
} from "@/models";
import type {
  AgentScope,
  CredentialResolutionMode,
  InternalMcpCatalog,
  Tool,
} from "@/types";

export type AgentToolAssignmentError = {
  code: "not_found" | "validation_error";
  error: { message: string; type: string };
};

export type PrefetchedMcpServer = {
  id: string;
  ownerId: string | null;
  catalogId: string | null;
  teamId?: string | null;
};

export type AgentToolAssignmentPrefetchedData = {
  existingAgentIds: Set<string>;
  toolsMap: Map<string, Tool>;
  catalogItemsMap: Map<string, InternalMcpCatalog>;
  mcpServersBasicMap: Map<string, PrefetchedMcpServer>;
};

export interface AgentToolAssignmentRequest {
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
): Promise<AgentToolAssignmentError | "duplicate" | "updated" | null> {
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
): Promise<AgentToolAssignmentError | null> {
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
      agentId,
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

async function validateCatalogRequirements(params: {
  tool: Tool;
  mcpServerId?: string | null;
  preFetchedData?: Partial<AgentToolAssignmentPrefetchedData>;
  credentialResolutionMode: CredentialResolutionMode;
}): Promise<AgentToolAssignmentError | null> {
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

export async function validateCredentialSource(params: {
  agentId: string;
  mcpServerId: string;
  tool?: Tool;
  toolId?: string;
  preFetchedServer?:
    | (Pick<PrefetchedMcpServer, "id" | "catalogId"> &
        Partial<Pick<PrefetchedMcpServer, "ownerId">>)
    | null;
}) {
  const tool =
    params.tool ??
    (params.toolId ? await ToolModel.findById(params.toolId) : null);
  if (!tool) {
    return {
      code: "not_found" as const,
      error: {
        message: `Tool with ID ${params.toolId} not found`,
        type: "not_found",
      },
    };
  }

  const result = await validateAssignedMcpServer({
    agentId: params.agentId,
    mcpServerId: params.mcpServerId,
    tool,
    preFetchedServer: params.preFetchedServer
      ? {
          ...params.preFetchedServer,
          ownerId: params.preFetchedServer.ownerId ?? null,
        }
      : params.preFetchedServer,
  });

  return result;
}

export async function validateExecutionSource(params: {
  agentId?: string;
  mcpServerId: string;
  tool?: Tool;
  toolId?: string;
  preFetchedTool?: Tool;
  preFetchedServer?:
    | (Pick<PrefetchedMcpServer, "id" | "catalogId"> &
        Partial<Pick<PrefetchedMcpServer, "ownerId">>)
    | null;
}) {
  const tool =
    params.tool ??
    params.preFetchedTool ??
    (params.toolId ? await ToolModel.findById(params.toolId) : null);
  if (!tool) {
    return {
      code: "not_found" as const,
      error: {
        message: `Tool with ID ${params.toolId} not found`,
        type: "not_found",
      },
    };
  }

  const catalogId =
    params.preFetchedServer?.catalogId ??
    (await McpServerModel.findById(params.mcpServerId))?.catalogId ??
    null;

  if (tool.catalogId && catalogId !== tool.catalogId) {
    return {
      code: "validation_error" as const,
      error: {
        message:
          "Execution source MCP server must come from the same catalog item as the tool",
        type: "validation_error",
      },
    };
  }

  return null;
}

export async function validateAssignedMcpServer(params: {
  agentId: string;
  mcpServerId: string;
  tool: Tool;
  preFetchedServer?: Pick<
    PrefetchedMcpServer,
    "id" | "ownerId" | "catalogId" | "teamId"
  > | null;
}): Promise<AgentToolAssignmentError | null> {
  const { agentId, mcpServerId, tool, preFetchedServer } = params;

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

  const targetContext = await getAssignmentTargetContext(agentId);
  const isAllowed = await isMcpServerAssignableToTarget({
    mcpServer,
    target: targetContext,
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

async function getAssignmentTargetContext(agentId: string): Promise<{
  organizationId: string;
  scope: AgentScope;
  authorId: string | null;
  teamIds: string[];
}> {
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

async function isOrgAdmin(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const membership = await MemberModel.getByUserId(userId, organizationId);
  return membership?.role === "admin";
}

export async function isMcpServerAssignableToTarget(params: {
  mcpServer: Pick<PrefetchedMcpServer, "ownerId" | "teamId">;
  target: {
    organizationId: string;
    scope: AgentScope;
    authorId: string | null;
    teamIds: string[];
  };
}): Promise<boolean> {
  const { mcpServer, target } = params;

  if (mcpServer.teamId) {
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

function getAssignmentValidationMessage(
  mcpServer: Pick<PrefetchedMcpServer, "teamId">,
) {
  if (mcpServer.teamId) {
    return "This team connection is not shared with the selected team";
  }

  return "The credential owner must be a member of a team that this resource is assigned to";
}
