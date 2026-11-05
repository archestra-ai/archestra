import { createPaginatedResponseSchema } from "@archestra/shared";
import { z } from "zod";

/**
 * Grouped usage rows: each endpoint returns one row per distinct combination
 * of the requested `groupBy` dimensions, with that group's metrics. Grouping by
 * `day` (a UTC calendar day) turns any breakdown into a daily series.
 * A dimension field is present on a row only when it was grouped by.
 */

// ===== Dimensions =====

export const MCP_TOOL_CALL_USAGE_DIMENSIONS = [
  "day",
  "mcpServerName",
  "toolName",
  "userId",
  "agentId",
  "appId",
] as const;
export type McpToolCallUsageDimension =
  (typeof MCP_TOOL_CALL_USAGE_DIMENSIONS)[number];

export const APP_USAGE_DIMENSIONS = ["day", "appId", "userId"] as const;
export type AppUsageDimension = (typeof APP_USAGE_DIMENSIONS)[number];

export const SKILL_USAGE_DIMENSIONS = ["day", "skillId", "userId"] as const;
export type SkillUsageDimension = (typeof SKILL_USAGE_DIMENSIONS)[number];

export const LLM_USAGE_DIMENSIONS = [
  "day",
  "teamId",
  "credentialId",
  "provider",
  "model",
] as const;
export type LlmUsageDimension = (typeof LLM_USAGE_DIMENSIONS)[number];

// ===== Rows =====

const DayField = z
  .string()
  .describe("UTC calendar day (YYYY-MM-DD). Present when grouped by day.");

const UserFields = {
  userId: z
    .string()
    .nullable()
    .describe(
      "Who made the calls. Null for usage without a resolved user. Present when grouped by userId.",
    ),
  userName: z.string().nullable(),
};

export const McpToolCallUsageRowSchema = z.object({
  day: DayField.optional(),
  mcpServerName: z.string().optional(),
  toolName: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Tool name as called, including its server prefix. Null when the name is not readable by the server (encrypted chats).",
    ),
  userId: UserFields.userId.optional(),
  userName: UserFields.userName.optional(),
  agentId: z
    .string()
    .nullable()
    .optional()
    .describe("Agent or gateway that made the calls. Null for app calls."),
  agentName: z.string().nullable().optional(),
  appId: z
    .string()
    .nullable()
    .optional()
    .describe("App that made the calls. Null for agent calls."),
  appName: z.string().nullable().optional(),
  calls: z.number(),
  errors: z.number().describe("Calls whose result was an error."),
});

export const McpToolCallUsageTotalsSchema = z.object({
  calls: z.number(),
  errors: z.number(),
});

export const AppUsageRowSchema = z.object({
  day: DayField.optional(),
  appId: z.string().optional(),
  appName: z.string().nullable().optional(),
  userId: UserFields.userId.optional(),
  userName: UserFields.userName.optional(),
  runs: z.number().describe("Times the app was opened."),
  toolCalls: z.number().describe("Tool calls the app made."),
  llmRequests: z.number().describe("LLM requests the app made."),
  inputTokens: z.number(),
  outputTokens: z.number(),
  billedCost: z.number(),
  subscriptionCost: z.number(),
});

export const AppUsageTotalsSchema = AppUsageRowSchema.pick({
  runs: true,
  toolCalls: true,
  llmRequests: true,
  inputTokens: true,
  outputTokens: true,
  billedCost: true,
  subscriptionCost: true,
});

export const SkillUsageRowSchema = z.object({
  day: DayField.optional(),
  skillId: z.string().optional(),
  skillName: z.string().optional(),
  userId: UserFields.userId.optional(),
  userName: UserFields.userName.optional(),
  activations: z.number(),
  contextTokens: z
    .number()
    .describe("Tokens the activations added to the model's context."),
  users: z.number().describe("Distinct people who activated a skill."),
});

export const SkillUsageTotalsSchema = SkillUsageRowSchema.pick({
  activations: true,
  contextTokens: true,
  users: true,
});

export const LlmUsageRowSchema = z.object({
  day: DayField.optional(),
  teamId: z
    .string()
    .optional()
    .describe(
      "Team the usage is attributed to: the credential's billing team, otherwise each team the agent is shared with (the same attribution as GET /api/statistics/teams). Present when grouped by teamId.",
    ),
  teamName: z.string().optional(),
  authMethod: z
    .string()
    .optional()
    .describe(
      "How the request authenticated, e.g. virtual_key. Present when grouped by credentialId.",
    ),
  credentialId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Virtual key, passthrough key or OAuth client that made the requests. Null when the access method has no individual credential. Present when grouped by credentialId.",
    ),
  credentialName: z.string().nullable().optional(),
  provider: z
    .string()
    .optional()
    .describe(
      "LLM provider, e.g. anthropic. Present when grouped by provider.",
    ),
  model: z
    .string()
    .optional()
    .describe(
      "Billed model. A request that billed several models counts its tokens and spend under each one, and its request under the model it asked for. Present when grouped by model.",
    ),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  totalTokens: z.number().describe("Input and output tokens."),
  billedCost: z.number().describe("Spend on metered API keys."),
  subscriptionCost: z
    .number()
    .describe("Subscription usage valued at API rates; not a bill."),
});

export const LlmUsageTotalsSchema = LlmUsageRowSchema.pick({
  requests: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  totalTokens: true,
  billedCost: true,
  subscriptionCost: true,
});

// ===== Responses =====

export const McpToolCallUsageResponseSchema = createPaginatedResponseSchema(
  McpToolCallUsageRowSchema,
).extend({ totals: McpToolCallUsageTotalsSchema });

export const AppUsageResponseSchema = createPaginatedResponseSchema(
  AppUsageRowSchema,
).extend({ totals: AppUsageTotalsSchema });

export const SkillUsageResponseSchema = createPaginatedResponseSchema(
  SkillUsageRowSchema,
).extend({ totals: SkillUsageTotalsSchema });

export const LlmUsageResponseSchema = createPaginatedResponseSchema(
  LlmUsageRowSchema,
).extend({ totals: LlmUsageTotalsSchema });

export type McpToolCallUsageRow = z.infer<typeof McpToolCallUsageRowSchema>;
export type McpToolCallUsageResponse = z.infer<
  typeof McpToolCallUsageResponseSchema
>;
export type AppUsageRow = z.infer<typeof AppUsageRowSchema>;
export type AppUsageResponse = z.infer<typeof AppUsageResponseSchema>;
export type SkillUsageRow = z.infer<typeof SkillUsageRowSchema>;
export type SkillUsageResponse = z.infer<typeof SkillUsageResponseSchema>;
export type LlmUsageResponse = z.infer<typeof LlmUsageResponseSchema>;
