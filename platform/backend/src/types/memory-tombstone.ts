import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { MemoryScopeTypeSchema } from "./memory-item";

export const MemoryTombstoneReasonSchema = z.enum([
  "deleted_by_user",
  "rejected",
  "archived",
]);
export type MemoryTombstoneReason = z.infer<typeof MemoryTombstoneReasonSchema>;

const extendedFields = {
  scopeType: MemoryScopeTypeSchema,
  reason: MemoryTombstoneReasonSchema,
};

export const SelectMemoryTombstoneSchema = createSelectSchema(
  schema.memoryTombstonesTable,
  extendedFields,
);

export const InsertMemoryTombstoneSchema = createInsertSchema(
  schema.memoryTombstonesTable,
  extendedFields,
).omit({
  id: true,
  createdAt: true,
});

export const UpdateMemoryTombstoneSchema = createUpdateSchema(
  schema.memoryTombstonesTable,
  {
    ...extendedFields,
    reason: MemoryTombstoneReasonSchema.optional(),
  },
).pick({
  reason: true,
  expiresAt: true,
});

export type MemoryTombstone = z.infer<typeof SelectMemoryTombstoneSchema>;
export type InsertMemoryTombstone = z.infer<typeof InsertMemoryTombstoneSchema>;
export type UpdateMemoryTombstone = z.infer<typeof UpdateMemoryTombstoneSchema>;
