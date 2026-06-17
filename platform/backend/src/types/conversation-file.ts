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
 * frontend synthesizes its `artifact.md` row. `myFiles` is everything the
 * agent can reach in persistent file storage from this chat: the project's
 * files for project chats, the owner's whole PFS otherwise.
 */
export const ConversationFilesResponseSchema = z.object({
  generated: z.array(ConversationFileSchema),
  attachments: z.array(ConversationFileSchema),
  myFiles: z.array(ConversationFileSchema),
  /** Set when the chat belongs to a project — `myFiles` is then the project's files. */
  projectName: z.string().nullable(),
});
export type ConversationFilesResponse = z.infer<
  typeof ConversationFilesResponseSchema
>;
