import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@shared";
import { z } from "zod";
import logger from "@/logging";
import { LimitModel } from "@/models";
import {
  type LimitEntityType,
  LimitEntityTypeSchema,
  type LimitType,
  LimitTypeSchema,
  UuidIdSchema,
} from "@/types";
import {
  catchError,
  createToolDefinition,
  errorResult,
  successResult,
} from "./helpers";
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

const CreateLimitToolArgsSchema = z
  .object({
    entity_type: LimitEntityTypeSchema.describe(
      "The type of entity to apply the limit to.",
    ),
    entity_id: UuidIdSchema.describe(
      "The ID of the entity (organization, team, or agent).",
    ),
    limit_type: LimitTypeSchema.describe("The type of limit to apply."),
    limit_value: z
      .number()
      .describe("The limit value (tokens or count depending on limit type)."),
    model: z
      .array(z.string())
      .optional()
      .describe("Array of model names. Required for token_cost limits."),
    mcp_server_name: z
      .string()
      .optional()
      .describe(
        "MCP server name. Required for mcp_server_calls and tool_calls limits.",
      ),
    tool_name: z
      .string()
      .optional()
      .describe("Tool name. Required for tool_calls limits."),
  })
  .strict()
  .superRefine((args, ctx) => {
    if (
      args.limit_type === "token_cost" &&
      (!args.model || !Array.isArray(args.model) || args.model.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message:
          "model array with at least one model is required for token_cost limits.",
      });
    }

    if (args.limit_type === "mcp_server_calls" && !args.mcp_server_name) {
      ctx.addIssue({
        code: "custom",
        path: ["mcp_server_name"],
        message: "mcp_server_name is required for mcp_server_calls limits.",
      });
    }

    if (
      args.limit_type === "tool_calls" &&
      (!args.mcp_server_name || !args.tool_name)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["tool_name"],
        message:
          "mcp_server_name and tool_name are required for tool_calls limits.",
      });
    }
  });

export const toolArgsSchemas = {
  [TOOL_CREATE_LIMIT_FULL_NAME]: CreateLimitToolArgsSchema,
  [TOOL_GET_LIMITS_FULL_NAME]: z
    .object({
      entity_type: LimitEntityTypeSchema.optional().describe(
        "Optional filter by entity type.",
      ),
      entity_id: UuidIdSchema.optional().describe(
        "Optional filter by entity ID.",
      ),
    })
    .strict(),
  [TOOL_UPDATE_LIMIT_FULL_NAME]: z
    .object({
      id: UuidIdSchema.describe("The ID of the limit to update."),
      limit_value: z.number().optional().describe("The new limit value."),
    })
    .strict(),
  [TOOL_DELETE_LIMIT_FULL_NAME]: z
    .object({
      id: UuidIdSchema.describe("The ID of the limit to delete."),
    })
    .strict(),
  [TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME]: z
    .object({
      id: UuidIdSchema.optional().describe(
        "Optional agent ID. Defaults to the current agent.",
      ),
    })
    .strict(),
  [TOOL_GET_LLM_PROXY_TOKEN_USAGE_FULL_NAME]: z
    .object({
      id: UuidIdSchema.optional().describe(
        "Optional LLM proxy ID. Defaults to the current agent.",
      ),
    })
    .strict(),
} as const;

// === Exports ===

export const tools: Tool[] = [
  createToolDefinition({
    name: TOOL_CREATE_LIMIT_FULL_NAME,
    title: "Create Limit",
    description:
      "Create a new cost or usage limit for an organization, team, agent, LLM proxy, or MCP gateway. Supports token_cost, mcp_server_calls, and tool_calls limit types.",
    schema: toolArgsSchemas[TOOL_CREATE_LIMIT_FULL_NAME],
  }),
  createToolDefinition({
    name: TOOL_GET_LIMITS_FULL_NAME,
    title: "Get Limits",
    description:
      "Retrieve all limits, optionally filtered by entity type and/or entity ID.",
    schema: toolArgsSchemas[TOOL_GET_LIMITS_FULL_NAME],
  }),
  createToolDefinition({
    name: TOOL_UPDATE_LIMIT_FULL_NAME,
    title: "Update Limit",
    description: "Update an existing limit's value.",
    schema: toolArgsSchemas[TOOL_UPDATE_LIMIT_FULL_NAME],
  }),
  createToolDefinition({
    name: TOOL_DELETE_LIMIT_FULL_NAME,
    title: "Delete Limit",
    description: "Delete an existing limit by ID.",
    schema: toolArgsSchemas[TOOL_DELETE_LIMIT_FULL_NAME],
  }),
  createToolDefinition({
    name: TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME,
    title: "Get Agent Token Usage",
    description:
      "Get the total token usage (input and output) for a specific agent. If no id is provided, returns usage for the current agent.",
    schema: toolArgsSchemas[TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME],
  }),
  createToolDefinition({
    name: TOOL_GET_LLM_PROXY_TOKEN_USAGE_FULL_NAME,
    title: "Get LLM Proxy Token Usage",
    description:
      "Get the total token usage (input and output) for a specific LLM proxy. If no id is provided, returns usage for the current agent.",
    schema: toolArgsSchemas[TOOL_GET_LLM_PROXY_TOKEN_USAGE_FULL_NAME],
  }),
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
        return errorResult(
          "entity_type, entity_id, limit_type, and limit_value are required fields.",
        );
      }

      // Validate limit type specific requirements
      if (
        limitType === "token_cost" &&
        (!model || !Array.isArray(model) || model.length === 0)
      ) {
        return errorResult(
          "model array with at least one model is required for token_cost limits.",
        );
      }

      if (limitType === "mcp_server_calls" && !mcpServerName) {
        return errorResult(
          "mcp_server_name is required for mcp_server_calls limits.",
        );
      }

      if (limitType === "tool_calls" && (!mcpServerName || !limitToolName)) {
        return errorResult(
          "mcp_server_name and tool_name are required for tool_calls limits.",
        );
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

      return successResult(
        `Successfully created limit.\n\nLimit ID: ${
          limit.id
        }\nEntity Type: ${limit.entityType}\nEntity ID: ${
          limit.entityId
        }\nLimit Type: ${limit.limitType}\nLimit Value: ${
          limit.limitValue
        }${limit.model ? `\nModel: ${limit.model}` : ""}${
          limit.mcpServerName ? `\nMCP Server: ${limit.mcpServerName}` : ""
        }${limit.toolName ? `\nTool: ${limit.toolName}` : ""}`,
      );
    } catch (error) {
      return catchError(error, "creating limit");
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
        return successResult(
          entityType || entityId
            ? `No limits found${
                entityType ? ` for entity type: ${entityType}` : ""
              }${entityId ? ` and entity ID: ${entityId}` : ""}.`
            : "No limits found.",
        );
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

      return successResult(
        `Found ${limits.length} limit(s):\n\n${formattedLimits}`,
      );
    } catch (error) {
      return catchError(error, "getting limits");
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
        return errorResult("id is required to update a limit.");
      }

      const updateData: Record<string, unknown> = {};
      if (limitValue !== undefined) {
        updateData.limitValue = limitValue;
      }

      if (Object.keys(updateData).length === 0) {
        return errorResult("No fields provided to update.");
      }

      const limit = await LimitModel.patch(id, updateData);

      if (!limit) {
        return errorResult(`Limit with ID ${id} not found.`);
      }

      return successResult(
        `Successfully updated limit.\n\nLimit ID: ${limit.id}\nEntity Type: ${limit.entityType}\nEntity ID: ${limit.entityId}\nLimit Type: ${limit.limitType}\nLimit Value: ${limit.limitValue}`,
      );
    } catch (error) {
      return catchError(error, "updating limit");
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
        return errorResult("id is required to delete a limit.");
      }

      const deleted = await LimitModel.delete(id);

      if (!deleted) {
        return errorResult(`Limit with ID ${id} not found.`);
      }

      return successResult(`Successfully deleted limit with ID: ${id}`);
    } catch (error) {
      return catchError(error, "deleting limit");
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

      return successResult(
        `Token usage for ${tokenUsageLabel} ${targetId}:\n\nTotal Input Tokens: ${usage.totalInputTokens.toLocaleString()}\nTotal Output Tokens: ${usage.totalOutputTokens.toLocaleString()}\nTotal Tokens: ${usage.totalTokens.toLocaleString()}`,
      );
    } catch (error) {
      return catchError(error, `getting ${tokenUsageLabel} token usage`);
    }
  }

  return null;
}
