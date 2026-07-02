import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectProjectMemorySchema = createSelectSchema(
  schema.projectMemoriesTable,
);
export type ProjectMemory = z.infer<typeof SelectProjectMemorySchema>;

/** One memory entry as the API returns it to the Memory panel. */
export const ProjectMemoryItemSchema = z.object({
  id: z.string().uuid(),
  content: z.string(),
  /** Display name of the entry's author; null when unresolvable (deleted user). */
  authorName: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ProjectMemoryItem = z.infer<typeof ProjectMemoryItemSchema>;
