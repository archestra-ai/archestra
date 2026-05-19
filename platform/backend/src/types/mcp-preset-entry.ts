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

/**
 * Validates that a string is a valid JavaScript regex source. Stored without
 * delimiters or flags.
 */
export const ValidationRegexSchema = z
  .string()
  .max(1000)
  .refine(
    (val) => {
      try {
        new RegExp(val);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Must be a valid regular expression" },
  );

export const CreateMcpPresetEntrySchema = z.object({
  name: z.string().trim().min(1).max(50),
  validationRegex: ValidationRegexSchema.nullable().optional(),
});

/**
 * Name is immutable — see schema comment. Only the validation regex can be
 * updated after creation. Send `null` to clear it.
 */
export const UpdateMcpPresetEntrySchema = z.object({
  validationRegex: ValidationRegexSchema.nullable(),
});

export type McpPresetEntry = z.infer<typeof SelectMcpPresetEntrySchema>;
export type McpPresetEntryWithAssignedCount = z.infer<
  typeof McpPresetEntryWithAssignedCountSchema
>;
export type CreateMcpPresetEntry = z.infer<typeof CreateMcpPresetEntrySchema>;
export type UpdateMcpPresetEntry = z.infer<typeof UpdateMcpPresetEntrySchema>;
