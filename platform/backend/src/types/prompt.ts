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

/**
 * Represents a historical version of a prompt stored in the history JSONB array
 */
export interface PromptHistoryEntry {
  version: number;
  userPrompt: string | null;
  systemPrompt: string | null;
  createdAt: string; // ISO timestamp
}

const selectExtendedFields = {
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema,
};

// For inserts, make incomingEmailSecurityMode optional since it has a database default
const insertExtendedFields = {
  incomingEmailSecurityMode: IncomingEmailSecurityModeSchema.optional(),
};

export const SelectPromptSchema = createSelectSchema(
  schema.promptsTable,
  selectExtendedFields,
);

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

export const InsertPromptSchema = createInsertSchema(
  schema.promptsTable,
  insertExtendedFields,
)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    organizationId: true,
    history: true,
  })
  .superRefine(validateIncomingEmailDomain);

export const UpdatePromptSchema = createUpdateSchema(
  schema.promptsTable,
  insertExtendedFields, // Use optional schema for updates too
)
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    organizationId: true,
    version: true,
    history: true,
  })
  .superRefine(validateIncomingEmailDomain);

// Schema for history entry in API responses
export const PromptHistoryEntrySchema = z.object({
  version: z.number(),
  userPrompt: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  createdAt: z.string(),
});

// Schema for versions endpoint response
export const PromptVersionsResponseSchema = z.object({
  current: SelectPromptSchema,
  history: z.array(PromptHistoryEntrySchema),
});

export type Prompt = z.infer<typeof SelectPromptSchema>;
export type InsertPrompt = z.infer<typeof InsertPromptSchema>;
export type UpdatePrompt = z.infer<typeof UpdatePromptSchema>;
export type PromptVersionsResponse = z.infer<
  typeof PromptVersionsResponseSchema
>;
