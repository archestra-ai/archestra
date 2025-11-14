import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import logger from "@/logging";
import {
  AgentModel,
  InternalMcpCatalogModel,
  LimitModel,
  McpServerModel,
  ToolInvocationPolicyModel,
  ToolModel,
  TrustedDataPolicyModel,
} from "@/models";
import { assignToolToAgent } from "@/routes/agent-tool";
import type { Agent, InternalMcpCatalog } from "@/types";
import {
  AutonomyPolicyOperator,
  type ToolInvocation,
  type TrustedData,
} from "@/types";

/**
 * Constants for Archestra MCP server
 */
export const MCP_SERVER_NAME = "archestra";
const TOOL_WHOAMI_NAME = "whoami";
const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME = "search_private_mcp_registry";
const TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_NAME =
  "create_mcp_server_installation_request";
const TOOL_CREATE_LIMIT_NAME = "create_limit";
const TOOL_GET_LIMITS_NAME = "get_limits";
const TOOL_UPDATE_LIMIT_NAME = "update_limit";
const TOOL_DELETE_LIMIT_NAME = "delete_limit";
const TOOL_GET_AGENT_TOKEN_USAGE_NAME = "get_agent_token_usage";
const TOOL_CREATE_AGENT_NAME = "create_agent";
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
const TOOL_GET_MCP_SERVERS_NAME = "get_mcp_servers";
const TOOL_GET_MCP_SERVER_TOOLS_NAME = "get_mcp_server_tools";
const TOOL_GET_AGENT_NAME = "get_agent";

// Construct fully-qualified tool names
const TOOL_WHOAMI_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_WHOAMI_NAME}`;
const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME}`;
const _TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_NAME}`;
const TOOL_CREATE_LIMIT_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_LIMIT_NAME}`;
const TOOL_GET_LIMITS_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_LIMITS_NAME}`;
const TOOL_UPDATE_LIMIT_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_UPDATE_LIMIT_NAME}`;
const TOOL_DELETE_LIMIT_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_DELETE_LIMIT_NAME}`;
const TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_AGENT_TOKEN_USAGE_NAME}`;
const TOOL_CREATE_AGENT_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_AGENT_NAME}`;
const TOOL_GET_AUTONOMY_POLICY_OPERATORS_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_AUTONOMY_POLICY_OPERATORS_NAME}`;
const TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TOOL_INVOCATION_POLICIES_NAME}`;
const TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_GET_TOOL_INVOCATION_POLICY_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_UPDATE_TOOL_INVOCATION_POLICY_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_UPDATE_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_DELETE_TOOL_INVOCATION_POLICY_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_DELETE_TOOL_INVOCATION_POLICY_NAME}`;
const TOOL_GET_TRUSTED_DATA_POLICIES_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TRUSTED_DATA_POLICIES_NAME}`;
const TOOL_CREATE_TRUSTED_DATA_POLICY_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_TRUSTED_DATA_POLICY_NAME}`;
const TOOL_GET_TRUSTED_DATA_POLICY_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_TRUSTED_DATA_POLICY_NAME}`;
const TOOL_UPDATE_TRUSTED_DATA_POLICY_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_UPDATE_TRUSTED_DATA_POLICY_NAME}`;
const TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_DELETE_TRUSTED_DATA_POLICY_NAME}`;
const TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_NAME}`;
const TOOL_GET_MCP_SERVERS_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_SERVERS_NAME}`;
const TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_SERVER_TOOLS_NAME}`;
const TOOL_GET_AGENT_FULL_NAME = `${MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_AGENT_NAME}`;

/**
 * Context for the Archestra MCP server
 */
export interface ArchestraContext {
  agent: Agent;
}

/**
 * Execute an Archestra MCP tool
 */
export async function executeArchestraTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { agent } = context;

  if (toolName === TOOL_WHOAMI_FULL_NAME) {
    logger.info(
      { agentId: agent.id, agentName: agent.name },
      "whoami tool called",
    );

    return {
      content: [
        {
          type: "text",
          text: `Agent Name: ${agent.name}\nAgent ID: ${agent.id}`,
        },
      ],
      isError: false,
    };
  }

  if (toolName === TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME) {
    logger.info(
      { agentId: agent.id, searchArgs: args },
      "search_private_mcp_registry tool called",
    );

    try {
      const query = args?.query as string | undefined;

      let catalogItems: InternalMcpCatalog[];

      if (query && query.trim() !== "") {
        // Search by name or description
        catalogItems = await InternalMcpCatalogModel.searchByQuery(query);
      } else {
        // Return all catalog items
        catalogItems = await InternalMcpCatalogModel.findAll();
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

  if (toolName === TOOL_CREATE_AGENT_FULL_NAME) {
    logger.info(
      { agentId: agent.id, createArgs: args },
      "create_agent tool called",
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
              text: "Error: Agent name is required and cannot be empty.",
            },
          ],
          isError: true,
        };
      }

      // Create the agent
      const newAgent = await AgentModel.create({
        name,
        teams,
        labels,
      });

      return {
        content: [
          {
            type: "text",
            text: `Successfully created agent.\n\nAgent Name: ${
              newAgent.name
            }\nAgent ID: ${newAgent.id}\nTeams: ${
              newAgent.teams.length > 0 ? newAgent.teams.join(", ") : "None"
            }\nLabels: ${
              newAgent.labels.length > 0
                ? newAgent.labels.map((l) => `${l.key}: ${l.value}`).join(", ")
                : "None"
            }`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error creating agent");
      return {
        content: [
          {
            type: "text",
            text: `Error creating agent: ${
              error instanceof Error ? error.message : "Unknown error"
            }`,
          },
        ],
        isError: true,
      };
    }
  }

  /**
   * TODO: Currently there is no user available in the mcp-gateway context. In order to be able to create
   * an MCP server installation request, we'd either need to have an explicit user, create a "fake archestra mcp server" user
   * (probably a bad idea), or modify McpServerInstallationRequestModel such that createdBy is renamed to createdByUser
   * (and can be null) + we add createdByAgent
   */
  /*
  if (toolName === TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME) {
    logger.info(
      { agentId: agent.id, requestArgs: args },
      "create_mcp_server_installation_request tool called",
    );

    try {
      const externalCatalogId = args?.external_catalog_id as string | undefined;
      const requestReason = args?.request_reason as string | undefined;
      const customServerConfig = args?.custom_server_config as
        | InsertMcpServerInstallationRequest["customServerConfig"]
        | undefined;

      // Validate that either externalCatalogId or customServerConfig is provided
      if (!externalCatalogId && !customServerConfig) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Either external_catalog_id or custom_server_config must be provided.",
            },
          ],
          isError: true,
        };
      }

      // Check if there's already a pending request for this external catalog ID
      if (externalCatalogId) {
        const existingRequest =
          await McpServerInstallationRequestModel.findPendingByExternalCatalogId(
            externalCatalogId,
          );
        if (existingRequest) {
          return {
            content: [
              {
                type: "text",
                text: `A pending installation request already exists for this MCP server (Request ID: ${existingRequest.id}). Please wait for it to be reviewed.`,
              },
            ],
            isError: false,
          };
        }
      }

      // Create the installation request
      const installationRequest =
        await McpServerInstallationRequestModel.create({
          externalCatalogId: externalCatalogId || null,
          requestedBy: userId, // This would need to be changed as per TODO above
          requestReason: requestReason || null,
          customServerConfig: customServerConfig || null,
          status: "pending",
        });

      return {
        content: [
          {
            type: "text",
            text: `Successfully created MCP server installation request.\n\nRequest ID: ${installationRequest.id}\nStatus: ${installationRequest.status}\n\nYour request will be reviewed by an administrator.`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error(
        { err: error },
        "Error creating MCP server installation request",
      );
      return {
        content: [
          {
            type: "text",
            text: `Error creating installation request: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }
  */

  if (toolName === TOOL_CREATE_LIMIT_FULL_NAME) {
    logger.info(
      { agentId: agent.id, createLimitArgs: args },
      "create_limit tool called",
    );

    try {
      const entityType = args?.entity_type as "organization" | "team" | "agent";
      const entityId = args?.entity_id as string;
      const limitType = args?.limit_type as
        | "token_cost"
        | "mcp_server_calls"
        | "tool_calls";
      const limitValue = args?.limit_value as number;
      const model = args?.model as string | undefined;
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
      if (limitType === "token_cost" && !model) {
        return {
          content: [
            {
              type: "text",
              text: "Error: model is required for token_cost limits.",
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
            text: `Successfully created limit.\n\nLimit ID: ${limit.id}\nEntity Type: ${limit.entityType}\nEntity ID: ${limit.entityId}\nLimit Type: ${limit.limitType}\nLimit Value: ${limit.limitValue}${limit.model ? `\nModel: ${limit.model}` : ""}${limit.mcpServerName ? `\nMCP Server: ${limit.mcpServerName}` : ""}${limit.toolName ? `\nTool: ${limit.toolName}` : ""}`,
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
            text: `Error creating limit: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_LIMITS_FULL_NAME) {
    logger.info(
      { agentId: agent.id, getLimitsArgs: args },
      "get_limits tool called",
    );

    try {
      const entityType = args?.entity_type as
        | "organization"
        | "team"
        | "agent"
        | undefined;
      const entityId = args?.entity_id as string | undefined;

      const limits = await LimitModel.findAll(entityType, entityId);

      if (limits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                entityType || entityId
                  ? `No limits found${entityType ? ` for entity type: ${entityType}` : ""}${entityId ? ` and entity ID: ${entityId}` : ""}.`
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
          result += `\n  Current Usage (In): ${limit.currentUsageTokensIn}`;
          result += `\n  Current Usage (Out): ${limit.currentUsageTokensOut}`;
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
            text: `Error getting limits: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_UPDATE_LIMIT_FULL_NAME) {
    logger.info(
      { agentId: agent.id, updateLimitArgs: args },
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
            text: `Error updating limit: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_DELETE_LIMIT_FULL_NAME) {
    logger.info(
      { agentId: agent.id, deleteLimitArgs: args },
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
            text: `Error deleting limit: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME) {
    logger.info(
      { agentId: agent.id, getTokenUsageArgs: args },
      "get_agent_token_usage tool called",
    );

    try {
      const targetAgentId = (args?.agent_id as string) || agent.id;

      const usage = await LimitModel.getAgentTokenUsage(targetAgentId);

      return {
        content: [
          {
            type: "text",
            text: `Token usage for agent ${targetAgentId}:\n\nTotal Input Tokens: ${usage.totalInputTokens.toLocaleString()}\nTotal Output Tokens: ${usage.totalOutputTokens.toLocaleString()}\nTotal Tokens: ${usage.totalTokens.toLocaleString()}`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting agent token usage");
      return {
        content: [
          {
            type: "text",
            text: `Error getting agent token usage: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_AUTONOMY_POLICY_OPERATORS_FULL_NAME) {
    logger.info(
      { agentId: agent.id },
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
            text: `Error getting autonomy policy operators: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_TOOL_INVOCATION_POLICIES_FULL_NAME) {
    logger.info(
      { agentId: agent.id },
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
            text: `Error getting tool invocation policies: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_CREATE_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: agent.id, createArgs: args },
      "create_tool_invocation_policy tool called",
    );

    try {
      const policy = await ToolInvocationPolicyModel.create(
        args as ToolInvocation.InsertToolInvocationPolicy,
      );
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
            text: `Error creating tool invocation policy: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: agent.id, policyId: args?.id },
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
            text: `Error getting tool invocation policy: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_UPDATE_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: agent.id, updateArgs: args },
      "update_tool_invocation_policy tool called",
    );

    try {
      const { id, ...updateData } = args as {
        id: string;
      } & Partial<ToolInvocation.InsertToolInvocationPolicy>;
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
            text: `Error updating tool invocation policy: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_DELETE_TOOL_INVOCATION_POLICY_FULL_NAME) {
    logger.info(
      { agentId: agent.id, policyId: args?.id },
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
            text: `Error deleting tool invocation policy: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_TRUSTED_DATA_POLICIES_FULL_NAME) {
    logger.info({ agentId: agent.id }, "get_trusted_data_policies tool called");

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
            text: `Error getting trusted data policies: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_CREATE_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: agent.id, createArgs: args },
      "create_trusted_data_policy tool called",
    );

    try {
      const policy = await TrustedDataPolicyModel.create(
        args as TrustedData.InsertTrustedDataPolicy,
      );
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
            text: `Error creating trusted data policy: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: agent.id, policyId: args?.id },
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
            text: `Error getting trusted data policy: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_UPDATE_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: agent.id, updateArgs: args },
      "update_trusted_data_policy tool called",
    );

    try {
      const { id, ...updateData } = args as {
        id: string;
      } & Partial<TrustedData.InsertTrustedDataPolicy>;
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
            text: `Error updating trusted data policy: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_DELETE_TRUSTED_DATA_POLICY_FULL_NAME) {
    logger.info(
      { agentId: agent.id, policyId: args?.id },
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
            text: `Error deleting trusted data policy: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_BULK_ASSIGN_TOOLS_TO_AGENTS_FULL_NAME) {
    logger.info(
      { agentId: agent.id, assignments: args?.assignments },
      "bulk_assign_tools_to_agents tool called",
    );

    try {
      const assignments = args?.assignments as Array<{
        agentId: string;
        toolId: string;
        credentialSourceMcpServerId?: string | null;
        executionSourceMcpServerId?: string | null;
      }>;

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
            assignment.agentId,
            assignment.toolId,
            assignment.credentialSourceMcpServerId,
            assignment.executionSourceMcpServerId,
          ),
        ),
      );

      const succeeded: { agentId: string; toolId: string }[] = [];
      const failed: { agentId: string; toolId: string; error: string }[] = [];
      const duplicates: { agentId: string; toolId: string }[] = [];

      results.forEach((result, index) => {
        const { agentId, toolId } = assignments[index];
        if (result.status === "fulfilled") {
          if (result.value === null || result.value === "updated") {
            // Success (created or updated)
            succeeded.push({ agentId, toolId });
          } else if (result.value === "duplicate") {
            // Already assigned with same credentials
            duplicates.push({ agentId, toolId });
          } else {
            // Validation error
            const error = result.value.error.message || "Unknown error";
            failed.push({ agentId, toolId, error });
          }
        } else if (result.status === "rejected") {
          // Runtime error
          const error =
            result.reason instanceof Error
              ? result.reason.message
              : "Unknown error";
          failed.push({ agentId, toolId, error });
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
      logger.error({ err: error }, "Error bulk assigning tools to agents");
      return {
        content: [
          {
            type: "text",
            text: `Error bulk assigning tools to agents: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_MCP_SERVERS_FULL_NAME) {
    logger.info(
      { agentId: agent.id, filters: args },
      "get_mcp_servers tool called",
    );

    try {
      // Note: We don't have access to request.user.id in this context,
      // so we'll use the agent's context or a placeholder for now
      const authType = args?.authType as "personal" | "team" | undefined;

      // For now, we'll call findAll without the user ID and filter logic
      // This might need to be adjusted based on the actual requirements
      const allServers = await McpServerModel.findAll();

      // Filter by authType if provided
      const filteredServers = authType
        ? allServers.filter((server) => server.authType === authType)
        : allServers;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(filteredServers, null, 2),
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
            text: `Error getting MCP servers: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME) {
    logger.info(
      { agentId: agent.id, mcpServerId: args?.mcpServerId },
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
            text: `Error getting MCP server tools: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (toolName === TOOL_GET_AGENT_FULL_NAME) {
    logger.info(
      { agentId: agent.id, requestedAgentId: args?.id },
      "get_agent tool called",
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

      const requestedAgent = await AgentModel.findById(id);
      if (!requestedAgent) {
        return {
          content: [
            {
              type: "text",
              text: "Agent not found",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(requestedAgent, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting agent");
      return {
        content: [
          {
            type: "text",
            text: `Error getting agent: ${error instanceof Error ? error.message : "Unknown error"}`,
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
        "Create a new cost or usage limit for an organization, team, or agent. Supports token_cost, mcp_server_calls, and tool_calls limit types.",
      inputSchema: {
        type: "object",
        properties: {
          entity_type: {
            type: "string",
            enum: ["organization", "team", "agent"],
            description: "The type of entity to apply the limit to",
          },
          entity_id: {
            type: "string",
            description: "The ID of the entity (organization, team, or agent)",
          },
          limit_type: {
            type: "string",
            enum: ["token_cost", "mcp_server_calls", "tool_calls"],
            description: "The type of limit to apply",
          },
          limit_value: {
            type: "number",
            description:
              "The limit value (tokens or count depending on limit type)",
          },
          model: {
            type: "string",
            description: "Model name (required for token_cost limits)",
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
            enum: ["organization", "team", "agent"],
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
        "Get the total token usage (input and output) for a specific agent. If no agent_id is provided, returns usage for the current agent.",
      inputSchema: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description:
              "The ID of the agent to get usage for (optional, defaults to current agent)",
          },
        },
        required: [],
      },
    },
    {
      name: TOOL_CREATE_AGENT_FULL_NAME,
      title: "Create Agent",
      description:
        "Create a new agent with the specified name and optional configuration. The agent will be automatically assigned Archestra built-in tools.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the agent (required)",
          },
          /**
           * TODO: in order to enable this we need to expose GET/CREATE /api/teams tools such that the agent
           * is able to fetch (or create) teams and get their ids (uuids).. otherwise it will try passing in
           * team names (which is not currently supported).. or we support passing in team names..
           */
          // teams: {
          //   type: "array",
          //   items: {
          //     type: "string",
          //   },
          //   description: "Array of team IDs to assign the agent to (optional)",
          // },
          labels: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: {
                  type: "string",
                  description: "The label key",
                },
                value: {
                  type: "string",
                  description: "The value for the label",
                },
              },
              required: ["key", "value"],
            },
            description: "Array of labels to assign to the agent (optional)",
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
          agentToolId: {
            type: "string",
            description: "The ID of the agent tool this policy applies to",
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
            description: "The comparison operator to use",
          },
          path: {
            type: "string",
            description:
              "The path in the context to evaluate (e.g., 'user.email')",
          },
          value: {
            type: "string",
            description: "The value to compare against",
          },
          action: {
            type: "string",
            enum: ["allow_when_context_is_untrusted", "block_always"],
            description: "The action to take when the policy matches",
          },
        },
        required: ["agentToolId", "operator", "path", "value", "action"],
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
            description: "The ID of the tool invocation policy",
          },
          agentToolId: {
            type: "string",
            description: "The ID of the agent tool this policy applies to",
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
            description: "The comparison operator to use",
          },
          path: {
            type: "string",
            description: "The path in the context to evaluate",
          },
          value: {
            type: "string",
            description: "The value to compare against",
          },
          action: {
            type: "string",
            enum: ["allow_when_context_is_untrusted", "block_always"],
            description: "The action to take when the policy matches",
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
          agentToolId: {
            type: "string",
            description: "The ID of the agent tool this policy applies to",
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
            description: "The comparison operator to use",
          },
          path: {
            type: "string",
            description: "The path in the tool result to evaluate",
          },
          value: {
            type: "string",
            description: "The value to compare against",
          },
          action: {
            type: "string",
            enum: ["block_always", "mark_as_trusted", "sanitize_with_dual_llm"],
            description: "The action to take when the policy matches",
          },
        },
        required: ["agentToolId", "operator", "path", "value", "action"],
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
            description: "The ID of the trusted data policy",
          },
          agentToolId: {
            type: "string",
            description: "The ID of the agent tool this policy applies to",
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
            description: "The comparison operator to use",
          },
          path: {
            type: "string",
            description: "The path in the tool result to evaluate",
          },
          value: {
            type: "string",
            description: "The value to compare against",
          },
          action: {
            type: "string",
            enum: ["block_always", "mark_as_trusted", "sanitize_with_dual_llm"],
            description: "The action to take when the policy matches",
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
      name: TOOL_GET_MCP_SERVERS_FULL_NAME,
      title: "Get MCP Servers",
      description:
        "List all installed MCP servers with their catalog names and optional filtering",
      inputSchema: {
        type: "object",
        properties: {
          authType: {
            type: "string",
            enum: ["personal", "team"],
            description:
              "Optional filter to only return servers of a specific authentication type",
          },
        },
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
    // TODO: MCP server installation request tool is temporarily disabled until user context is available
    // {
    //   name: TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME,
    //   title: "Create MCP Server Installation Request",
    //   description:
    //     "Create a request to install an MCP server. Provide either an external_catalog_id for a server from the public catalog, or custom_server_config for a custom server configuration.",
    //   inputSchema: {
    //     type: "object",
    //     properties: {
    //       external_catalog_id: {
    //         type: "string",
    //         description:
    //           "The ID of the MCP server from the external catalog (optional if custom_server_config is provided)",
    //       },
    //       request_reason: {
    //         type: "string",
    //         description:
    //           "Reason for requesting the installation (optional but recommended)",
    //       },
    //       custom_server_config: {
    //         type: "object",
    //         description:
    //           "Custom server configuration (optional if external_catalog_id is provided)",
    //         properties: {
    //           type: {
    //             type: "string",
    //             enum: ["remote", "local"],
    //             description: "The type of the custom server",
    //           },
    //           label: {
    //             type: "string",
    //             description: "A label for the custom server",
    //           },
    //           name: {
    //             type: "string",
    //             description: "The name of the custom server",
    //           },
    //           version: {
    //             type: "string",
    //             description: "The version of the custom server (optional)",
    //           },
    //         },
    //         required: ["type", "label", "name"],
    //       },
    //     },
    //     required: [],
    //   },
    //   annotations: {},
    //   _meta: {},
    // },
  ];
}
