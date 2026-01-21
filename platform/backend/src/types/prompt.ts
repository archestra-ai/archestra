import { DOMAIN_VALIDATION_REGEX, MAX_DOMAIN_LENGTH } from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

// Schema for incoming email security mode validation
export const IncomingEmailSecurityModeSchema = z.enum([
  "private",
  "internal",
  "public",
]);

export type IncomingEmailSecurityMode = z.infer<
  typeof IncomingEmailSecurityModeSchema
>;

/**
 * Parse and validate an incoming email security mode.
 * Returns the validated mode or defaults to "private" if invalid.
 */
export function parseSecurityMode(
  mode: string | undefined | null,
): IncomingEmailSecurityMode {
  const result = IncomingEmailSecurityModeSchema.safeParse(mode);
  return result.success ? result.data : "private";
}

// Re-export PromptHistoryEntry type from schema
export type { PromptHistoryEntry } from "@/database/schemas/prompt";

export const SelectPromptSchema = createSelectSchema(schema.promptsTable);

export const InsertPromptSchema = createInsertSchema(schema.promptsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  organizationId: true,
  history: true,
});

export const UpdatePromptSchema = createUpdateSchema(schema.promptsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  organizationId: true,
  version: true,
  history: true,
});

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

/**
 * Validate incoming email settings.
 * Throws an error if:
 * - Security mode is 'internal' but no allowed domain is set
 * - Security mode is 'internal' and the allowed domain exceeds max length
 * - Security mode is 'internal' and the allowed domain format is invalid
 */
export function validateIncomingEmailSettings(
  data: Partial<UpdatePrompt>,
): void {
  if (data.incomingEmailSecurityMode === "internal") {
    if (
      data.incomingEmailAllowedDomain === undefined ||
      data.incomingEmailAllowedDomain === null ||
      data.incomingEmailAllowedDomain.trim() === ""
    ) {
      throw new Error(
        "incomingEmailAllowedDomain is required when security mode is 'internal'",
      );
    }

    const domain = data.incomingEmailAllowedDomain.trim();

    if (domain.length > MAX_DOMAIN_LENGTH) {
      throw new Error(
        `incomingEmailAllowedDomain exceeds maximum length of ${MAX_DOMAIN_LENGTH} characters`,
      );
    }

    if (!DOMAIN_VALIDATION_REGEX.test(domain)) {
      throw new Error(
        "incomingEmailAllowedDomain must be a valid domain format (e.g., company.com)",
      );
    }
  }
}
