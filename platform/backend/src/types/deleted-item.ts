import { z } from "zod";

/**
 * Entities that soft-delete and therefore appear in Deleted Items. Kept as a
 * standalone enum rather than derived from the model registry so the API schema
 * does not depend on the database layer.
 */
export const DeletedItemEntityTypeSchema = z.enum([
  "agent",
  "app",
  "conversation",
  "project",
  "skill",
]);
export type DeletedItemEntityType = z.infer<typeof DeletedItemEntityTypeSchema>;

export const DeletedItemSchema = z.object({
  entityType: DeletedItemEntityTypeSchema,
  id: z.string(),
  /** Null for entities that name themselves lazily (an untitled conversation). */
  name: z.string().nullable(),
  deletedAt: z.date(),
  /** False for entities that can be purged but not brought back (apps). */
  restorable: z.boolean(),
});
export type DeletedItem = z.infer<typeof DeletedItemSchema>;
