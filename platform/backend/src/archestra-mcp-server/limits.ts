import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import logger from "@/logging";
import { LimitModel } from "@/models";
import { type LimitEntityType, type LimitType, LimitTypeSchema } from "@/types";
import type { ArchestraContext } from "./types";

// === Constants ===

const TOOL_CREATE_LIMIT_NAME = "create_limit";
const TOOL_GET_LIMITS_NAME = "get_limits";
const TOOL_UPDATE_LIMIT_NAME = "update_limit";
const TOOL_DELETE_LIMIT_NAME = "delete_limit";
const TOOL_GET_AGENT_TOKEN_USAGE_NAME = "get_agent_token_usage";
const TOOL_GET_LLM_PROXY_TOKEN_USAGE_NAME = "get_llm_proxy_token_usage";

const TOOL_CREATE_LIMIT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_CREATE_LIMIT_NAME}`;
const TOOL_GET_LIMITS_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_LIMITS_NAME}`;
const TOOL_UPDATE_LIMIT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_UPDATE_LIMIT_NAME}`;
const TOOL_DELETE_LIMIT_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_DELETE_LIMIT_NAME}`;
const TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_AGENT_TOKEN_USAGE_NAME}`;
const TOOL_GET_LLM_PROXY_TOKEN_USAGE_FULL_NAME = `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${TOOL_GET_LLM_PROXY_TOKEN_USAGE_NAME}`;

export const toolShortNames = [
  "create_limit",
  "get_limits",
  "update_limit",
  "delete_limit",
  "get_agent_token_usage",
  "get_llm_proxy_token_usage",
] as const;

// === Exports ===

export const tools: Tool[] = [
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
          description: "Array of model names (required for token_cost limits)",
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
];

export async function handleTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ArchestraContext,
): Promise<CallToolResult | null> {
  const { agent: contextAgent } = context;

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
      const limitToolName = args?.tool_name as string | undefined;

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

      if (limitType === "tool_calls" && (!mcpServerName || !limitToolName)) {
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
        toolName: limitToolName,
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

  return null;
}
