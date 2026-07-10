import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectChatOpsThreadConversationSchema = createSelectSchema(
  schema.chatopsThreadConversationsTable,
);

export type ChatOpsThreadConversation = z.infer<
  typeof SelectChatOpsThreadConversationSchema
>;
