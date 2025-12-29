import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
  TOOL_CREATE_MCP_SERVER_INSTALLATION_REQUEST_FULL_NAME,
} from "@shared";
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
import type { InternalMcpCatalog } from "@/types";
import {
  AutonomyPolicyOperator,
  type LimitEntityType,
  type LimitType,
  LimitTypeSchema,
  type ToolInvocation,
  type TrustedData,
} from "@/types";

/**
 * Constants for Archestra MCP server
 */
const TOOL_WHOAMI_NAME = "whoami";
const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME = "search_private_mcp_registry";
const TOOL_CREATE_LIMIT_NAME = "create_limit";
const TOOL_GET_LIMITS_NAME = "get_limits";
const TOOL_UPDATE_LIMIT_NAME = "update_limit";
const TOOL_DELETE_LIMIT_NAME = "delete_limit";
const TOOL_GET_PROFILE_TOKEN_USAGE_NAME = "get_profile_token_usage";
const TOOL_CREATE_PROFILE_NAME = "create_profile";
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
const TOOL_BULK_ASSIGN_TOOLS_TO_PROFILES_NAME = "bulk_assign_tools_to_profiles";
const TOOL_GET_MCP_SERVERS_NAME = "get_mcp_servers";
const TOOL_GET_MCP_SERVER_TOOLS_NAME = "get_mcp_server_tools";
const TOOL_GET_PROFILE_NAME = "get_profile";

// Construct fully-qualified tool names
const TOOL_WHOAMI_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_WHOAMI_NAME}`;
const TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_SEARCH_PRIVATE_MCP_REGISTRY_NAME}`;
const TOOL_CREATE_LIMIT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_LIMIT_NAME}`;
const TOOL_GET_LIMITS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_LIMITS_NAME}`;
const TOOL_UPDATE_LIMIT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_UPDATE_LIMIT_NAME}`;
const TOOL_DELETE_LIMIT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_DELETE_LIMIT_NAME}`;
const TOOL_GET_PROFILE_TOKEN_USAGE_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_PROFILE_TOKEN_USAGE_NAME}`;
const TOOL_CREATE_PROFILE_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_PROFILE_NAME}`;
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
const TOOL_BULK_ASSIGN_TOOLS_TO_PROFILES_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_BULK_ASSIGN_TOOLS_TO_PROFILES_NAME}`;
const TOOL_GET_MCP_SERVERS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_SERVERS_NAME}`;
const TOOL_GET_MCP_SERVER_TOOLS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_MCP_SERVER_TOOLS_NAME}`;
const TOOL_GET_PROFILE_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_PROFILE_NAME}`;

/**
 * Context for the Archestra MCP server
 */
export interface ArchestraContext {
  profile: {
    id: string;
    name: string;
  };
}

/**
 * Execute an Archestra MCP tool
 */
export async function executeArchestraTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult> {
  const { profile } = context;

  if (toolName === TOOL_WHOAMI_FULL_NAME) {
    logger.info(
      { profileId: profile.id, profileName: profile.name },
      "whoami tool called",
    );

    return {
      content: [
        {
          type: "text",
          text: `Profile Name: ${profile.name}\nProfile ID: ${profile.id}`,
        },
      ],
      isError: false,
    };
  }

  if (toolName === TOOL_SEARCH_PRIVATE_MCP_REGISTRY_FULL_NAME) {
    logger.info(
      { profileId: profile.id, searchArgs: args },
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

  if (toolName === TOOL_CREATE_PROFILE_FULL_NAME) {
    logger.info(
      { profileId: profile.id, createArgs: args },
      "create_profile tool called",
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
              text: "Error: Profile name is required and cannot be empty.",
            },
          ],
          isError: true,
        };
      }

      // Create the profile
      const newProfile = await AgentModel.create({
        name,
        teams,
        labels,
      });

      return {
        content: [
          {
            type: "text",
            text: `Successfully created profile.\n\nProfile Name: ${
              newProfile.name
            }\nProfile ID: ${newProfile.id}\nTeams: ${
              newProfile.teams.length > 0
                ? newProfile.teams.map((t) => t.name).join(", ")
                : "None"
            }\nLabels: ${
              newProfile.labels.length > 0
                ? newProfile.labels
                    .map((l) => `${l.key}: ${l.value}`)
                    .join(", ")
                : "None"
            }`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error creating profile");
      return {
        content: [
          {
            type: "text",
            text: `Error creating profile: ${
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
      { profileId: profile.id, requestArgs: args },
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
      { profileId: profile.id, createLimitArgs: args },
      "create_limit tool called",
    );

    try {
      let entityType: LimitEntityType;

      // Mapping until we migrate agent -> profile in LimitEntityType database column
      if (args?.entity_type === "profile") {
        entityType = "agent";
      } else {
        entityType = args?.entity_type as LimitEntityType;
      }

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
      { profileId: profile.id, getLimitsArgs: args },
      "get_limits tool called",
    );

    try {
      let entityType: LimitEntityType;
      // Mapping until we migrate agent -> profile in LimitEntityType database column
      if (args?.entity_type === "profile") {
        entityType = "agent";
      } else {
        entityType = args?.entity_type as LimitEntityType;
      }

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
      { profileId: profile.id, updateLimitArgs: args },
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
      { profileId: profile.id, deleteLimitArgs: args },
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

  if (toolName === TOOL_GET_PROFILE_TOKEN_USAGE_FULL_NAME) {
    logger.info(
      { profileId: profile.id, getTokenUsageArgs: args },
      "get_profile_token_usage tool called",
    );

    try {
      const targetProfileId = (args?.profile_id as string) || profile.id;
      const usage = await LimitModel.getAgentTokenUsage(targetProfileId);

      return {
        content: [
          {
            type: "text",
            text: `Token usage for profile ${targetProfileId}:\n\nTotal Input Tokens: ${usage.totalInputTokens.toLocaleString()}\nTotal Output Tokens: ${usage.totalOutputTokens.toLocaleString()}\nTotal Tokens: ${usage.totalTokens.toLocaleString()}`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting profile token usage");
      return {
        content: [
          {
            type: "text",
            text: `Error getting profile token usage: ${
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
      { profileId: profile.id },
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
      { profileId: profile.id },
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
      { profileId: profile.id, createArgs: args },
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
      { profileId: profile.id, policyId: args?.id },
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
      { profileId: profile.id, updateArgs: args },
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
      { profileId: profile.id, policyId: args?.id },
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
      { profileId: profile.id },
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
      { profileId: profile.id, createArgs: args },
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
      { profileId: profile.id, policyId: args?.id },
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
      { profileId: profile.id, updateArgs: args },
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
      { profileId: profile.id, policyId: args?.id },
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

  if (toolName === TOOL_BULK_ASSIGN_TOOLS_TO_PROFILES_FULL_NAME) {
    logger.info(
      { profileId: profile.id, assignments: args?.assignments },
      "bulk_assign_tools_to_profiles tool called",
    );

    try {
      const assignments = args?.assignments as Array<{
        profileId: string;
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
            assignment.profileId,
            assignment.toolId,
            assignment.credentialSourceMcpServerId,
            assignment.executionSourceMcpServerId,
          ),
        ),
      );

      const succeeded: { profileId: string; toolId: string }[] = [];
      const failed: { profileId: string; toolId: string; error: string }[] = [];
      const duplicates: { profileId: string; toolId: string }[] = [];

      results.forEach((result, index) => {
        const { profileId, toolId } = assignments[index];
        if (result.status === "fulfilled") {
          if (result.value === null || result.value === "updated") {
            // Success (created or updated)
            succeeded.push({ profileId, toolId });
          } else if (result.value === "duplicate") {
            // Already assigned with same credentials
            duplicates.push({ profileId, toolId });
          } else {
            // Validation error
            const error = result.value.error.message || "Unknown error";
            failed.push({ profileId, toolId, error });
          }
        } else if (result.status === "rejected") {
          // Runtime error
          const error =
            result.reason instanceof Error
              ? result.reason.message
              : "Unknown error";
          failed.push({ profileId, toolId, error });
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
      logger.error({ err: error }, "Error bulk assigning tools to profiles");
      return {
        content: [
          {
            type: "text",
            text: `Error bulk assigning tools to profiles: ${
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
      { profileId: profile.id, filters: args },
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
      { profileId: profile.id, mcpServerId: args?.mcpServerId },
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

  if (toolName === TOOL_GET_PROFILE_FULL_NAME) {
    logger.info(
      { profileId: profile.id, requestedProfileId: args?.id },
      "get_profile tool called",
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

      const requestedProfile = await AgentModel.findById(id);
      if (!requestedProfile) {
        return {
          content: [
            {
              type: "text",
              text: "Profile not found",
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(requestedProfile, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      logger.error({ err: error }, "Error getting profile");
      return {
        content: [
          {
            type: "text",
            text: `Error getting profile: ${
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

/**
 * Get the list of Archestra MCP tools
 */
export function getArchestraMcpTools(): Tool[] {
  return [
    {
      name: TOOL_WHOAMI_FULL_NAME,
      title: "Who Am I",
      description: "Returns the name and ID of the current profile",
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
        "Create a new cost or usage limit for an organization, team, or profile. Supports token_cost, mcp_server_calls, and tool_calls limit types.",
      inputSchema: {
        type: "object",
        properties: {
          entity_type: {
            type: "string",
            enum: ["organization", "team", "profile"],
            description: "The type of entity to apply the limit to",
          },
          entity_id: {
            type: "string",
            description:
              "The ID of the entity (organization, team, or profile)",
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
            enum: ["organization", "team", "profile"],
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
      name: TOOL_GET_PROFILE_TOKEN_USAGE_FULL_NAME,
      title: "Get Profile Token Usage",
      description:
        "Get the total token usage (input and output) for a specific profile. If no profile_id is provided, returns usage for the current profile.",
      inputSchema: {
        type: "object",
        properties: {
          profile_id: {
            type: "string",
            description:
              "The ID of the profile to get usage for (optional, defaults to current profile)",
          },
        },
        required: [],
      },
    },
    {
      name: TOOL_CREATE_PROFILE_FULL_NAME,
      title: "Create Profile",
      description:
        "Create a new profile with the specified name and optional configuration. The profile will be automatically assigned Archestra built-in tools.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The name of the profile (required)",
          },
          /**
           * TODO: in order to enable this we need to expose GET/CREATE /api/teams tools such that the profile
           * is able to fetch (or create) teams and get their ids (uuids).. otherwise it will try passing in
           * team names (which is not currently supported).. or we support passing in team names..
           */
          // teams: {
          //   type: "array",
          //   items: {
          //     type: "string",
          //   },
          //   description: "Array of team IDs to assign the profile to (optional)",
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
            description: "Array of labels to assign to the profile (optional)",
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
          profileToolId: {
            type: "string",
            description: "The ID of the profile tool this policy applies to",
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
        required: ["profileToolId", "operator", "path", "value", "action"],
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
          profileToolId: {
            type: "string",
            description: "The ID of the profile tool this policy applies to",
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
          profileToolId: {
            type: "string",
            description: "The ID of the profile tool this policy applies to",
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
        required: ["profileToolId", "operator", "path", "value", "action"],
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
          profileToolId: {
            type: "string",
            description: "The ID of the profile tool this policy applies to",
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
      name: TOOL_BULK_ASSIGN_TOOLS_TO_PROFILES_FULL_NAME,
      title: "Bulk Assign Tools to Profiles",
      description:
        "Assign multiple tools to multiple profiles in bulk with validation and error handling",
      inputSchema: {
        type: "object",
        properties: {
          assignments: {
            type: "array",
            description: "Array of tool assignments to create",
            items: {
              type: "object",
              properties: {
                profileId: {
                  type: "string",
                  description: "The ID of the profile to assign the tool to",
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
              required: ["profileId", "toolId"],
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
      name: TOOL_GET_PROFILE_FULL_NAME,
      title: "Get Profile",
      description:
        "Get a specific profile by ID with full details including labels and team assignments",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The ID of the profile to retrieve",
          },
        },
        required: ["id"],
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
  ];
}
