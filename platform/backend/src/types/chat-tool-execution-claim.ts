import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const StateSchema = z.enum(["executing", "completed", "failed"]);

export type State = z.infer<typeof StateSchema>;

/**
 * Bounded replay payload recorded on a completed/failed claim: the tool
 * result's plain-text content (size-capped, binary/UI metadata stripped) plus
 * whether the winner returned a bare string or a `{ content }` object, so a
 * replay can reproduce the original shape.
 */
export const StoredResultSchema = z.object({
  resultKind: z.enum(["text", "content"]),
  content: z.string(),
  truncated: z.boolean(),
});

export type StoredResult = z.infer<typeof StoredResultSchema>;

export const SelectSchema = createSelectSchema(
  schema.chatToolExecutionClaimsTable,
  {
    state: StateSchema,
    result: StoredResultSchema.nullable(),
  },
);

export type Select = z.infer<typeof SelectSchema>;
