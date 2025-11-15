import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const PromptTypeSchema = z.enum(["system", "regular"]);

export const SelectPromptSchema = createSelectSchema(schema.promptsTable, {
  type: PromptTypeSchema,
});

export const SelectPromptWithAgentsSchema = SelectPromptSchema.extend({
  agents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
});

export const InsertPromptSchema = createInsertSchema(schema.promptsTable, {
  type: PromptTypeSchema,
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  organizationId: true,
  createdBy: true,
  parentPromptId: true,
  isActive: true,
  version: true,
});

export const UpdatePromptSchema = createUpdateSchema(schema.promptsTable, {
  type: PromptTypeSchema,
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  organizationId: true,
  createdBy: true,
  type: true,
  parentPromptId: true,
  isActive: true,
  version: true,
});

export type Prompt = z.infer<typeof SelectPromptSchema>;
export type PromptWithAgents = z.infer<typeof SelectPromptWithAgentsSchema>;
export type InsertPrompt = z.infer<typeof InsertPromptSchema>;
export type UpdatePrompt = z.infer<typeof UpdatePromptSchema>;

export type PromptType = z.infer<typeof PromptTypeSchema>;
