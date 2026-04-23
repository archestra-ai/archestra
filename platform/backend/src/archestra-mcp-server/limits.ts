import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_CREATE_LIMIT_SHORT_NAME,
  TOOL_DELETE_LIMIT_SHORT_NAME,
  TOOL_GET_AGENT_TOKEN_USAGE_SHORT_NAME,
  TOOL_GET_LIMITS_SHORT_NAME,
  TOOL_GET_LLM_PROXY_TOKEN_USAGE_SHORT_NAME,
  TOOL_UPDATE_LIMIT_SHORT_NAME,
} from "@shared";
import { z } from "zod";
import logger from "@/logging";
import { LimitModel } from "@/models";
import {
  LimitEntityTypeSchema,
  LimitTypeSchema,
  PersistedLimitTypeSchema,
  UuidIdSchema,
  validateLimitShape,
} from "@/types";
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
  limitType: PersistedLimitTypeSchema.describe("The kind of limit."),
  limitValue: z.number().describe("The configured limit value."),
  model: z
    .array(z.string())
    .nullable()
    .optional()
    .describe("Models targeted by a token_cost limit, if any."),
});

const CreateLimitToolArgsSchema = z
  .object({
    entity_type: LimitEntityTypeSchema.describe(
      "The type of entity to apply the limit to (organization, team, agent, user, or virtual_api_key).",
    ),
    entity_id: z
      .string()
      .min(1)
      .describe("The ID of the entity."),
    limit_type: LimitTypeSchema.describe("The type of limit to apply."),
    limit_value: z.number().describe("The limit value in tokens."),
    model: z
      .array(z.string())
      .describe(
        'Array of model names to apply the limit to. Use ["*"] as the sole element to apply the limit to every model; mixing "*" with concrete model names is rejected.',
      ),
  })
  .strict()
  .refine(
    (args) =>
      validateLimitShape({
        limitType: args.limit_type,
        model: args.model,
      }),
    { message: "Invalid limit configuration for the specified limit type" },
  );

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_CREATE_LIMIT_SHORT_NAME,
    title: "Create Limit",
    description:
      "Create a new token-cost limit for an organization, team, agent, user, or virtual API key.",
    schema: CreateLimitToolArgsSchema,
    outputSchema: z.object({
      limit: LimitOutputItemSchema,
    }),
    async handler({ args, context }) {
      const { agent: contextAgent, organizationId } = context;

      logger.info(
        { agentId: contextAgent.id, createLimitArgs: args },
        "create_limit tool called",
      );

      if (!organizationId) {
        return errorResult(
          "create_limit requires an authenticated organization context.",
        );
      }

      try {
        const limit = await LimitModel.create({
          entityType: args.entity_type,
          entityId: args.entity_id,
          organizationId,
          limitType: args.limit_type,
          limitValue: args.limit_value,
          model: args.model,
        });

        return structuredSuccessResult(
          { limit },
          `Successfully created limit.\n\nLimit ID: ${
            limit.id
          }\nEntity Type: ${limit.entityType}\nEntity ID: ${
            limit.entityId
          }\nLimit Type: ${limit.limitType}\nLimit Value: ${
            limit.limitValue
          }${limit.model ? `\nModel: ${limit.model}` : ""}`,
        );
      } catch (error) {
        return catchError(error, "creating limit");
      }
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_LIMITS_SHORT_NAME,
    title: "Get Limits",
    description:
      "Retrieve all limits, optionally filtered by entity type and/or entity ID.",
    schema: z
      .object({
        entity_type: LimitEntityTypeSchema.optional().describe(
          "Optional filter by entity type.",
        ),
        entity_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional filter by entity ID."),
      })
      .strict(),
    outputSchema: z.object({
      limits: z.array(LimitOutputItemSchema),
    }),
    async handler({ args, context }) {
      const { agent: contextAgent, organizationId } = context;

      logger.info(
        { agentId: contextAgent.id, getLimitsArgs: args },
        "get_limits tool called",
      );

      if (!organizationId) {
        return errorResult(
          "get_limits requires an authenticated organization context.",
        );
      }

      try {
        const limits = await LimitModel.findAll({
          organizationId,
          entityType: args.entity_type,
          entityId: args.entity_id,
        });

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
    shortName: TOOL_UPDATE_LIMIT_SHORT_NAME,
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
      const { agent: contextAgent, organizationId } = context;

      logger.info(
        { agentId: contextAgent.id, updateLimitArgs: args },
        "update_limit tool called",
      );

      if (!organizationId) {
        return errorResult(
          "update_limit requires an authenticated organization context.",
        );
      }

      try {
        const updateData: Record<string, unknown> = {};
        if (args.limit_value !== undefined) {
          updateData.limitValue = args.limit_value;
        }

        if (Object.keys(updateData).length === 0) {
          return errorResult("No fields provided to update.");
        }

        const limit = await LimitModel.patch({
          id: args.id,
          data: updateData,
          organizationId,
        });

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
    shortName: TOOL_DELETE_LIMIT_SHORT_NAME,
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
      const { agent: contextAgent, organizationId } = context;

      logger.info(
        { agentId: contextAgent.id, deleteLimitArgs: args },
        "delete_limit tool called",
      );

      if (!organizationId) {
        return errorResult(
          "delete_limit requires an authenticated organization context.",
        );
      }

      try {
        const deleted = await LimitModel.delete(args.id, organizationId);

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
    shortName: TOOL_GET_AGENT_TOKEN_USAGE_SHORT_NAME,
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
    shortName: TOOL_GET_LLM_PROXY_TOKEN_USAGE_SHORT_NAME,
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
