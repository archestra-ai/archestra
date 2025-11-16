import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { UuidIdSchema } from "./api";
import { SelectPromptSchema } from "./prompt";

export const AssignAgentPromptsSchema = z.object({
  systemPromptId: UuidIdSchema.optional().nullable(),
  regularPromptIds: z.array(UuidIdSchema).optional(),
});

export const SelectAgentPromptSchema = createSelectSchema(
  schema.agentPromptsTable,
);

export const SelectAgentPromptWithDetailsSchema =
  SelectAgentPromptSchema.extend({
    prompt: SelectPromptSchema,
  });

export const InsertAgentPromptSchema = createInsertSchema(
  schema.agentPromptsTable,
).omit({
  id: true,
  createdAt: true,
});

export const UpdateAgentPromptSchema = createUpdateSchema(
  schema.agentPromptsTable,
).omit({
  id: true,
  createdAt: true,
});

export type AssignAgentPrompts = z.infer<typeof AssignAgentPromptsSchema>;
export type AgentPrompt = z.infer<typeof SelectAgentPromptSchema>;
export type InsertAgentPrompt = z.infer<typeof InsertAgentPromptSchema>;
export type UpdateAgentPrompt = z.infer<typeof UpdateAgentPromptSchema>;
