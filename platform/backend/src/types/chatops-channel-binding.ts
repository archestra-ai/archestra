import { CHANNEL_INSTRUCTIONS_MAX_LENGTH } from "@archestra/shared";
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

/**
 * Per-channel instructions as they arrive from the API: trimmed, and normalized
 * to `null` when blank so "cleared" is stored the same way as "never set".
 * Optional at the outermost level, so an update that omits the field leaves the
 * stored instructions alone rather than erasing them.
 */
const ChannelInstructionsSchema = z
  .string()
  .max(CHANNEL_INSTRUCTIONS_MAX_LENGTH)
  .nullable()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  })
  .optional();

export const UpdateChatOpsChannelBindingSchema = createUpdateSchema(
  schema.chatopsChannelBindingsTable,
  {
    channelInstructions: ChannelInstructionsSchema,
  },
).pick({
  agentId: true,
  answerAllMessages: true,
  channelInstructions: true,
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
