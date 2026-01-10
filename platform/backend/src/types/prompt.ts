import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

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
