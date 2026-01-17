import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
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

/**
 * Response schema for API - dates as ISO strings
 */
export const ChatOpsChannelBindingResponseSchema =
  SelectChatOpsChannelBindingSchema.extend({
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
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
