import {
  BUILT_IN_AGENT_IDS,
  DOMAIN_VALIDATION_REGEX,
  IncomingEmailSecurityModeSchema,
  MAX_DOMAIN_LENGTH,
} from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { AgentLabelWithDetailsSchema } from "./label";
import { SelectToolSchema } from "./tool";

/**
 * Agent type:
 * - profile: External profiles for API gateway routing
 * - mcp_gateway: MCP gateway specific configuration
 * - llm_proxy: LLM proxy specific configuration
 * - agent: Internal agents with prompts for chat
 */
export const AgentTypeSchema = z.enum([
  "profile",
  "mcp_gateway",
  "llm_proxy",
  "agent",
]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export const AgentScopeSchema = z.enum(["personal", "team", "org"]);
export type AgentScope = z.infer<typeof AgentScopeSchema>;

// Built-in agent config — discriminated union by name
// Policy Configuration Subagent config
const PolicyConfigAgentConfigSchema = z.object({
  name: z.literal(BUILT_IN_AGENT_IDS.POLICY_CONFIG),
  autoConfigureOnToolAssignment: z.boolean(),
});

// Discriminated union — add future built-in agents here
export const BuiltInAgentConfigSchema = z.discriminatedUnion("name", [
  PolicyConfigAgentConfigSchema,
]);

export type BuiltInAgentConfig = z.infer<typeof BuiltInAgentConfigSchema>;
export type PolicyConfigAgentConfig = z.infer<
  typeof PolicyConfigAgentConfigSchema
>;

/**
 * Represents a historical version of an agent's prompt stored in the prompt_history JSONB array.
 * Only used when agent_type is 'agent'.
 */
export interface AgentHistoryEntry {
  version: number;
  userPrompt: string | null;
  systemPrompt: string | null;
  createdAt: string; // ISO timestamp
}

// Team info schema for agent responses (just id and name)
export const AgentTeamInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
});

// Extended field schemas for drizzle-zod
// agentType override is needed because the column uses text().$type<AgentType>()
// which drizzle-zod infers as z.string() instead of the narrower enum schema
const selectExtendedFields = {
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema,
  agentType: AgentTypeSchema,
  scope: AgentScopeSchema,
  builtInAgentConfig: BuiltInAgentConfigSchema.nullable(),
};

const insertExtendedFields = {
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema.optional(),
  agentType: AgentTypeSchema.optional(),
  scope: AgentScopeSchema.optional(),
  builtInAgentConfig: BuiltInAgentConfigSchema.nullable().optional(),
};

/**
 * Validates incoming email domain settings.
 * When incomingEmailEnabled is true and incomingEmailSecurityMode is "internal",
 * the incomingEmailAllowedDomain must be provided and match the domain regex.
 */
function validateIncomingEmailDomain(
  data: {
    incomingEmailEnabled?: boolean | null;
    incomingEmailSecurityMode?: string | null;
    incomingEmailAllowedDomain?: string | null;
  },
  ctx: z.RefinementCtx,
) {
  // Only validate when email is enabled and mode is internal
  if (
    data.incomingEmailEnabled === true &&
    data.incomingEmailSecurityMode === "internal"
  ) {
    const domain = data.incomingEmailAllowedDomain?.trim();

    if (!domain) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Allowed domain is required when security mode is set to internal",
        path: ["incomingEmailAllowedDomain"],
      });
      return;
    }

    if (domain.length > MAX_DOMAIN_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Domain must not exceed ${MAX_DOMAIN_LENGTH} characters`,
        path: ["incomingEmailAllowedDomain"],
      });
      return;
    }

    if (!DOMAIN_VALIDATION_REGEX.test(domain)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Invalid domain format. Please enter a valid domain (e.g., company.com)",
        path: ["incomingEmailAllowedDomain"],
      });
    }
  }
}

export const SelectAgentSchema = createSelectSchema(
  schema.agentsTable,
  selectExtendedFields,
).extend({
  tools: z.array(SelectToolSchema),
  teams: z.array(AgentTeamInfoSchema),
  labels: z.array(AgentLabelWithDetailsSchema),
  authorName: z.string().nullable().optional(),
});

// Base schema without refinement - can be used with .partial()
export const InsertAgentSchemaBase = createInsertSchema(
  schema.agentsTable,
  insertExtendedFields,
)
  .extend({
    teams: z.array(z.string()).default([]),
    labels: z.array(AgentLabelWithDetailsSchema).optional(),
    // Make organizationId optional - model will auto-assign if not provided
    organizationId: z.string().optional(),
    scope: AgentScopeSchema,
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    promptHistory: true,
    promptVersion: true,
    authorId: true,
  });

// Full schema with validation refinement
export const InsertAgentSchema = InsertAgentSchemaBase.superRefine(
  validateIncomingEmailDomain,
);

// Base schema without refinement - can be used with .partial()
export const UpdateAgentSchemaBase = createUpdateSchema(
  schema.agentsTable,
  insertExtendedFields,
)
  .extend({
    teams: z.array(z.string()),
    labels: z.array(AgentLabelWithDetailsSchema).optional(),
    scope: AgentScopeSchema,
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    promptVersion: true,
    promptHistory: true,
    authorId: true,
  });

// Full schema with validation refinement
export const UpdateAgentSchema = UpdateAgentSchemaBase.superRefine(
  validateIncomingEmailDomain,
);

// Schema for history entry in API responses (for internal agents)
export const AgentHistoryEntrySchema = z.object({
  version: z.number(),
  userPrompt: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  createdAt: z.string(),
});

// Schema for versions endpoint response (for internal agents)
export const AgentVersionsResponseSchema = z.object({
  current: SelectAgentSchema,
  history: z.array(AgentHistoryEntrySchema),
});

export type Agent = z.infer<typeof SelectAgentSchema>;
export type InsertAgent = z.infer<typeof InsertAgentSchema>;
export type UpdateAgent = z.infer<typeof UpdateAgentSchema>;
export type AgentVersionsResponse = z.infer<typeof AgentVersionsResponseSchema>;

/**
 * Schema for auto-policy LLM analysis output.
 * Describes security policy recommendations for an MCP tool.
 */
export const PolicyConfigSchema = z.object({
  toolInvocationAction: z
    .enum([
      "allow_when_context_is_untrusted",
      "block_when_context_is_untrusted",
      "block_always",
    ])
    .describe(
      "When should this tool be allowed to be invoked? " +
        "'allow_when_context_is_untrusted' - Allow invocation even when untrusted data is present (safe read-only tools). " +
        "'block_when_context_is_untrusted' - Allow only when context is trusted, block when untrusted data is present (tools that could leak data). " +
        "'block_always' - Never allow automatic invocation (dangerous tools that execute code, write data, or send data externally).",
    ),
  trustedDataAction: z
    .enum([
      "mark_as_trusted",
      "mark_as_untrusted",
      "sanitize_with_dual_llm",
      "block_always",
    ])
    .describe(
      "How should the tool's results be treated? " +
        "'mark_as_trusted' - Results are trusted and can be used directly (internal systems, databases, dev tools). " +
        "'mark_as_untrusted' - Results are untrusted and will restrict subsequent tool usage (external/filesystem data where exact values are safe). " +
        "'sanitize_with_dual_llm' - Results are processed through dual LLM security pattern (untrusted data that needs summarization). " +
        "'block_always' - Results are blocked entirely (highly sensitive or dangerous output).",
    ),
  reasoning: z
    .string()
    .describe(
      "Brief explanation of why these settings were chosen for this tool.",
    ),
});

export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
