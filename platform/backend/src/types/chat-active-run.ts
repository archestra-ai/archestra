import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const ChatActiveRunStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export type ChatActiveRunStatus = z.infer<typeof ChatActiveRunStatusSchema>;

export const SelectChatActiveRunSchema = createSelectSchema(
  schema.chatActiveRunsTable,
  {
    status: ChatActiveRunStatusSchema,
  },
);

export const InsertChatActiveRunSchema = createInsertSchema(
  schema.chatActiveRunsTable,
  {
    status: ChatActiveRunStatusSchema.optional(),
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const SelectChatActiveRunEventSchema = createSelectSchema(
  schema.chatActiveRunEventsTable,
);

export const InsertChatActiveRunEventSchema = createInsertSchema(
  schema.chatActiveRunEventsTable,
).omit({
  id: true,
  createdAt: true,
});

export type ChatActiveRun = z.infer<typeof SelectChatActiveRunSchema>;
export type InsertChatActiveRun = z.infer<typeof InsertChatActiveRunSchema>;
export type ChatActiveRunEvent = z.infer<typeof SelectChatActiveRunEventSchema>;
export type InsertChatActiveRunEvent = z.infer<
  typeof InsertChatActiveRunEventSchema
>;
