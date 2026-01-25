import {
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

// Re-export types from schema
export type { AgentHistoryEntry, AgentType } from "@/database/schemas/agent";

// Team info schema for agent responses (just id and name)
export const AgentTeamInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
});

// Extended field schemas for drizzle-zod
const selectExtendedFields = {
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema,
};

const insertExtendedFields = {
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema.optional(),
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
});

// Base schema without refinement - can be used with .partial()
export const InsertAgentSchemaBase = createInsertSchema(
  schema.agentsTable,
  insertExtendedFields,
)
  .extend({
    teams: z.array(z.string()),
    labels: z.array(AgentLabelWithDetailsSchema).optional(),
    // Make organizationId optional - model will auto-assign if not provided
    organizationId: z.string().optional(),
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    promptHistory: true,
    promptVersion: true,
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
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    promptVersion: true,
    promptHistory: true,
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
