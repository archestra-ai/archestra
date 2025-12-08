import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectChatSettingsSchema = createSelectSchema(
  schema.chatSettingsTable,
);

/**
 * Extended chat settings response that includes the external vault path
 * when BYOS is configured
 */
export const ChatSettingsResponseSchema = SelectChatSettingsSchema.extend({
  /** External Vault path if the API key is sourced from BYOS Vault */
  externalVaultSecretPath: z.string().nullable().optional(),
});

export const InsertChatSettingsSchema = createInsertSchema(
  schema.chatSettingsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateChatSettingsSchema = createUpdateSchema(
  schema.chatSettingsTable,
).omit({
  id: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
});

export type ChatSettings = z.infer<typeof SelectChatSettingsSchema>;
export type ChatSettingsResponse = z.infer<typeof ChatSettingsResponseSchema>;
export type InsertChatSettings = z.infer<typeof InsertChatSettingsSchema>;
export type UpdateChatSettings = z.infer<typeof UpdateChatSettingsSchema>;
