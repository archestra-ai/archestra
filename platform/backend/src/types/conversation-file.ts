import { z } from "zod";

/** One row in the chat Files panel (generated output or attachment). */
const ConversationFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  /** Existing byte endpoint for this file. */
  contentUrl: z.string(),
  createdAt: z.string(),
});

/**
 * Files for a conversation, grouped by source. The markdown artifact is
 * intentionally absent — it already ships in the conversation object and the
 * frontend synthesizes its `artifact.md` row.
 */
export const ConversationFilesResponseSchema = z.object({
  generated: z.array(ConversationFileSchema),
  attachments: z.array(ConversationFileSchema),
});
export type ConversationFilesResponse = z.infer<
  typeof ConversationFilesResponseSchema
>;
