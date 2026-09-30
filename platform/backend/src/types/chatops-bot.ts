import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";
import { ChatOpsProviderTypeSchema } from "./chatops";

export const SelectChatOpsBotSchema = createSelectSchema(
  schema.chatopsBotsTable,
  {
    provider: ChatOpsProviderTypeSchema,
  },
);

export type ChatOpsBot = z.infer<typeof SelectChatOpsBotSchema>;

/** Fields a caller may change on an existing bot. */
export type UpdateChatOpsBot = Partial<
  Pick<
    ChatOpsBot,
    | "name"
    | "secretId"
    | "externalAppId"
    | "externalWorkspaceId"
    | "externalBotUserId"
  >
>;
