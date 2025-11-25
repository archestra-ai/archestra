import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectPromptSchema = createSelectSchema(schema.promptsTable);

export const InsertPromptSchema = createInsertSchema(schema.promptsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  organizationId: true,
});

export const UpdatePromptSchema = createUpdateSchema(schema.promptsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  organizationId: true,
  agentId: true, // Don't allow changing agent
});

export type Prompt = z.infer<typeof SelectPromptSchema>;
export type InsertPrompt = z.infer<typeof InsertPromptSchema>;
export type UpdatePrompt = z.infer<typeof UpdatePromptSchema>;
