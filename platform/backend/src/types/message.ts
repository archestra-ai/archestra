import { ChatMessageFeedbackSchema } from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const MessageFeedbackSchema = ChatMessageFeedbackSchema;
export type MessageFeedback = z.infer<typeof MessageFeedbackSchema>;

export const SelectMessageSchema = createSelectSchema(schema.messagesTable, {
  feedback: MessageFeedbackSchema.nullable(),
});
export const InsertMessageSchema = createInsertSchema(schema.messagesTable, {
  feedback: MessageFeedbackSchema.nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
});

export type Message = z.infer<typeof SelectMessageSchema>;
export type InsertMessage = z.infer<typeof InsertMessageSchema>;
