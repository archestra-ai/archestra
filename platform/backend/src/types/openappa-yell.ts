import { CursorQuerySchema } from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { openappaYellsTable } from "@/database/schemas/openappa-yell";

export const OpenAppaYellSchema = createSelectSchema(openappaYellsTable)
  .omit({ archive: true })
  .extend({ hasArchive: z.boolean() });
export const InsertOpenAppaYellSchema = createInsertSchema(
  openappaYellsTable,
).pick({
  organizationId: true,
  callerId: true,
  sessionId: true,
  toolCallId: true,
  message: true,
  withTrajectory: true,
});
export type InsertOpenAppaYell = z.infer<typeof InsertOpenAppaYellSchema>;
export const OpenAppaYellQuerySchema = CursorQuerySchema.extend({
  search: z.string().max(200).optional(),
  status: z.enum(["unresolved", "resolved", "all"]).default("unresolved"),
});
export type OpenAppaYellQuery = z.infer<typeof OpenAppaYellQuerySchema>;
