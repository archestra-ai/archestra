import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { openappaLabelChangesTable } from "@/database/schemas/openappa";

/**
 * What a dispatch handled when it changed the label. `session_start` is a
 * root's baseline row: its label as first recorded, before = after.
 */
export const LabelChangeEventSchema = z.enum([
  "session_start",
  "tool_call",
  "tool_result",
  "remedy",
  "child_return",
  "other",
]);
export type LabelChangeEvent = z.infer<typeof LabelChangeEventSchema>;

export const LabelChangeSchema = createSelectSchema(openappaLabelChangesTable, {
  event: LabelChangeEventSchema,
});
export type LabelChange = z.infer<typeof LabelChangeSchema>;

export const LabelChangeViewSchema = LabelChangeSchema.extend({
  tool: z
    .string()
    .nullable()
    .describe("The full tool name, from the record or the logged tool call"),
  rule: z
    .object({
      source: z.enum(["root", "battery", "catchall"]),
      battery: z.string().nullable(),
      batteryEntry: z.string().nullable(),
      line: z.number().int().nullable(),
      text: z.string().nullable().describe("The rule's TOML block"),
    })
    .nullable()
    .describe(
      "The rule the current policy applies to the tool (the first that names it, else the catch-all). The engine does not record which rule matched a call.",
    ),
});
