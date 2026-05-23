import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectMemoryItemSchema = createSelectSchema(
  schema.memoryItemsTable,
);

export const InsertMemoryItemSchema = createInsertSchema(
  schema.memoryItemsTable,
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const UpdateMemoryItemSchema = createUpdateSchema(
  schema.memoryItemsTable,
).omit({
  id: true,
  organizationId: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
});

export type MemoryItem = z.infer<typeof SelectMemoryItemSchema>;
export type InsertMemoryItem = z.infer<typeof InsertMemoryItemSchema>;
export type UpdateMemoryItem = z.infer<typeof UpdateMemoryItemSchema>;
