import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
  defineArchestraTools,
  errorResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

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

const registry = defineArchestraTools([
  {
    shortName: "create_limit",
    title: "Create Limit",
    description:
      "Create a new cost or usage limit for an organization, team, agent, LLM proxy, or MCP gateway. Supports token_cost, mcp_server_calls, and tool_calls limit types.",
    schema: CreateLimitToolArgsSchema,
  },
  {
    shortName: "get_limits",
    title: "Get Limits",
    description:
      "Retrieve all limits, optionally filtered by entity type and/or entity ID.",
    schema: z
      .object({
        entity_type: LimitEntityTypeSchema.optional().describe(
          "Optional filter by entity type.",
        ),
        entity_id: UuidIdSchema.optional().describe(
          "Optional filter by entity ID.",
        ),
      })
      .strict(),
  },
  {
    shortName: "update_limit",
    title: "Update Limit",
    description: "Update an existing limit's value.",
    schema: z
      .object({
        id: UuidIdSchema.describe("The ID of the limit to update."),
        limit_value: z.number().optional().describe("The new limit value."),
      })
      .strict(),
  },
  {
    shortName: "delete_limit",
    title: "Delete Limit",
    description: "Delete an existing limit by ID.",
    schema: z
      .object({
        id: UuidIdSchema.describe("The ID of the limit to delete."),
      })
      .strict(),
  },
  {
    shortName: "get_agent_token_usage",
    title: "Get Agent Token Usage",
    description:
      "Get the total token usage (input and output) for a specific agent. If no id is provided, returns usage for the current agent.",
    schema: z
      .object({
        id: UuidIdSchema.optional().describe(
          "Optional agent ID. Defaults to the current agent.",
        ),
      })
      .strict(),
  },
  {
    shortName: "get_llm_proxy_token_usage",
    title: "Get LLM Proxy Token Usage",
    description:
      "Get the total token usage (input and output) for a specific LLM proxy. If no id is provided, returns usage for the current agent.",
    schema: z
      .object({
        id: UuidIdSchema.optional().describe(
          "Optional LLM proxy ID. Defaults to the current agent.",
        ),
      })
      .strict(),
  },
] as const);

const {
  create_limit: TOOL_CREATE_LIMIT_FULL_NAME,
  get_limits: TOOL_GET_LIMITS_FULL_NAME,
  update_limit: TOOL_UPDATE_LIMIT_FULL_NAME,
  delete_limit: TOOL_DELETE_LIMIT_FULL_NAME,
  get_agent_token_usage: TOOL_GET_AGENT_TOKEN_USAGE_FULL_NAME,
  get_llm_proxy_token_usage: TOOL_GET_LLM_PROXY_TOKEN_USAGE_FULL_NAME,
} = registry.toolFullNames;

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;

// === Exports ===

export const tools = registry.tools;

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
