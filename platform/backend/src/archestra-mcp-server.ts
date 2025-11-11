import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_SERVER_TOOL_NAME_SEPARATOR } from "@shared";
import logger from "@/logging";
import { AgentModel, InternalMcpCatalogModel, LimitModel } from "@/models";
import type { Agent, InternalMcpCatalog } from "@/types";

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
          teams: {
            type: "array",
            items: {
              type: "string",
            },
            description: "Array of team IDs to assign the agent to (optional)",
          },
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
