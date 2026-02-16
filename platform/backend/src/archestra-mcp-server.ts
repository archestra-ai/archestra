import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  AGENT_TOOL_PREFIX,
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME,
  TOOL_QUERY_KNOWLEDGE_GRAPH_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
} from "@shared";
import { executeA2AMessage } from "@/agents/a2a-executor";
import { userHasPermission } from "@/auth/utils";
import type { TokenAuthContext } from "@/clients/mcp-client";
import { getKnowledgeGraphProvider } from "@/knowledge-graph";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  ConversationModel,
  InternalMcpCatalogModel,
  LimitModel,
  McpServerModel,
  ToolInvocationPolicyModel,
  ToolModel,
  TrustedDataPolicyModel,
} from "@/models";
import { assignToolToAgent } from "@/routes/agent-tool";
import { ProviderError } from "@/routes/chat/errors";
import type { InternalMcpCatalog } from "@/types";
import {
  AutonomyPolicyOperator,
  type LimitEntityType,
  type LimitType,
  LimitTypeSchema,
  type ToolInvocation,
  type TrustedData,
} from "@/types";
import { type QueryMode, QueryModeSchema } from "@/types/knowledge-graph";

/**
 * Constants for Archestra MCP server
 */
const TOOL_WHOAMI_NAME = "whoami";
const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME = "search_private_mcp_registry";
const TOOL_CREATE_LIMIT_NAME = "create_limit";
const TOOL_GET_LIMITS_NAME = "get_limits";
const TOOL_UPDATE_LIMIT_NAME = "update_limit";
const TOOL_DELETE_LIMIT_NAME = "delete_limit";
const TOOL_GET_AGENT_TOKEN_USAGE_NAME = "get_agent_token_usage";
const TOOL_GET_LLM_PROXY_TOKEN_USAGE_NAME = "get_llm_proxy_token_usage";
const TOOL_CREATE_AGENT_NAME = "create_agent";
const TOOL_CREATE_LLM_PROXY_NAME = "create_llm_proxy";
const TOOL_CREATE_MCP_GATEWAY_NAME = "create_mcp_gateway";
const TOOL_GET_AUTONOMY_POLICY_OPERATORS_NAME = "get_autonomy_policy_operators";
const TOOL_GET_TOOL_INVOCATION_POLICIES_NAME = "get_tool_invocation_policies";
const TOOL_CREATE_TOOL_INVOCATION_POLICY_NAME = "create_tool_invocation_policy";
const TOOL_GET_TOOL_INVOCATION_POLICY_NAME = "get_tool_invocation_policy";
const TOOL_UPDATE_TOOL_INVOCATION_POLICY_NAME = "update_tool_invocation_policy";
const TOOL_DELETE_TOOL_INVOCATION_POLICY_NAME = "delete_tool_invocation_policy";
const TOOL_GET_TRUSTED_DATA_POLICIES_NAME = "get_trusted_data_policies";
const TOOL_CREATE_TRUSTED_DATA_POLICY_NAME = "create_trusted_data_policy";
const TOOL_GET_TRUSTED_DATA_POLICY_NAME = "get_trusted_data_policy";
const TOOL_UPDATE_TRUSTED_DATA_POLICY_NAME = "update_trusted_data_policy";
const TOOL_DELETE_TRUSTED_DATA_POLICY_NAME = "delete_trusted_data_policy";
const TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_NAME = "bulk_assign_tools_to_agents";
const TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_NAME =
  "bulk_assign_tools_to_mcp_gateways";
const TOOL_GET_MCP_SERVERS_NAME = "get_mcp_servers";
const TOOL_GET_MCP_SERVER_TOOLS_NAME = "get_mcp_server_tools";
const TOOL_GET_AGENT_NAME = "get_agent";
const TOOL_GET_LLM_PROXY_NAME = "get_llm_proxy";
const TOOL_GET_MCP_GATEWAY_NAME = "get_mcp_gateway";

/**
 * Convert a name to a URL-safe slug for tool naming
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Construct fully-qualified tool names
const TOOL_WHOAMI_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_WHOAMI_NAME}`;
const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME}`;
const TOOL_CREATE_LIMIT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_LIMIT_NAME}`;
const TOOL_GET_LIMITS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_LIMITS_NAME}`;
const TOOL_UPDATE_LIMIT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_UPDATE_LIMIT_NAME}`;
const TOOL_DELETE_LIMIT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_DELETE_LIMIT_NAME}`;
const TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_AGENT_TOKEN_USAGE_NAME}`;
const TOOL_GET_LLM_PROXY_TOKEN_USAGE_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_LLM_PROXY_TOKEN_USAGE_NAME}`;
const TOOL_CREATE_AGENT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_AGENT_NAME}`;
const TOOL_CREATE_LLM_PROXY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_LLM_PROXY_NAME}`;
const TOOL_CREATE_MCP_GATEWAY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_MCP_GATEWAY_NAME}`;
const TOOL_GET_AUTONOMY_POLICY_OPERATORS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_AUTONOMY_POLICY_OPERATORS_NAME}`;
const TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TOOL_INVOCATION_POLICIES_NAME}`;
const TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_GET_TOOL_INVOCATION_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_UPDATE_TOOL_INVOCATION_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_UPDATE_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_DELETE_TOOL_INVOCATION_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_DELETE_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_GET_TRUSTED_DATA_POLICIES_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TRUSTED_DATA_POLICIES_NAME}`;
const TOOL_CREATE_TRUSTED_DATA_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_TRUSTED_DATA_POLICY_NAME}`;
const TOOL_GET_TRUSTED_DATA_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TRUSTED_DATA_POLICY_NAME}`;
const TOOL_UPDATE_TRUSTED_DATA_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_UPDATE_TRUSTED_DATA_POLICY_NAME}`;
const TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_DELETE_TRUSTED_DATA_POLICY_NAME}`;
const TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_NAME}`;
const TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_NAME}`;
const TOOL_GET_MCP_SERVERS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_SERVERS_NAME}`;
const TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_SERVER_TOOLS_NAME}`;
const TOOL_GET_AGENT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_AGENT_NAME}`;
const TOOL_GET_LLM_PROXY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_LLM_PROXY_NAME}`;
const TOOL_GET_MCP_GATEWAY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_GATEWAY_NAME}`;

/**
 * Context for the Archestra MCP server
 */
export interface ArchestraContext {
  agent: {
    id: string;
    name: string;
  };
  conversationId?: string;
  userId?: string;
  /** The ID of the current internal agent (for agent delegation tool lookup) */
  agentId?: string;
  /** The organization ID */
  organizationId?: string;
  /** Token authentication context */
  tokenAuth?: TokenAuthContext;
  /** Session ID for grouping related LLM requests in logs */
  sessionId?: string;
  /**
   * Delegation chain of agent IDs (colon-separated).
   * Used to track the path of delegated agent calls.
   * E.g., "agentA:agentB" means agentA delegated to agentB.
   */
  delegationChain?: string;
  /** Optional cancellation signal from parent chat/tool execution */
  abortSignal?: AbortSignal;
}

/**
 * Execute an Archestra MCP tool
 */
export async function executeArchestraTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent: contextAgent, agentId, organizationId, tokenAuth } = context;

  // Handle dynamic agent tools (e.g., agent__research_bot)
  if (toolName.startsWith(AGENT_TOOL_PREFIX)) {
    const message = args?.message as string;

    if (!message) {
      return {
        content: [{ type: "text", text: "Error: message is required." }],
        isError: true,
      };
    }

    if (!agentId) {
      return {
        content: [{ type: "text", text: "Error: No agent context available." }],
        isError: true,
      };
    }

    if (!organizationId) {
      return {
        content: [
          { type: "text", text: "Error: Organization context not available." },
        ],
        isError: true,
      };
    }

    // Extract target agent slug from tool name
    const targetAgentSlug = toolName.replace(AGENT_TOOL_PREFIX, "");

    // Get all delegation targets configured for this agent
    const delegations = await ToolModel.getDelegationToolsByAgent(agentId);

    // Find matching delegation by slug
    const delegation = delegations.find(
      (d) => slugify(d.targetAgent.name) === targetAgentSlug,
    );

    if (!delegation) {
      return {
        content: [
          {
            type: "text",
            text: `Error: Agent not found or not configured for delegation.`,
          },
        ],
        isError: true,
      };
    }

    // Check user has access if user token is being used
    const userId = tokenAuth?.userId;
    if (userId && organizationId) {
      const isProfileAdmin = await userHasPermission(
        userId,
        organizationId,
        "profile",
        "admin",
      );

      const userAccessibleAgentIds =
        await AgentTeamModel.getUserAccessibleAgentIds(userId, isProfileAdmin);
      if (!userAccessibleAgentIds.includes(delegation.targetAgent.id)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: You don't have access to this agent.`,
            },
          ],
          isError: true,
        };
      }
    }

    try {
      // Use sessionId from context, or fall back to conversationId for chat context
      const sessionId = context.sessionId || context.conversationId;

      logger.info(
        {
          agentId,
          targetAgentId: delegation.targetAgent.id,
          targetAgentName: delegation.targetAgent.name,
          organizationId,
          userId: userId || "system",
          sessionId,
        },
        "Executing agent delegation tool",
      );

      const result = await executeA2AMessage({
        agentId: delegation.targetAgent.id,
        message,
        organizationId,
        userId: userId || "system",
        sessionId,
        // Pass the current delegation chain so the child can extend it
        parentDelegationChain: context.delegationChain || context.agentId,
        // Propagate conversationId for browser tab isolation
        conversationId: context.conversationId,
        abortSignal: context.abortSignal,
      });

      return {
        content: [{ type: "text", text: result.text }],
        isError: false,
      };
    } catch (error) {
      if (isAbortLikeError(error)) {
        logger.info(
          { agentId, targetAgentId: delegation.targetAgent.id },
          "Agent delegation was aborted",
        );
        throw error;
      }
      logger.error(
        { error, agentId, targetAgentId: delegation.targetAgent.id },
        "Agent delegation tool execution failed",
      );
      // Re-throw ProviderError so it propagates to the parent stream's onError
      // with the correct provider info (the subagent can't produce output)
      if (error instanceof ProviderError) {
        throw error;
      }
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_WHOAMI_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, agentName: contextAgent.name },
      "whoami tool called",
    );

    return {
      content: [
        {
          type: "text",
          text: `Agent Name: ${contextAgent.name}\nAgent ID: ${contextAgent.id}`,
        },
      ],
      isError: false,
    };
  }

  if (toolName === TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, searchArgs: args },
      "search_private_mcp_registry tool called",
    );

    try {
      const query = args?.query as string | undefined;

      let catalogItems: InternalMcpCatalog[];

      if (query && query.trim() !== "") {
        // Search by name or description - don't expand secrets, we do not need them to execute the tool
        catalogItems = await InternalMcpCatalogModel.searchByQuery(query, {
          expandSecrets: false,
        });
      } else {
        // Return all catalog items - don't expand secrets, we do not need actual secrets for this
        catalogItems = await InternalMcpCatalogModel.findAll({
          expandSecrets: false,
        });
      }

      if (catalogItems.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: query
                ? `No MCP servers found matching query: "${query}"`
                : "No MCP servers found in the private registry.",
            },
          ],
          isError: false,
        };
      }

      // Format the results
      const formattedResults = catalogItems
        .map((item) => {
          let result = `**${item.name}**`;
          if (item.version) result += ` (v${item.version})`;
          if (item.description) result += `\n  ${item.description}`;
          result += `\n  Type: ${item.serverType}`;
          if (item.serverUrl) result += `\n  URL: ${item.serverUrl}`;
          if (item.repository) result += `\n  Repository: ${item.repository}`;
          result += `\n  ID: ${item.id}`;
          return result;
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${catalogItems.length} MCP server(s):\n\n${formattedResults}`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error searching private MCP registry");
      return {
        content: [
          {
            type: "text",
            text: `Error searching private MCP registry: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (
    toolName === TOOL_CREATE_AGENT_FULL_NAME ||
    toolName === TOOL_CREATE_LLM_PROXY_FULL_NAME ||
    toolName === TOOL_CREATE_MCP_GATEWAY_FULL_NAME
  ) {
    const agentTypeMap: Record<string, string> = {
      [TOOL_CREATE_AGENT_FULL_NAME]: "agent",
      [TOOL_CREATE_LLM_PROXY_FULL_NAME]: "llm_proxy",
      [TOOL_CREATE_MCP_GATEWAY_FULL_NAME]: "mcp_gateway",
    };
    const targetAgentType = agentTypeMap[toolName];
    const toolLabel = targetAgentType.replace("_", " ");

    logger.info(
      {
        agentId: contextAgent.id,
        createArgs: args,
        agentType: targetAgentType,
      },
      `create_${targetAgentType} tool called`,
    );

    try {
      const name = args?.name as string;
      const teams = (args?.teams as string[]) ?? [];
      const labels = args?.labels as
        | Array<{
            key: string;
            value: string;
          }>
        | undefined;

      // Validate required fields
      if (!name || name.trim() === "") {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${toolLabel} name is required and cannot be empty.`,
            },
          ],
          isError: true,
        };
      }

      // Build create params - only agents get prompt fields
      const createParams: Parameters<typeof AgentModel.create>[0] = {
        name,
        teams,
        labels,
        agentType: targetAgentType as "agent" | "llm_proxy" | "mcp_gateway",
      };

      if (targetAgentType === "agent") {
        const systemPrompt = args?.systemPrompt as string | undefined;
        const userPrompt = args?.userPrompt as string | undefined;
        if (systemPrompt) createParams.systemPrompt = systemPrompt;
        if (userPrompt) createParams.userPrompt = userPrompt;
      }

      const created = await AgentModel.create(createParams);

      return {
        content: [
          {
            type: "text",
            text: `Successfully created ${toolLabel}.\n\nName: ${
              created.name
            }\nID: ${created.id}\nType: ${targetAgentType}\nTeams: ${
              created.teams.length > 0
                ? created.teams.map((t) => t.name).join(", ")
                : "None"
            }\nLabels: ${
              created.labels.length > 0
                ? created.labels.map((l) => `${l.key}: ${l.value}`).join(", ")
                : "None"
            }`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, `Error creating ${toolLabel}`);
      return {
        content: [
          {
            type: "text",
            text: `Error creating ${toolLabel}: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * This tool is quite unique in that the tool handler doesn't actually need to do anything
   * see the useChat() usage in the chat UI for more details
   */
  if (toolName === TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, requestArgs: args },
      "create_mcp_server_installation_request tool called",
    );

    try {
      return {
        content: [
          {
            type: "text",
            // Return a user-friendly message explaining what will happen
            // Note: The frontend will show either the "Add MCP Server to Private Registry" dialog
            // (for users with internalMcpCatalog:create permission) or the installation request dialog
            text: "A dialog for adding or requesting an MCP server should now be visible in the chat. Please review and submit to proceed.",
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error(
        { err: error },
        "Error handling MCP server installation request",
      );
      return {
        content: [
          {
            type: "text",
            text: `Error handling installation request: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_CREATE_LIMIT_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, createLimitArgs: args },
      "create_limit tool called",
    );

    try {
      const entityType = args?.entity_type as LimitEntityType;

      const entityId = args?.entity_id as string;
      const limitType = args?.limit_type as LimitType;
      const limitValue = args?.limit_value as number;
      const model = args?.model as string[] | undefined;
      const mcpServerName = args?.mcp_server_name as string | undefined;
      const toolName = args?.tool_name as string | undefined;

      // Validate required fields
      if (!entityType || !entityId || !limitType || limitValue === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "Error: entity_type, entity_id, limit_type, and limit_value are required fields.",
            },
          ],
          isError: true,
        };
      }

      // Validate limit type specific requirements
      if (
        limitType === "token_cost" &&
        (!model || !Array.isArray(model) || model.length === 0)
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Error: model array with at least one model is required for token_cost limits.",
            },
          ],
          isError: true,
        };
      }

      if (limitType === "mcp_server_calls" && !mcpServerName) {
        return {
          content: [
            {
              type: "text",
              text: "Error: mcp_server_name is required for mcp_server_calls limits.",
            },
          ],
          isError: true,
        };
      }

      if (limitType === "tool_calls" && (!mcpServerName || !toolName)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: mcp_server_name and tool_name are required for tool_calls limits.",
            },
          ],
          isError: true,
        };
      }

      // Create the limit
      const limit = await LimitModel.create({
        entityType,
        entityId,
        limitType,
        limitValue,
        model,
        mcpServerName,
        toolName,
      });

      return {
        content: [
          {
            type: "text",
            text: `Successfully created limit.\n\nLimit ID: ${
              limit.id
            }\nEntity Type: ${limit.entityType}\nEntity ID: ${
              limit.entityId
            }\nLimit Type: ${limit.limitType}\nLimit Value: ${
              limit.limitValue
            }${limit.model ? `\nModel: ${limit.model}` : ""}${
              limit.mcpServerName ? `\nMCP Server: ${limit.mcpServerName}` : ""
            }${limit.toolName ? `\nTool: ${limit.toolName}` : ""}`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error creating limit");
      return {
        content: [
          {
            type: "text",
            text: `Error creating limit: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_LIMITS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, getLimitsArgs: args },
      "get_limits tool called",
    );

    try {
      const entityType = args?.entity_type as LimitEntityType;

      const entityId = args?.entity_id as string | undefined;

      const limits = await LimitModel.findAll(entityType, entityId);

      if (limits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                entityType || entityId
                  ? `No limits found${
                      entityType ? ` for entity type: ${entityType}` : ""
                    }${entityId ? ` and entity ID: ${entityId}` : ""}.`
                  : "No limits found.",
            },
          ],
          isError: false,
        };
      }

      const formattedLimits = limits
        .map((limit) => {
          let result = `**Limit ID:** ${limit.id}`;
          result += `\n  Entity Type: ${limit.entityType}`;
          result += `\n  Entity ID: ${limit.entityId}`;
          result += `\n  Limit Type: ${limit.limitType}`;
          result += `\n  Limit Value: ${limit.limitValue}`;
          if (limit.model) result += `\n  Model: ${limit.model}`;
          if (limit.mcpServerName)
            result += `\n  MCP Server: ${limit.mcpServerName}`;
          if (limit.toolName) result += `\n  Tool: ${limit.toolName}`;
          if (limit.lastCleanup)
            result += `\n  Last Cleanup: ${limit.lastCleanup}`;
          return result;
        })
        .join("\n\n");

      return {
        content: [
          {
            type: "text",
            text: `Found ${limits.length} limit(s):\n\n${formattedLimits}`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting limits");
      return {
        content: [
          {
            type: "text",
            text: `Error getting limits: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_UPDATE_LIMIT_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, updateLimitArgs: args },
      "update_limit tool called",
    );

    try {
      const id = args?.id as string;
      const limitValue = args?.limit_value as number | undefined;

      if (!id) {
        return {
          content: [
            {
              type: "text",
              text: "Error: id is required to update a limit.",
            },
          ],
          isError: true,
        };
      }

      const updateData: Record<string, unknown> = {};
      if (limitValue !== undefined) {
        updateData.limitValue = limitValue;
      }

      if (Object.keys(updateData).length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "Error: No fields provided to update.",
            },
          ],
          isError: true,
        };
      }

      const limit = await LimitModel.patch(id, updateData);

      if (!limit) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Limit with ID ${id} not found.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Successfully updated limit.\n\nLimit ID: ${limit.id}\nEntity Type: ${limit.entityType}\nEntity ID: ${limit.entityId}\nLimit Type: ${limit.limitType}\nLimit Value: ${limit.limitValue}`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error updating limit");
      return {
        content: [
          {
            type: "text",
            text: `Error updating limit: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_DELETE_LIMIT_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, deleteLimitArgs: args },
      "delete_limit tool called",
    );

    try {
      const id = args?.id as string;

      if (!id) {
        return {
          content: [
            {
              type: "text",
              text: "Error: id is required to delete a limit.",
            },
          ],
          isError: true,
        };
      }

      const deleted = await LimitModel.delete(id);

      if (!deleted) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Limit with ID ${id} not found.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Successfully deleted limit with ID: ${id}`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error deleting limit");
      return {
        content: [
          {
            type: "text",
            text: `Error deleting limit: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (
    toolName === TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME ||
    toolName === TOOL_GET_LLM_PROXY_TOKEN_USAGE_FULL_NAME
  ) {
    const tokenUsageTypeMap: Record<string, string> = {
      [TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME]: "agent",
      [TOOL_GET_LLM_PROXY_TOKEN_USAGE_FULL_NAME]: "llm_proxy",
    };
    const tokenUsageType = tokenUsageTypeMap[toolName];
    const tokenUsageLabel = tokenUsageType.replace("_", " ");

    logger.info(
      {
        agentId: contextAgent.id,
        getTokenUsageArgs: args,
        type: tokenUsageType,
      },
      `get_${tokenUsageType}_token_usage tool called`,
    );

    try {
      const targetId = (args?.id as string) || contextAgent.id;
      const usage = await LimitModel.getAgentTokenUsage(targetId);

      return {
        content: [
          {
            type: "text",
            text: `Token usage for ${tokenUsageLabel} ${targetId}:\n\nTotal Input Tokens: ${usage.totalInputTokens.toLocaleString()}\nTotal Output Tokens: ${usage.totalOutputTokens.toLocaleString()}\nTotal Tokens: ${usage.totalTokens.toLocaleString()}`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error(
        { err: error },
        `Error getting ${tokenUsageLabel} token usage`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error getting ${tokenUsageLabel} token usage: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_AUTONOMY_POLICY_OPERATORS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id },
      "get_autonomy_policy_operators tool called",
    );

    try {
      const supportedOperators = Object.values(
        AutonomyPolicyOperator.SupportedOperatorSchema.enum,
      ).map((value) => {
        // Convert camel case to title case
        const titleCaseConversion = value.replace(/([A-Z])/g, " $1");
        const label =
          titleCaseConversion.charAt(0).toUpperCase() +
          titleCaseConversion.slice(1);

        return { value, label };
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(supportedOperators, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting autonomy policy operators");
      return {
        content: [
          {
            type: "text",
            text: `Error getting autonomy policy operators: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id },
      "get_tool_invocation_policies tool called",
    );

    try {
      const policies = await ToolInvocationPolicyModel.findAll();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(policies, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting tool invocation policies");
      return {
        content: [
          {
            type: "text",
            text: `Error getting tool invocation policies: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, createArgs: args },
      "create_tool_invocation_policy tool called",
    );

    try {
      const a = args ?? {};
      const policy = await ToolInvocationPolicyModel.create({
        toolId: a.toolId as string,
        conditions: (a.conditions ??
          []) as ToolInvocation.InsertToolInvocationPolicy["conditions"],
        action: a.action as ToolInvocation.InsertToolInvocationPolicy["action"],
        reason: (a.reason as string) ?? null,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(policy, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error creating tool invocation policy");
      return {
        content: [
          {
            type: "text",
            text: `Error creating tool invocation policy: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, policyId: args?.id },
      "get_tool_invocation_policy tool called",
    );

    try {
      const id = args?.id as string;
      if (!id) {
        return {
          content: [
            {
              type: "text",
              text: "Error: id parameter is required",
            },
          ],
          isError: true,
        };
      }

      const policy = await ToolInvocationPolicyModel.findById(id);
      if (!policy) {
        return {
          content: [
            {
              type: "text",
              text: "Tool invocation policy not found",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(policy, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting tool invocation policy");
      return {
        content: [
          {
            type: "text",
            text: `Error getting tool invocation policy: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_UPDATE_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, updateArgs: args },
      "update_tool_invocation_policy tool called",
    );

    try {
      const a = args ?? {};
      const id = a.id as string;
      if (!id) {
        return {
          content: [
            {
              type: "text",
              text: "Error: id parameter is required",
            },
          ],
          isError: true,
        };
      }

      const updateData: Partial<ToolInvocation.InsertToolInvocationPolicy> = {};
      if (a.toolId !== undefined) updateData.toolId = a.toolId as string;
      if (a.conditions !== undefined)
        updateData.conditions =
          a.conditions as ToolInvocation.InsertToolInvocationPolicy["conditions"];
      if (a.action !== undefined)
        updateData.action =
          a.action as ToolInvocation.InsertToolInvocationPolicy["action"];
      if (a.reason !== undefined)
        updateData.reason = (a.reason as string) ?? null;

      const policy = await ToolInvocationPolicyModel.update(id, updateData);
      if (!policy) {
        return {
          content: [
            {
              type: "text",
              text: "Tool invocation policy not found",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(policy, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error updating tool invocation policy");
      return {
        content: [
          {
            type: "text",
            text: `Error updating tool invocation policy: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_DELETE_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, policyId: args?.id },
      "delete_tool_invocation_policy tool called",
    );

    try {
      const id = args?.id as string;
      if (!id) {
        return {
          content: [
            {
              type: "text",
              text: "Error: id parameter is required",
            },
          ],
          isError: true,
        };
      }

      const success = await ToolInvocationPolicyModel.delete(id);
      if (!success) {
        return {
          content: [
            {
              type: "text",
              text: "Tool invocation policy not found",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error deleting tool invocation policy");
      return {
        content: [
          {
            type: "text",
            text: `Error deleting tool invocation policy: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_TRUSTED_DATA_POLICIES_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id },
      "get_trusted_data_policies tool called",
    );

    try {
      const policies = await TrustedDataPolicyModel.findAll();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(policies, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting trusted data policies");
      return {
        content: [
          {
            type: "text",
            text: `Error getting trusted data policies: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_CREATE_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, createArgs: args },
      "create_trusted_data_policy tool called",
    );

    try {
      const a = args ?? {};
      const policy = await TrustedDataPolicyModel.create({
        toolId: a.toolId as string,
        conditions: (a.conditions ??
          []) as TrustedData.InsertTrustedDataPolicy["conditions"],
        action: a.action as TrustedData.InsertTrustedDataPolicy["action"],
        description: (a.description as string) ?? null,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(policy, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error creating trusted data policy");
      return {
        content: [
          {
            type: "text",
            text: `Error creating trusted data policy: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, policyId: args?.id },
      "get_trusted_data_policy tool called",
    );

    try {
      const id = args?.id as string;
      if (!id) {
        return {
          content: [
            {
              type: "text",
              text: "Error: id parameter is required",
            },
          ],
          isError: true,
        };
      }

      const policy = await TrustedDataPolicyModel.findById(id);
      if (!policy) {
        return {
          content: [
            {
              type: "text",
              text: "Trusted data policy not found",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(policy, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting trusted data policy");
      return {
        content: [
          {
            type: "text",
            text: `Error getting trusted data policy: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_UPDATE_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, updateArgs: args },
      "update_trusted_data_policy tool called",
    );

    try {
      const a = args ?? {};
      const id = a.id as string;
      if (!id) {
        return {
          content: [
            {
              type: "text",
              text: "Error: id parameter is required",
            },
          ],
          isError: true,
        };
      }

      const updateData: Partial<TrustedData.InsertTrustedDataPolicy> = {};
      if (a.toolId !== undefined) updateData.toolId = a.toolId as string;
      if (a.conditions !== undefined)
        updateData.conditions =
          a.conditions as TrustedData.InsertTrustedDataPolicy["conditions"];
      if (a.action !== undefined)
        updateData.action =
          a.action as TrustedData.InsertTrustedDataPolicy["action"];
      if (a.description !== undefined)
        updateData.description = (a.description as string) ?? null;

      const policy = await TrustedDataPolicyModel.update(id, updateData);
      if (!policy) {
        return {
          content: [
            {
              type: "text",
              text: "Trusted data policy not found",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(policy, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error updating trusted data policy");
      return {
        content: [
          {
            type: "text",
            text: `Error updating trusted data policy: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, policyId: args?.id },
      "delete_trusted_data_policy tool called",
    );

    try {
      const id = args?.id as string;
      if (!id) {
        return {
          content: [
            {
              type: "text",
              text: "Error: id parameter is required",
            },
          ],
          isError: true,
        };
      }

      const success = await TrustedDataPolicyModel.delete(id);
      if (!success) {
        return {
          content: [
            {
              type: "text",
              text: "Trusted data policy not found",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error deleting trusted data policy");
      return {
        content: [
          {
            type: "text",
            text: `Error deleting trusted data policy: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (
    toolName === TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME ||
    toolName === TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME
  ) {
    const bulkAssignTypeMap: Record<string, string> = {
      [TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME]: "agent",
      [TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME]: "mcp_gateway",
    };
    const bulkAssignType = bulkAssignTypeMap[toolName];
    const idField = bulkAssignType === "agent" ? "agentId" : "mcpGatewayId";
    const bulkAssignLabel =
      bulkAssignType === "agent" ? "agents" : "MCP gateways";

    logger.info(
      {
        agentId: contextAgent.id,
        assignments: args?.assignments,
        type: bulkAssignType,
      },
      `bulk_assign_tools_to_${bulkAssignType === "agent" ? "agents" : "mcp_gateways"} tool called`,
    );

    try {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic property access by idField
      const assignments = args?.assignments as Array<Record<string, any>>;

      if (!assignments || !Array.isArray(assignments)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: assignments parameter is required and must be an array",
            },
          ],
          isError: true,
        };
      }

      const results = await Promise.allSettled(
        assignments.map((assignment) =>
          assignToolToAgent(
            assignment[idField],
            assignment.toolId,
            assignment.credentialSourceMcpServerId,
            assignment.executionSourceMcpServerId,
          ),
        ),
      );

      const succeeded: { [key: string]: string }[] = [];
      const failed: { [key: string]: string }[] = [];
      const duplicates: { [key: string]: string }[] = [];

      results.forEach((result, index) => {
        const entityId = assignments[index][idField];
        const { toolId } = assignments[index];
        if (result.status === "fulfilled") {
          if (result.value === null || result.value === "updated") {
            succeeded.push({ [idField]: entityId, toolId });
          } else if (result.value === "duplicate") {
            duplicates.push({ [idField]: entityId, toolId });
          } else {
            const error = result.value.error.message || "Unknown error";
            failed.push({ [idField]: entityId, toolId, error });
          }
        } else if (result.status === "rejected") {
          const error =
            result.reason instanceof Error
              ? result.reason.message
              : "Unknown error";
          failed.push({ [idField]: entityId, toolId, error });
        }
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ succeeded, failed, duplicates }, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error(
        { err: error },
        `Error bulk assigning tools to ${bulkAssignLabel}`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Error bulk assigning tools to ${bulkAssignLabel}: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_MCP_SERVERS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, filters: args },
      "get_mcp_servers tool called",
    );

    try {
      // Note: We don't have access to request.user.id in this context,
      // so we'll call findAll without the user ID
      const allServers = await McpServerModel.findAll();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(allServers, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting MCP servers");
      return {
        content: [
          {
            type: "text",
            text: `Error getting MCP servers: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, mcpServerId: args?.mcpServerId },
      "get_mcp_server_tools tool called",
    );

    try {
      const mcpServerId = args?.mcpServerId as string;

      if (!mcpServerId) {
        return {
          content: [
            {
              type: "text",
              text: "Error: mcpServerId parameter is required",
            },
          ],
          isError: true,
        };
      }

      // Get the MCP server first to check if it has a catalogId
      const mcpServer = await McpServerModel.findById(mcpServerId);
      if (!mcpServer) {
        return {
          content: [
            {
              type: "text",
              text: "MCP server not found",
            },
          ],
          isError: true,
        };
      }

      // For catalog-based servers (local installations), query tools by catalogId
      // This ensures all installations of the same catalog show the same tools
      // For legacy servers without catalogId, fall back to mcpServerId
      const tools = mcpServer.catalogId
        ? await ToolModel.findByCatalogId(mcpServer.catalogId)
        : await ToolModel.findByMcpServerId(mcpServerId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(tools, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting MCP server tools");
      return {
        content: [
          {
            type: "text",
            text: `Error getting MCP server tools: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (
    toolName === TOOL_GET_AGENT_FULL_NAME ||
    toolName === TOOL_GET_LLM_PROXY_FULL_NAME ||
    toolName === TOOL_GET_MCP_GATEWAY_FULL_NAME
  ) {
    const getTypeMap: Record<string, string> = {
      [TOOL_GET_AGENT_FULL_NAME]: "agent",
      [TOOL_GET_LLM_PROXY_FULL_NAME]: "llm_proxy",
      [TOOL_GET_MCP_GATEWAY_FULL_NAME]: "mcp_gateway",
    };
    const expectedType = getTypeMap[toolName];
    const getLabel = expectedType.replace("_", " ");

    logger.info(
      { agentId: contextAgent.id, requestedId: args?.id, type: expectedType },
      `get_${expectedType} tool called`,
    );

    try {
      const id = args?.id as string;

      if (!id) {
        return {
          content: [
            {
              type: "text",
              text: "Error: id parameter is required",
            },
          ],
          isError: true,
        };
      }

      const record = await AgentModel.findById(id);
      if (!record) {
        return {
          content: [
            {
              type: "text",
              text: `${getLabel} not found`,
            },
          ],
          isError: true,
        };
      }

      if (record.agentType !== expectedType) {
        return {
          content: [
            {
              type: "text",
              text: `Error: The requested entity is a ${record.agentType}, not a ${expectedType}.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(record, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, `Error getting ${getLabel}`);
      return {
        content: [
          {
            type: "text",
            text: `Error getting ${getLabel}: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_QUERY_KNOWLEDGE_GRAPH_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, queryArgs: args },
      "query_knowledge_graph tool called",
    );

    try {
      const query = args?.query as string;
      const modeArg = args?.mode as string | undefined;

      if (!query || query.trim() === "") {
        return {
          content: [
            {
              type: "text",
              text: "Error: query parameter is required and cannot be empty",
            },
          ],
          isError: true,
        };
      }

      // Validate mode if provided
      let mode: QueryMode = "hybrid";
      if (modeArg) {
        const parseResult = QueryModeSchema.safeParse(modeArg);
        if (!parseResult.success) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Invalid mode "${modeArg}". Must be one of: local, global, hybrid, naive`,
              },
            ],
            isError: true,
          };
        }
        mode = parseResult.data;
      }

      // Get the knowledge graph provider
      const provider = getKnowledgeGraphProvider();
      if (!provider) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Knowledge graph provider is not configured. Please configure the ARCHESTRA_KNOWLEDGE_GRAPH_PROVIDER environment variable.",
            },
          ],
          isError: true,
        };
      }

      logger.info(
        {
          agentId: contextAgent.id,
          agentName: contextAgent.name,
          mode,
        },
        "Querying knowledge graph",
      );

      // Execute the query
      const result = await provider.queryDocument(query, {
        mode,
      });

      if (result.error) {
        return {
          content: [
            {
              type: "text",
              text: `Error querying knowledge graph: ${result.error}`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: result.answer,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error querying knowledge graph");
      return {
        content: [
          {
            type: "text",
            text: `Error querying knowledge graph: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_TODO_WRITE_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, todoArgs: args },
      "todo_write tool called",
    );

    try {
      const todos = args?.todos as
        | Array<{
            id: number;
            content: string;
            status: string;
          }>
        | undefined;

      if (!todos || !Array.isArray(todos)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: todos parameter is required and must be an array",
            },
          ],
          isError: true,
        };
      }

      // For now, just return a success message
      // In the future, this could persist todos to database
      return {
        content: [
          {
            type: "text",
            text: `Successfully wrote ${todos.length} todo item(s) to the conversation`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error writing todos");
      return {
        content: [
          {
            type: "text",
            text: `Error writing todos: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_ARTIFACT_WRITE_FULL_NAME) {
    logger.info(
      { agentId: contextAgent.id, artifactArgs: args, context },
      "artifact_write tool called",
    );

    try {
      const content = args?.content as string | undefined;

      if (!content || typeof content !== "string") {
        return {
          content: [
            {
              type: "text",
              text: "Error: content parameter is required and must be a string",
            },
          ],
          isError: true,
        };
      }

      // Check if we have conversation context
      if (
        !context.conversationId ||
        !context.userId ||
        !context.organizationId
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Error: This tool requires conversation context. It can only be used within an active chat conversation.",
            },
          ],
          isError: true,
        };
      }

      // Update the conversation's artifact
      const updated = await ConversationModel.update(
        context.conversationId,
        context.userId,
        context.organizationId,
        { artifact: content },
      );

      if (!updated) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Failed to update conversation artifact. The conversation may not exist or you may not have permission to update it.",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Successfully updated conversation artifact (${content.length} characters)`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error writing artifact");
      return {
        content: [
          {
            type: "text",
            text: `Error writing artifact: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  // If the tool is not an Archestra tool, throw an error
  throw {
    code: -32601, // Method not found
    message: `Tool '${toolName}' not found`,
  };
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "AbortError") {
    return true;
  }

  return error.message.toLowerCase().includes("abort");
}

/**
 * Get the list of Archestra MCP tools
 */
export function getArchestraMcpTools(): Tool[] {
  return [
    {
      name: TOOL_WHOAMI_FULL_NAME,
      title: "Who Am I",
      description: "Returns the name and ID of the current agent",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME,
      title: "Search Private MCP Registry",
      description:
        "Search the private MCP registry for available MCP servers. Optionally provide a search query to filter results by name or description.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional search query to filter MCP servers by name or description",
          },
        },
        required: [],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_CREATE_LIMIT_FULL_NAME,
      title: "Create Limit",
      description:
        "Create a new cost or usage limit for an organization, team, agent, LLM proxy, or MCP gateway. Supports token_cost, mcp_server_calls, and tool_calls limit types.",
      inputSchema: {
        type: "object",
        properties: {
          entity_type: {
            type: "string",
            enum: ["organization", "team", "agent", "llm_proxy", "mcp_gateway"],
            description: "The type of entity to apply the limit to",
          },
          entity_id: {
            type: "string",
            description:
              "The ID of the entity (organization, team, agent, LLM proxy, or MCP gateway)",
          },
          limit_type: {
            type: "string",
            enum: LimitTypeSchema.options,
            description: "The type of limit to apply",
          },
          limit_value: {
            type: "number",
            description:
              "The limit value (tokens or count depending on limit type)",
          },
          model: {
            type: "array",
            items: {
              type: "string",
            },
            description:
              "Array of model names (required for token_cost limits)",
          },
          mcp_server_name: {
            type: "string",
            description:
              "MCP server name (required for mcp_server_calls and tool_calls limits)",
          },
          tool_name: {
            type: "string",
            description: "Tool name (required for tool_calls limits)",
          },
        },
        required: ["entity_type", "entity_id", "limit_type", "limit_value"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_LIMITS_FULL_NAME,
      title: "Get Limits",
      description:
        "Retrieve all limits, optionally filtered by entity type and/or entity ID.",
      inputSchema: {
        type: "object",
        properties: {
          entity_type: {
            type: "string",
            enum: ["organization", "team", "agent", "llm_proxy", "mcp_gateway"],
            description: "Optional filter by entity type",
          },
          entity_id: {
            type: "string",
            description: "Optional filter by entity ID",
          },
        },
        required: [],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_UPDATE_LIMIT_FULL_NAME,
      title: "Update Limit",
      description: "Update an existing limit's value.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the limit to update",
          },
          limit_value: {
            type: "number",
            description: "The new limit value",
          },
        },
        required: ["id", "limit_value"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_DELETE_LIMIT_FULL_NAME,
      title: "Delete Limit",
      description: "Delete an existing limit by ID.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the limit to delete",
          },
        },
        required: ["id"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME,
      title: "Get Agent Token Usage",
      description:
        "Get the total token usage (input and output) for a specific agent. If no id is provided, returns usage for the current agent.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "The ID of the agent to get usage for (optional, defaults to current agent)",
          },
        },
        required: [],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_LLM_PROXY_TOKEN_USAGE_FULL_NAME,
      title: "Get LLM Proxy Token Usage",
      description:
        "Get the total token usage (input and output) for a specific LLM proxy. If no id is provided, returns usage for the current agent.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description:
              "The ID of the LLM proxy to get usage for (optional, defaults to current agent)",
          },
        },
        required: [],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_CREATE_AGENT_FULL_NAME,
      title: "Create Agent",
      description:
        "Create a new agent with the specified name, optional labels, and optional prompts.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the agent (required)",
          },
          labels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "The label key" },
                value: {
                  type: "string",
                  description: "The value for the label",
                },
              },
              required: ["key", "value"],
            },
            description: "Array of labels to assign to the agent (optional)",
          },
          systemPrompt: {
            type: "string",
            description: "System prompt for the agent (optional)",
          },
          userPrompt: {
            type: "string",
            description: "User prompt for the agent (optional)",
          },
        },
        required: ["name"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_CREATE_LLM_PROXY_FULL_NAME,
      title: "Create LLM Proxy",
      description:
        "Create a new LLM proxy with the specified name and optional labels.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the LLM proxy (required)",
          },
          labels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "The label key" },
                value: {
                  type: "string",
                  description: "The value for the label",
                },
              },
              required: ["key", "value"],
            },
            description:
              "Array of labels to assign to the LLM proxy (optional)",
          },
        },
        required: ["name"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_CREATE_MCP_GATEWAY_FULL_NAME,
      title: "Create MCP Gateway",
      description:
        "Create a new MCP gateway with the specified name and optional labels.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the MCP gateway (required)",
          },
          labels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "The label key" },
                value: {
                  type: "string",
                  description: "The value for the label",
                },
              },
              required: ["key", "value"],
            },
            description:
              "Array of labels to assign to the MCP gateway (optional)",
          },
        },
        required: ["name"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_AUTONOMY_POLICY_OPERATORS_FULL_NAME,
      title: "Get Autonomy Policy Operators",
      description:
        "Get all supported policy operators with their human-readable labels",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME,
      title: "Get Tool Invocation Policies",
      description: "Get all tool invocation policies",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME,
      title: "Create Tool Invocation Policy",
      description: "Create a new tool invocation policy",
      inputSchema: {
        type: "object",
        properties: {
          toolId: {
            type: "string",
            description: "The ID of the tool (UUID from the tools table)",
          },
          conditions: {
            type: "array",
            description:
              "Array of conditions that must all match (AND logic). Empty array means unconditional.",
            items: {
              type: "object",
              properties: {
                key: {
                  type: "string",
                  description:
                    "The argument name or context path to evaluate (e.g., 'url', 'context.externalAgentId')",
                },
                operator: {
                  type: "string",
                  enum: [
                    "equal",
                    "notEqual",
                    "contains",
                    "notContains",
                    "startsWith",
                    "endsWith",
                    "regex",
                  ],
                },
                value: {
                  type: "string",
                  description: "The value to compare against",
                },
              },
              required: ["key", "operator", "value"],
            },
          },
          action: {
            type: "string",
            enum: [
              "allow_when_context_is_untrusted",
              "block_when_context_is_untrusted",
              "block_always",
            ],
            description: "The action to take when the policy matches",
          },
          reason: {
            type: "string",
            description:
              "Human-readable explanation for why this policy exists",
          },
        },
        required: ["toolId", "conditions", "action"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_TOOL_INVOCATION_POLICY_FULL_NAME,
      title: "Get Tool Invocation Policy",
      description: "Get a specific tool invocation policy by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the tool invocation policy",
          },
        },
        required: ["id"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_UPDATE_TOOL_INVOCATION_POLICY_FULL_NAME,
      title: "Update Tool Invocation Policy",
      description: "Update a tool invocation policy",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the tool invocation policy to update",
          },
          toolId: {
            type: "string",
            description: "The ID of the tool (UUID from the tools table)",
          },
          conditions: {
            type: "array",
            description:
              "Array of conditions that must all match (AND logic). Empty array means unconditional.",
            items: {
              type: "object",
              properties: {
                key: {
                  type: "string",
                  description:
                    "The argument name or context path to evaluate (e.g., 'url', 'context.externalAgentId')",
                },
                operator: {
                  type: "string",
                  enum: [
                    "equal",
                    "notEqual",
                    "contains",
                    "notContains",
                    "startsWith",
                    "endsWith",
                    "regex",
                  ],
                },
                value: {
                  type: "string",
                  description: "The value to compare against",
                },
              },
              required: ["key", "operator", "value"],
            },
          },
          action: {
            type: "string",
            enum: [
              "allow_when_context_is_untrusted",
              "block_when_context_is_untrusted",
              "block_always",
            ],
            description: "The action to take when the policy matches",
          },
          reason: {
            type: "string",
            description:
              "Human-readable explanation for why this policy exists",
          },
        },
        required: ["id"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_DELETE_TOOL_INVOCATION_POLICY_FULL_NAME,
      title: "Delete Tool Invocation Policy",
      description: "Delete a tool invocation policy by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the tool invocation policy",
          },
        },
        required: ["id"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_TRUSTED_DATA_POLICIES_FULL_NAME,
      title: "Get Trusted Data Policies",
      description: "Get all trusted data policies",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_CREATE_TRUSTED_DATA_POLICY_FULL_NAME,
      title: "Create Trusted Data Policy",
      description: "Create a new trusted data policy",
      inputSchema: {
        type: "object",
        properties: {
          toolId: {
            type: "string",
            description: "The ID of the tool (UUID from the tools table)",
          },
          conditions: {
            type: "array",
            description:
              "Array of conditions that must all match (AND logic). Empty array means unconditional.",
            items: {
              type: "object",
              properties: {
                key: {
                  type: "string",
                  description:
                    "The attribute key or path in the tool result to evaluate (e.g., 'emails[*].from', 'source')",
                },
                operator: {
                  type: "string",
                  enum: [
                    "equal",
                    "notEqual",
                    "contains",
                    "notContains",
                    "startsWith",
                    "endsWith",
                    "regex",
                  ],
                },
                value: {
                  type: "string",
                  description: "The value to compare against",
                },
              },
              required: ["key", "operator", "value"],
            },
          },
          action: {
            type: "string",
            enum: [
              "block_always",
              "mark_as_trusted",
              "mark_as_untrusted",
              "sanitize_with_dual_llm",
            ],
            description: "The action to take when the policy matches",
          },
          description: {
            type: "string",
            description:
              "Human-readable explanation for why this policy exists",
          },
        },
        required: ["toolId", "conditions", "action"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_TRUSTED_DATA_POLICY_FULL_NAME,
      title: "Get Trusted Data Policy",
      description: "Get a specific trusted data policy by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the trusted data policy",
          },
        },
        required: ["id"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_UPDATE_TRUSTED_DATA_POLICY_FULL_NAME,
      title: "Update Trusted Data Policy",
      description: "Update a trusted data policy",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the trusted data policy to update",
          },
          toolId: {
            type: "string",
            description: "The ID of the tool (UUID from the tools table)",
          },
          conditions: {
            type: "array",
            description:
              "Array of conditions that must all match (AND logic). Empty array means unconditional.",
            items: {
              type: "object",
              properties: {
                key: {
                  type: "string",
                  description:
                    "The attribute key or path in the tool result to evaluate (e.g., 'emails[*].from', 'source')",
                },
                operator: {
                  type: "string",
                  enum: [
                    "equal",
                    "notEqual",
                    "contains",
                    "notContains",
                    "startsWith",
                    "endsWith",
                    "regex",
                  ],
                },
                value: {
                  type: "string",
                  description: "The value to compare against",
                },
              },
              required: ["key", "operator", "value"],
            },
          },
          action: {
            type: "string",
            enum: [
              "block_always",
              "mark_as_trusted",
              "mark_as_untrusted",
              "sanitize_with_dual_llm",
            ],
            description: "The action to take when the policy matches",
          },
          description: {
            type: "string",
            description:
              "Human-readable explanation for why this policy exists",
          },
        },
        required: ["id"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME,
      title: "Delete Trusted Data Policy",
      description: "Delete a trusted data policy by ID",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the trusted data policy",
          },
        },
        required: ["id"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME,
      title: "Bulk Assign Tools to Agents",
      description:
        "Assign multiple tools to multiple agents in bulk with validation and error handling",
      inputSchema: {
        type: "object",
        properties: {
          assignments: {
            type: "array",
            description: "Array of tool assignments to create",
            items: {
              type: "object",
              properties: {
                agentId: {
                  type: "string",
                  description: "The ID of the agent to assign the tool to",
                },
                toolId: {
                  type: "string",
                  description: "The ID of the tool to assign",
                },
                credentialSourceMcpServerId: {
                  type: "string",
                  description:
                    "Optional ID of the MCP server to use as credential source",
                },
                executionSourceMcpServerId: {
                  type: "string",
                  description:
                    "Optional ID of the MCP server to use as execution source",
                },
              },
              required: ["agentId", "toolId"],
            },
          },
        },
        required: ["assignments"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_BULK_ASSIGN_TOOLS_TO_MCP_GATEWAYS_FULL_NAME,
      title: "Bulk Assign Tools to MCP Gateways",
      description:
        "Assign multiple tools to multiple MCP gateways in bulk with validation and error handling",
      inputSchema: {
        type: "object",
        properties: {
          assignments: {
            type: "array",
            description: "Array of tool assignments to create",
            items: {
              type: "object",
              properties: {
                mcpGatewayId: {
                  type: "string",
                  description:
                    "The ID of the MCP gateway to assign the tool to",
                },
                toolId: {
                  type: "string",
                  description: "The ID of the tool to assign",
                },
                credentialSourceMcpServerId: {
                  type: "string",
                  description:
                    "Optional ID of the MCP server to use as credential source",
                },
                executionSourceMcpServerId: {
                  type: "string",
                  description:
                    "Optional ID of the MCP server to use as execution source",
                },
              },
              required: ["mcpGatewayId", "toolId"],
            },
          },
        },
        required: ["assignments"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_MCP_SERVERS_FULL_NAME,
      title: "Get MCP Servers",
      description: "List all installed MCP servers with their catalog names",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME,
      title: "Get MCP Server Tools",
      description: "Get all tools available for a specific MCP server",
      inputSchema: {
        type: "object",
        properties: {
          mcpServerId: {
            type: "string",
            description: "The ID of the MCP server to get tools for",
          },
        },
        required: ["mcpServerId"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_AGENT_FULL_NAME,
      title: "Get Agent",
      description:
        "Get a specific agent by ID with full details including labels and team assignments",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the agent to retrieve",
          },
        },
        required: ["id"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_LLM_PROXY_FULL_NAME,
      title: "Get LLM Proxy",
      description:
        "Get a specific LLM proxy by ID with full details including labels and team assignments",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the LLM proxy to retrieve",
          },
        },
        required: ["id"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_GET_MCP_GATEWAY_FULL_NAME,
      title: "Get MCP Gateway",
      description:
        "Get a specific MCP gateway by ID with full details including labels and team assignments",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the MCP gateway to retrieve",
          },
        },
        required: ["id"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_QUERY_KNOWLEDGE_GRAPH_FULL_NAME,
      title: "Query Knowledge Graph",
      description:
        "Query the organization's knowledge graph to retrieve information from uploaded documents. Uses graph-based retrieval augmented generation (GraphRAG) for accurate and contextual results.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The natural language query to search the knowledge graph",
          },
          mode: {
            type: "string",
            enum: ["local", "global", "hybrid", "naive"],
            description:
              "Query mode: 'local' uses only local context, 'global' uses global context across all documents, 'hybrid' combines both (recommended), 'naive' uses simple RAG without graph-based retrieval. Defaults to 'hybrid'.",
          },
        },
        required: ["query"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME,
      title: "Create MCP Server Installation Request",
      description:
        "Allows users from within the Archestra Platform chat UI to submit a request for an MCP server to be added to their Archestra Platform's internal MCP server registry. This will open a dialog for the user to submit an installation request. When you trigger this tool, just tell the user to go through the dialog to submit the request. Do not provider any additional information",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_TODO_WRITE_FULL_NAME,
      title: "Write Todos",
      description:
        "Write todos to the current conversation. You have access to this tool to help you manage and plan tasks. Use it VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress. This tool is also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use this tool when planning, you may forget to do important tasks - and that is unacceptable. It is critical that you mark todos as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.",
      inputSchema: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "Array of todo items to write to the conversation",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "integer",
                  description: "Unique identifier for the todo item",
                },
                content: {
                  type: "string",
                  description: "The content/description of the todo item",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "The current status of the todo item",
                },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
      },
      annotations: {},
      _meta: {},
    },
    {
      name: TOOL_ARTIFACT_WRITE_FULL_NAME,
      title: "Write Artifact",
      description:
        "Write or update a markdown artifact for the current conversation. Use this tool to maintain a persistent document that evolves throughout the conversation. The artifact should contain well-structured markdown content that can be referenced and updated as the conversation progresses. Each call to this tool completely replaces the existing artifact content. " +
        "Mermaid diagrams: Use ```mermaid blocks. " +
        "Supports: Headers, emphasis, lists, links, images, code blocks, tables, blockquotes, task lists, mermaid diagrams.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The markdown content to write to the conversation artifact. This will completely replace any existing artifact content.",
          },
        },
        required: ["content"],
      },
      annotations: {},
      _meta: {},
    },
  ];
}

/**
 * Get agent delegation tools for an agent from the database
 * Each configured delegation becomes a separate tool (e.g., delegate_to_research_bot)
 * Note: Agent tools are separate from Archestra tools - they enable agent-to-agent delegation
 */
export async function getAgentTools(context: {
  agentId: string;
  organizationId: string;
  userId?: string;
  /** Skip user access check (for A2A/ChatOps flows where caller has elevated permissions) */
  skipAccessCheck?: boolean;
}): Promise<Tool[]> {
  const { agentId, organizationId, userId, skipAccessCheck } = context;

  // Get all delegation tools assigned to this agent
  const allToolsWithDetails =
    await ToolModel.getDelegationToolsByAgent(agentId);

  // Filter by user access if user ID is provided (skip for A2A/ChatOps flows)
  let accessibleTools = allToolsWithDetails;
  if (userId && !skipAccessCheck) {
    // Check if user has profile admin permission directly (don't trust caller)
    const isAgentAdmin = await userHasPermission(
      userId,
      organizationId,
      "profile",
      "admin",
    );

    const userAccessibleAgentIds =
      await AgentTeamModel.getUserAccessibleAgentIds(userId, isAgentAdmin);
    accessibleTools = allToolsWithDetails.filter((t) =>
      userAccessibleAgentIds.includes(t.targetAgent.id),
    );
  }

  logger.debug(
    {
      agentId,
      organizationId,
      userId,
      allToolCount: allToolsWithDetails.length,
      accessibleToolCount: accessibleTools.length,
    },
    "Fetched agent delegation tools from database",
  );

  // Convert DB tools to MCP Tool format
  return accessibleTools.map((t) => {
    const description = t.targetAgent.description
      ? `Delegate task to agent: ${t.targetAgent.name}. ${t.targetAgent.description.substring(0, 400)}`
      : `Delegate task to agent: ${t.targetAgent.name}`;

    return {
      name: t.tool.name,
      title: t.targetAgent.name,
      description,
      inputSchema: t.tool.parameters as Tool["inputSchema"],
      annotations: {},
      _meta: { targetAgentId: t.targetAgent.id },
    };
  });
}
