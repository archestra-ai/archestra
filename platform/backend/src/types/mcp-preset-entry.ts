import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectMcpPresetEntrySchema = createSelectSchema(
  schema.mcpPresetEntriesTable,
);

/**
 * Listing response shape — same columns as the row plus an `assignedCatalogCount`
 * computed at the model layer (number of catalog children currently linked).
 * Used by the org-structure page to render the delete-confirmation count.
 */
export const McpPresetEntryWithAssignedCountSchema =
  SelectMcpPresetEntrySchema.extend({
    assignedCatalogCount: z.number().int().nonnegative(),
  });

export const CreateMcpPresetEntrySchema = z.object({
  name: z.string().trim().min(1).max(50),
});

export type McpPresetEntry = z.infer<typeof SelectMcpPresetEntrySchema>;
export type McpPresetEntryWithAssignedCount = z.infer<
  typeof McpPresetEntryWithAssignedCountSchema
>;
export type CreateMcpPresetEntry = z.infer<typeof CreateMcpPresetEntrySchema>;
