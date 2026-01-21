import { IncomingEmailSecurityModeSchema } from "@shared";
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

export const InsertPromptSchema = createInsertSchema(
  schema.promptsTable,
  insertExtendedFields,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  organizationId: true,
  history: true,
});

export const UpdatePromptSchema = createUpdateSchema(
  schema.promptsTable,
  insertExtendedFields, // Use optional schema for updates too
).omit({
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
