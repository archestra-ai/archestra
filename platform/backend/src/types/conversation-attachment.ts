import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const ConversationAttachmentTextPreviewStatusSchema = z.enum([
  "pending",
  "ok",
  "failed",
  "unsupported",
]);

export type ConversationAttachmentTextPreviewStatus = z.infer<
  typeof ConversationAttachmentTextPreviewStatusSchema
>;

export const SelectConversationAttachmentSchema = createSelectSchema(
  schema.conversationAttachmentsTable,
  {
    textPreviewStatus: ConversationAttachmentTextPreviewStatusSchema,
  },
);

export const InsertConversationAttachmentSchema = createInsertSchema(
  schema.conversationAttachmentsTable,
  {
    textPreviewStatus: ConversationAttachmentTextPreviewStatusSchema.optional(),
  },
).omit({
  id: true,
  createdAt: true,
  deletedAt: true,
});

export type ConversationAttachment = z.infer<
  typeof SelectConversationAttachmentSchema
>;
export type InsertConversationAttachment = z.infer<
  typeof InsertConversationAttachmentSchema
>;

export type ConversationAttachmentWithoutData = Omit<
  ConversationAttachment,
  "fileData"
>;
