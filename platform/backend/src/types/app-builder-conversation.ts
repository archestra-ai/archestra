import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectAppBuilderConversationSchema = createSelectSchema(
  schema.appBuilderConversationsTable,
);
export type AppBuilderConversation = z.infer<
  typeof SelectAppBuilderConversationSchema
>;

export const InsertAppBuilderConversationSchema = createInsertSchema(
  schema.appBuilderConversationsTable,
).omit({ id: true, createdAt: true });
export type InsertAppBuilderConversation = z.infer<
  typeof InsertAppBuilderConversationSchema
>;
