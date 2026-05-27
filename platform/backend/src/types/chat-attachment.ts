import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const ChatAttachmentTextPreviewStatusSchema = z.enum([
  "pending",
  "ok",
  "failed",
  "unsupported",
]);

export type ChatAttachmentTextPreviewStatus = z.infer<
  typeof ChatAttachmentTextPreviewStatusSchema
>;

export const SelectChatAttachmentSchema = createSelectSchema(
  schema.chatAttachmentsTable,
  {
    textPreviewStatus: ChatAttachmentTextPreviewStatusSchema,
  },
);

export const InsertChatAttachmentSchema = createInsertSchema(
  schema.chatAttachmentsTable,
  {
    textPreviewStatus: ChatAttachmentTextPreviewStatusSchema.optional(),
  },
).omit({
  id: true,
  createdAt: true,
  deletedAt: true,
});

export type ChatAttachment = z.infer<typeof SelectChatAttachmentSchema>;
export type InsertChatAttachment = z.infer<typeof InsertChatAttachmentSchema>;

export type ChatAttachmentWithoutData = Omit<ChatAttachment, "fileData">;
