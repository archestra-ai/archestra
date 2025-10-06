import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { OpenAi } from "./llm-providers";

/**
 * As we support more llm provider types, this type will expand and should be updated
 */
const InteractionContentSchema = z.union([OpenAi.Messages.MessageParamSchema]);

export const SelectInteractionSchema = createSelectSchema(
  schema.interactionsTable,
  {
    content: InteractionContentSchema,
  },
);
export const InsertInteractionSchema = createInsertSchema(
  schema.interactionsTable,
  {
    content: InteractionContentSchema,
  },
);

export type Interaction = z.infer<typeof SelectInteractionSchema>;
export type InsertInteraction = z.infer<typeof InsertInteractionSchema>;

export type InteractionContent = z.infer<typeof InteractionContentSchema>;
