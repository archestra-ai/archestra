import { CreatedByNullableSchema, CursorQuerySchema } from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { openappaYellsTable } from "@/database/schemas/openappa-yell";

export const OpenAppaYellSchema = createSelectSchema(openappaYellsTable)
  .omit({ archive: true, conversationId: true })
  .extend({
    hasArchive: z.boolean(),
    caller: CreatedByNullableSchema,
    /** The app that sent the yell, when an app did (`callerId` `app:<id>`). */
    callerApp: z.object({ id: z.string(), name: z.string() }).nullable(),
    conversation: z
      .object({
        id: z.uuid(),
        title: z.string().nullable(),
        createdAt: z.date(),
      })
      .nullable(),
    /**
     * Where the yell shows in a session trace: its LLM session, and the logged
     * `yell` call when one matched. Null when that session logged no requests.
     */
    trace: z
      .object({
        llmSessionId: z.string(),
        mcpToolCallId: z.uuid().nullable(),
      })
      .nullable(),
  });
export const InsertOpenAppaYellSchema = createInsertSchema(
  openappaYellsTable,
).pick({
  organizationId: true,
  callerId: true,
  sessionId: true,
  toolCallId: true,
  message: true,
  withTrajectory: true,
  superyell: true,
});
export type InsertOpenAppaYell = z.infer<typeof InsertOpenAppaYellSchema>;
export const OpenAppaYellQuerySchema = CursorQuerySchema.extend({
  search: z.string().max(200).optional(),
  status: z.enum(["unresolved", "resolved", "all"]).default("unresolved"),
  /** Only the yells raised in this LLM session (the trace's own session id). */
  llmSessionId: z.string().min(1).max(512).optional(),
});
export type OpenAppaYellQuery = z.infer<typeof OpenAppaYellQuerySchema>;
