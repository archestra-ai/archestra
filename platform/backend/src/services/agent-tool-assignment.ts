import {
  AgentModel,
  AgentTeamModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
  UserModel,
} from "@/models";
import type { InternalMcpCatalog, Tool } from "@/types";

export type AgentToolAssignmentError = {
  code: "not_found" | "validation_error";
  error: { message: string; type: string };
};

export type AgentToolAssignmentPrefetchedData = {
  existingAgentIds: Set<string>;
  toolsMap: Map<string, Tool>;
  catalogItemsMap: Map<string, InternalMcpCatalog>;
  mcpServersBasicMap: Map<
    string,
    { id: string; ownerId: string | null; catalogId: string | null }
  >;
};

export async function assignToolToAgent(params: {
  agentId: string;
  toolId: string;
  credentialSourceMcpServerId?: string | null;
  executionSourceMcpServerId?: string | null;
  preFetchedData?: Partial<AgentToolAssignmentPrefetchedData>;
  useDynamicTeamCredential?: boolean;
}): Promise<AgentToolAssignmentError | "duplicate" | "updated" | null> {
  const validationError = await validateAssignment({
    agentId: params.agentId,
    toolId: params.toolId,
    credentialSourceMcpServerId: params.credentialSourceMcpServerId,
    executionSourceMcpServerId: params.executionSourceMcpServerId,
    preFetchedData: params.preFetchedData,
    useDynamicTeamCredential: params.useDynamicTeamCredential,
  });

  if (validationError) {
    return validationError;
  }

  const result = await AgentToolModel.createOrUpdateCredentials(
    params.agentId,
    params.toolId,
    params.credentialSourceMcpServerId,
    params.executionSourceMcpServerId,
    params.useDynamicTeamCredential,
  );

  if (result.status === "unchanged") {
    return "duplicate";
  }

  if (result.status === "updated") {
    return "updated";
  }

  return null;
}

export async function validateAssignment(params: {
  agentId: string;
  toolId: string;
  credentialSourceMcpServerId?: string | null;
  executionSourceMcpServerId?: string | null;
  preFetchedData?: Partial<AgentToolAssignmentPrefetchedData>;
  useDynamicTeamCredential?: boolean;
}): Promise<AgentToolAssignmentError | null> {
  const {
    agentId,
    toolId,
    credentialSourceMcpServerId,
    executionSourceMcpServerId,
    preFetchedData,
    useDynamicTeamCredential,
  } = params;

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
    useDynamicTeamCredential,
  });
  if (catalogValidationError) {
    return catalogValidationError;
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
  useDynamicTeamCredential?: boolean;
}): Promise<AgentToolAssignmentError | null> {
  const {
    tool,
    credentialSourceMcpServerId,
    executionSourceMcpServerId,
    preFetchedData,
    useDynamicTeamCredential,
  } = params;

  if (!tool.catalogId) {
    return null;
  }

  const catalogItem = preFetchedData?.catalogItemsMap
    ? preFetchedData.catalogItemsMap.get(tool.catalogId) || null
    : await InternalMcpCatalogModel.findById(tool.catalogId, {
        expandSecrets: false,
      });

  if (catalogItem?.serverType === "local") {
    if (!executionSourceMcpServerId && !useDynamicTeamCredential) {
        return {
        code: "validation_error",
        error: {
          message:
            "Execution source installation or dynamic team credential is required for local MCP server tools",
          type: "validation_error",
        },
      };
    }
  }

  if (catalogItem?.serverType === "remote") {
    if (!credentialSourceMcpServerId && !useDynamicTeamCredential) {
      return {
        code: "validation_error",
        error: {
          message:
            "Credential source or dynamic team credential is required for remote MCP server tools",
          type: "validation_error",
        },
      };
    }
  }

  return null;
}

export async function validateCredentialSource(params: {
  agentId: string;
  credentialSourceMcpServerId: string;
  preFetchedServer?: { id: string; ownerId: string | null } | null;
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
    true,
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
  preFetchedServer?: { id: string; catalogId: string | null } | null;
}): Promise<AgentToolAssignmentError | null> {
  const { toolId, executionSourceMcpServerId, preFetchedServer } = params;

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

  const tool = await ToolModel.findById(toolId);
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
