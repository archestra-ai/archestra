import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectSuggestedPromptSchema = createSelectSchema(
  schema.agentSuggestedPromptsTable,
);

export const InsertSuggestedPromptSchema = createInsertSchema(
  schema.agentSuggestedPromptsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

/** Lightweight schema for embedding in agent create/update requests */
export const SuggestedPromptInputSchema = z.object({
  summaryTitle: z.string().min(1, "Summary title is required"),
  prompt: z.string().min(1, "Prompt is required"),
});

export type SuggestedPrompt = z.infer<typeof SelectSuggestedPromptSchema>;
export type InsertSuggestedPrompt = z.infer<typeof InsertSuggestedPromptSchema>;
export type SuggestedPromptInput = z.infer<typeof SuggestedPromptInputSchema>;
