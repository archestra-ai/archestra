import { z } from "zod";

/**
 * How an agent touched a pre-existing file in a conversation. `read` = read by
 * the agent — pulled into the sandbox via upload_file's my_file source, or read
 * inline with read_file; `edit` = changed in place via edit_file. Files created
 * in the conversation are tracked separately by `files.conversation_id`, not
 * here.
 */
export const ConversationFileTouchKindSchema = z.enum(["read", "edit"]);
export type ConversationFileTouchKind = z.infer<
  typeof ConversationFileTouchKindSchema
>;
