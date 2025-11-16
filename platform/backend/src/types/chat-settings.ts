import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectChatSettingsSchema = createSelectSchema(
  schema.chatSettingsTable,
);

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
export type InsertChatSettings = z.infer<typeof InsertChatSettingsSchema>;
export type UpdateChatSettings = z.infer<typeof UpdateChatSettingsSchema>;
