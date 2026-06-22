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
 * frontend synthesizes its `artifact.md` row. `referenced` is the pre-existing
 * persistent files the agent actually touched in this chat (read or edited),
 * NOT the full set of files the user can reach — files created in the chat are
 * in `generated`.
 */
export const ConversationFilesResponseSchema = z.object({
  generated: z.array(ConversationFileSchema),
  attachments: z.array(ConversationFileSchema),
  referenced: z.array(ConversationFileSchema),
  /** Set when the chat belongs to a project — labels the referenced section. */
  projectName: z.string().nullable(),
});
export type ConversationFilesResponse = z.infer<
  typeof ConversationFilesResponseSchema
>;
