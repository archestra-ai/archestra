import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";
import { ChatOpsProviderTypeSchema } from "./chatops";

const SelectChatOpsThreadContextSchema = createSelectSchema(
  schema.chatopsThreadContextsTable,
  {
    provider: ChatOpsProviderTypeSchema,
  },
);

const InsertChatOpsThreadContextSchema = createInsertSchema(
  schema.chatopsThreadContextsTable,
  {
    provider: ChatOpsProviderTypeSchema,
  },
).omit({
  id: true,
  createdAt: true,
});

export type ChatOpsThreadContext = z.infer<
  typeof SelectChatOpsThreadContextSchema
>;
export type InsertChatOpsThreadContext = z.infer<
  typeof InsertChatOpsThreadContextSchema
>;
