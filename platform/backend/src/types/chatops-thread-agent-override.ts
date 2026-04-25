import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectChatOpsThreadAgentOverrideSchema = createSelectSchema(
  schema.chatopsThreadAgentOverrideTable,
);

export type ChatOpsThreadAgentOverride = z.infer<
  typeof SelectChatOpsThreadAgentOverrideSchema
>;
