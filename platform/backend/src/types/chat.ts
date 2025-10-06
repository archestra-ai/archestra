import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { SelectInteractionSchema } from "./interaction";

export const SelectChatSchema = createSelectSchema(schema.chatsTable);
export const InsertChatSchema = createInsertSchema(schema.chatsTable);

export const ChatWithInteractionsSchema = SelectChatSchema.extend({
  interactions: z.array(SelectInteractionSchema),
});

export type Chat = z.infer<typeof SelectChatSchema>;
export type ChatWithInteractions = z.infer<typeof ChatWithInteractionsSchema>;
