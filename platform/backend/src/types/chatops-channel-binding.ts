import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";
import { ChatOpsProviderTypeSchema } from "./chatops";

export const SelectChatOpsChannelBindingSchema = createSelectSchema(
  schema.chatopsChannelBindingsTable,
  {
    provider: ChatOpsProviderTypeSchema,
  },
);

export const InsertChatOpsChannelBindingSchema = createInsertSchema(
  schema.chatopsChannelBindingsTable,
  {
    provider: ChatOpsProviderTypeSchema,
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateChatOpsChannelBindingSchema = createUpdateSchema(
  schema.chatopsChannelBindingsTable,
).pick({
  promptId: true,
});

export type ChatOpsChannelBinding = z.infer<
  typeof SelectChatOpsChannelBindingSchema
>;
export type InsertChatOpsChannelBinding = z.infer<
  typeof InsertChatOpsChannelBindingSchema
>;
export type UpdateChatOpsChannelBinding = z.infer<
  typeof UpdateChatOpsChannelBindingSchema
>;
