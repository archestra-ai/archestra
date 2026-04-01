import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const ConversationShareVisibilitySchema = z.enum([
  "organization",
  "team",
  "user",
]);

export const SelectConversationShareSchema = createSelectSchema(
  schema.conversationSharesTable,
);

export const InsertConversationShareSchema = createInsertSchema(
  schema.conversationSharesTable,
).omit({
  id: true,
  createdAt: true,
});

export const SelectConversationShareWithTargetsSchema =
  SelectConversationShareSchema.extend({
    teamIds: z.array(z.string()),
    userIds: z.array(z.string()),
  });

export type ConversationShare = z.infer<typeof SelectConversationShareSchema>;
export type InsertConversationShare = z.infer<
  typeof InsertConversationShareSchema
>;
export type ConversationShareVisibility = z.infer<
  typeof ConversationShareVisibilitySchema
>;
export type ConversationShareWithTargets = z.infer<
  typeof SelectConversationShareWithTargetsSchema
>;
