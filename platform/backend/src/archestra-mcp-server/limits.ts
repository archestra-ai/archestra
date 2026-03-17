import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import logger from "@/logging";
import { LimitModel } from "@/models";
import { LimitEntityTypeSchema, LimitTypeSchema, UuidIdSchema } from "@/types";
import {
  catchError,
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

// === Constants ===

const LimitOutputItemSchema = z.object({
  id: z.string().describe("The limit ID."),
  entityType: LimitEntityTypeSchema.describe("The limited entity type."),
  entityId: z.string().describe("The limited entity ID."),
  limitType: LimitTypeSchema.describe("The kind of limit."),
  limitValue: z.number().describe("The configured limit value."),
  model: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Models targeted by a token_cost limit, if any."),
  mcpServerName: z
    .string()
    .nullable()
    .optional()
    .describe("MCP server name for MCP-specific limits, if any."),
  toolName: z
    .string()
    .nullable()
    .optional()
    .describe("Tool name for tool-specific limits, if any."),
});

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
  defineArchestraTool({
    shortName: "create_limit",
    title: "Create Limit",
    description:
      "Create a new cost or usage limit for an organization, team, agent, LLM proxy, or MCP gateway. Supports token_cost, mcp_server_calls, and tool_calls limit types.",
    schema: CreateLimitToolArgsSchema,
    outputSchema: z.object({
      limit: LimitOutputItemSchema,
    }),
    async handler({ args, context }) {
      const { agent: contextAgent } = context;

      logger.info(
        { agentId: contextAgent.id, createLimitArgs: args },
        "create_limit tool called",
      );

      try {
        const limit = await LimitModel.create({
          entityType: args.entity_type,
          entityId: args.entity_id,
          limitType: args.limit_type,
          limitValue: args.limit_value,
          model: args.model,
          mcpServerName: args.mcp_server_name,
          toolName: args.tool_name,
        });

        return structuredSuccessResult(
          { limit },
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
    },
  }),
  defineArchestraTool({
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
    outputSchema: z.object({
      limits: z.array(LimitOutputItemSchema),
    }),
    async handler({ args, context }) {
      const { agent: contextAgent } = context;

      logger.info(
        { agentId: contextAgent.id, getLimitsArgs: args },
        "get_limits tool called",
      );

      try {
        const limits = await LimitModel.findAll(
          args.entity_type,
          args.entity_id,
        );

        if (limits.length === 0) {
          return structuredSuccessResult(
            { limits: [] },
            args.entity_type || args.entity_id
              ? `No limits found${
                  args.entity_type
                    ? ` for entity type: ${args.entity_type}`
                    : ""
                }${args.entity_id ? ` and entity ID: ${args.entity_id}` : ""}.`
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

        return structuredSuccessResult(
          { limits },
          `Found ${limits.length} limit(s):\n\n${formattedLimits}`,
        );
      } catch (error) {
        return catchError(error, "getting limits");
      }
    },
  }),
  defineArchestraTool({
    shortName: "update_limit",
    title: "Update Limit",
    description:
      "Update mutable fields on an existing limit. At least one update field must be provided.",
    schema: z
      .object({
        id: UuidIdSchema.describe("The ID of the limit to update."),
        limit_value: z
          .number()
          .optional()
          .describe("Optional new limit value."),
      })
      .strict(),
    outputSchema: z.object({
      limit: LimitOutputItemSchema,
    }),
    async handler({ args, context }) {
      const { agent: contextAgent } = context;

      logger.info(
        { agentId: contextAgent.id, updateLimitArgs: args },
        "update_limit tool called",
      );

      try {
        const updateData: Record<string, unknown> = {};
        if (args.limit_value !== undefined) {
          updateData.limitValue = args.limit_value;
        }

        if (Object.keys(updateData).length === 0) {
          return errorResult("No fields provided to update.");
        }

        const limit = await LimitModel.patch(args.id, updateData);

        if (!limit) {
          return errorResult(`Limit with ID ${args.id} not found.`);
        }

        return structuredSuccessResult(
          { limit },
          `Successfully updated limit.\n\nLimit ID: ${limit.id}\nEntity Type: ${limit.entityType}\nEntity ID: ${limit.entityId}\nLimit Type: ${limit.limitType}\nLimit Value: ${limit.limitValue}`,
        );
      } catch (error) {
        return catchError(error, "updating limit");
      }
    },
  }),
  defineArchestraTool({
    shortName: "delete_limit",
    title: "Delete Limit",
    description: "Delete an existing limit by ID.",
    schema: z
      .object({
        id: UuidIdSchema.describe("The ID of the limit to delete."),
      })
      .strict(),
    outputSchema: z.object({
      success: z.literal(true),
      id: z.string(),
    }),
    async handler({ args, context }) {
      const { agent: contextAgent } = context;

      logger.info(
        { agentId: contextAgent.id, deleteLimitArgs: args },
        "delete_limit tool called",
      );

      try {
        const deleted = await LimitModel.delete(args.id);

        if (!deleted) {
          return errorResult(`Limit with ID ${args.id} not found.`);
        }

        return structuredSuccessResult(
          { success: true, id: args.id },
          `Successfully deleted limit with ID: ${args.id}`,
        );
      } catch (error) {
        return catchError(error, "deleting limit");
      }
    },
  }),
  defineArchestraTool({
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
    outputSchema: z.object({
      id: z.string(),
      totalInputTokens: z.number(),
      totalOutputTokens: z.number(),
      totalTokens: z.number(),
    }),
    async handler({ args, context }) {
      return handleGetTokenUsage({
        args,
        context,
        tokenUsageType: "agent",
      });
    },
  }),
  defineArchestraTool({
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
    outputSchema: z.object({
      id: z.string(),
      totalInputTokens: z.number(),
      totalOutputTokens: z.number(),
      totalTokens: z.number(),
    }),
    async handler({ args, context }) {
      return handleGetTokenUsage({
        args,
        context,
        tokenUsageType: "llm_proxy",
      });
    },
  }),
] as const);

export const toolShortNames = registry.toolShortNames;
export const toolArgsSchemas = registry.toolArgsSchemas;
export const toolOutputSchemas = registry.toolOutputSchemas;
export const toolEntries = registry.toolEntries;

// === Exports ===

export const tools = registry.tools;

async function handleGetTokenUsage(params: {
  args: { id?: string };
  context: ArchestraContext;
  tokenUsageType: "agent" | "llm_proxy";
}): Promise<CallToolResult> {
  const { args, context, tokenUsageType } = params;
  const { agent: contextAgent } = context;
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
    const targetId = args.id || contextAgent.id;
    const usage = await LimitModel.getAgentTokenUsage(targetId);

    return structuredSuccessResult(
      {
        id: targetId,
        totalInputTokens: usage.totalInputTokens,
        totalOutputTokens: usage.totalOutputTokens,
        totalTokens: usage.totalTokens,
      },
      `Token usage for ${tokenUsageLabel} ${targetId}:\n\nTotal Input Tokens: ${usage.totalInputTokens.toLocaleString()}\nTotal Output Tokens: ${usage.totalOutputTokens.toLocaleString()}\nTotal Tokens: ${usage.totalTokens.toLocaleString()}`,
    );
  } catch (error) {
    return catchError(error, `getting ${tokenUsageLabel} token usage`);
  }
}
