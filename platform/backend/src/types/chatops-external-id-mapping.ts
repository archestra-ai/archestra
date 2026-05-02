import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectChatOpsExternalIdMappingSchema = createSelectSchema(
  schema.chatopsExternalIdMappingTable,
);

export const InsertChatOpsExternalIdMappingSchema = createInsertSchema(
  schema.chatopsExternalIdMappingTable,
).omit({
  id: true,
  createdAt: true,
});

export type ChatOpsExternalIdMapping = z.infer<
  typeof SelectChatOpsExternalIdMappingSchema
>;
export type InsertChatOpsExternalIdMapping = z.infer<
  typeof InsertChatOpsExternalIdMappingSchema
>;
