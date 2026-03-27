import {
  AgentModel,
  AgentTeamModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
  UserModel,
} from "@/models";
import type {
  CredentialResolutionMode,
  EnterpriseManagedCredentialConfig,
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
  /**
   * Legacy alias for late-bound assignment mode.
   * Keep using `resolveAtCallTime` in new MCP-facing code; this alias remains
   * for backwards compatibility with older callers.
   */
  useDynamicTeamCredential?: boolean;
  credentialResolutionMode?: CredentialResolutionMode;
  enterpriseManagedConfig?: EnterpriseManagedCredentialConfig | null;
  /**
   * Explicit remote MCP installation to use as the credential source.
   * Use this only when you want to pin the tool to credentials from one
   * specific installed MCP server instead of resolving credentials at call time.
   */
  credentialSourceMcpServerId?: string | null;
  /**
   * Explicit local MCP installation to use as the execution target.
   * Use this only when you want to force a local MCP tool to run on one
   * specific installed MCP server instead of resolving execution at call time.
   */
  executionSourceMcpServerId?: string | null;
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
    enterpriseManagedConfig: params.enterpriseManagedConfig,
    credentialSourceMcpServerId: params.credentialSourceMcpServerId,
    executionSourceMcpServerId: params.executionSourceMcpServerId,
    preFetchedData: params.preFetchedData,
  });

  if (validationError) {
    return validationError;
  }

  const result = await AgentToolModel.createOrUpdateCredentials(
    params.agentId,
    params.toolId,
    params.credentialSourceMcpServerId,
    params.executionSourceMcpServerId,
    credentialResolutionMode === "dynamic",
    credentialResolutionMode,
    params.enterpriseManagedConfig,
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
  const {
    agentId,
    toolId,
    credentialSourceMcpServerId,
    executionSourceMcpServerId,
    enterpriseManagedConfig,
    preFetchedData,
  } = params;
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
    credentialSourceMcpServerId,
    executionSourceMcpServerId,
    preFetchedData,
    credentialResolutionMode,
  });
  if (catalogValidationError) {
    return catalogValidationError;
  }

  const enterpriseManagedValidationError =
    validateEnterpriseManagedConfiguration({
      credentialResolutionMode,
      enterpriseManagedConfig,
    });
  if (enterpriseManagedValidationError) {
    return enterpriseManagedValidationError;
  }

  if (credentialSourceMcpServerId) {
    const preFetchedServer = preFetchedData?.mcpServersBasicMap?.get(
      credentialSourceMcpServerId,
    );
    const validationError = await validateCredentialSource({
      agentId,
      credentialSourceMcpServerId,
      preFetchedServer,
    });
    if (validationError) {
      return validationError;
    }
  }

  if (executionSourceMcpServerId) {
    const preFetchedServer = preFetchedData?.mcpServersBasicMap?.get(
      executionSourceMcpServerId,
    );
    const validationError = await validateExecutionSource({
      toolId,
      preFetchedTool: tool,
      executionSourceMcpServerId,
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
  credentialSourceMcpServerId?: string | null;
  executionSourceMcpServerId?: string | null;
  preFetchedData?: Partial<AgentToolAssignmentPrefetchedData>;
  credentialResolutionMode: CredentialResolutionMode;
}): Promise<AgentToolAssignmentError | null> {
  const {
    tool,
    credentialSourceMcpServerId,
    executionSourceMcpServerId,
    preFetchedData,
    credentialResolutionMode,
  } = params;
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
    if (!executionSourceMcpServerId && !usesLateBoundResolution) {
      return {
        code: "validation_error",
        error: {
          message:
            "Execution source installation or non-static credential resolution is required for local MCP server tools",
          type: "validation_error",
        },
      };
    }
  }

  if (catalogItem?.serverType === "remote") {
    if (!credentialSourceMcpServerId && !usesLateBoundResolution) {
      return {
        code: "validation_error",
        error: {
          message:
            "Credential source or non-static credential resolution is required for remote MCP server tools",
          type: "validation_error",
        },
      };
    }
  }

  return null;
}

function normalizeResolveAtCallTime(params: {
  resolveAtCallTime?: boolean;
  useDynamicTeamCredential?: boolean;
}) {
  return params.resolveAtCallTime ?? params.useDynamicTeamCredential ?? false;
}

function normalizeCredentialResolutionMode(params: {
  resolveAtCallTime?: boolean;
  useDynamicTeamCredential?: boolean;
  credentialResolutionMode?: CredentialResolutionMode;
}) {
  if (params.credentialResolutionMode) {
    return params.credentialResolutionMode;
  }

  return normalizeResolveAtCallTime(params) ? "dynamic" : "static";
}

function validateEnterpriseManagedConfiguration(params: {
  credentialResolutionMode: CredentialResolutionMode;
  enterpriseManagedConfig?: EnterpriseManagedCredentialConfig | null;
}): AgentToolAssignmentError | null {
  const { credentialResolutionMode, enterpriseManagedConfig } = params;

  if (credentialResolutionMode !== "enterprise_managed") {
    if (enterpriseManagedConfig) {
      return {
        code: "validation_error",
        error: {
          message:
            "Enterprise-managed config can only be set when credential resolution mode is enterprise_managed",
          type: "validation_error",
        },
      };
    }

    return null;
  }

  if (!enterpriseManagedConfig) {
    return {
      code: "validation_error",
      error: {
        message:
          "Enterprise-managed config is required when credential resolution mode is enterprise_managed",
        type: "validation_error",
      },
    };
  }

  return null;
}

export async function validateCredentialSource(params: {
  agentId: string;
  credentialSourceMcpServerId: string;
  preFetchedServer?: Pick<PrefetchedMcpServer, "id" | "ownerId"> | null;
}): Promise<AgentToolAssignmentError | null> {
  const { agentId, credentialSourceMcpServerId, preFetchedServer } = params;

  const mcpServer =
    preFetchedServer !== undefined
      ? preFetchedServer
      : await McpServerModel.findById(credentialSourceMcpServerId);

  if (!mcpServer) {
    return {
      code: "not_found",
      error: {
        message: `MCP server with ID ${credentialSourceMcpServerId} not found`,
        type: "not_found",
      },
    };
  }

  const owner = mcpServer.ownerId
    ? await UserModel.getById(mcpServer.ownerId)
    : null;
  if (!owner) {
    return {
      code: "validation_error",
      error: {
        message: "Personal token owner not found",
        type: "validation_error",
      },
    };
  }

  const hasAccess = await AgentTeamModel.userHasAgentAccess(
    owner.id,
    agentId,
    false,
  );

  if (!hasAccess) {
    return {
      code: "validation_error",
      error: {
        message:
          "The credential owner must be a member of a team that this agent is assigned to",
        type: "validation_error",
      },
    };
  }

  return null;
}

export async function validateExecutionSource(params: {
  toolId: string;
  executionSourceMcpServerId: string;
  preFetchedTool?: Tool | null;
  preFetchedServer?: Pick<PrefetchedMcpServer, "id" | "catalogId"> | null;
}): Promise<AgentToolAssignmentError | null> {
  const {
    toolId,
    executionSourceMcpServerId,
    preFetchedTool,
    preFetchedServer,
  } = params;

  const mcpServer =
    preFetchedServer !== undefined
      ? preFetchedServer
      : await McpServerModel.findById(executionSourceMcpServerId);
  if (!mcpServer) {
    return {
      code: "not_found",
      error: {
        message: `MCP server with ID ${executionSourceMcpServerId} not found`,
        type: "not_found",
      },
    };
  }

  const tool =
    preFetchedTool !== undefined
      ? preFetchedTool
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

  if (!tool.catalogId) {
    return {
      code: "validation_error",
      error: {
        message: "Only MCP server tools can use an execution source",
        type: "validation_error",
      },
    };
  }

  if (mcpServer.catalogId !== tool.catalogId) {
    return {
      code: "validation_error",
      error: {
        message:
          "Execution source MCP server must come from the same catalog item as the tool",
        type: "validation_error",
      },
    };
  }

  return null;
}
