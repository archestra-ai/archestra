import {
  MAX_SUGGESTED_PROMPT_TEXT_LENGTH,
  MAX_SUGGESTED_PROMPT_TITLE_LENGTH,
} from "@shared";
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
  summaryTitle: z
    .string()
    .min(1, "Summary title is required")
    .max(
      MAX_SUGGESTED_PROMPT_TITLE_LENGTH,
      `Summary title must be at most ${MAX_SUGGESTED_PROMPT_TITLE_LENGTH} characters`,
    ),
  prompt: z
    .string()
    .min(1, "Prompt is required")
    .max(
      MAX_SUGGESTED_PROMPT_TEXT_LENGTH,
      `Prompt must be at most ${MAX_SUGGESTED_PROMPT_TEXT_LENGTH} characters`,
    ),
});

export type SuggestedPrompt = z.infer<typeof SelectSuggestedPromptSchema>;
export type InsertSuggestedPrompt = z.infer<typeof InsertSuggestedPromptSchema>;
export type SuggestedPromptInput = z.infer<typeof SuggestedPromptInputSchema>;
