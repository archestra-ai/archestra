import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { UserSchema } from "./user";

export const AuditActorSchema = UserSchema.pick({
  id: true,
  name: true,
  email: true,
  image: true,
}).nullable();

export const SelectAuditEventSchema = createSelectSchema(schema.auditEventsTable, {
  metadata: z.record(z.string(), z.unknown()).nullable(),
}).extend({
  actor: AuditActorSchema.optional(),
});
export const InsertAuditEventSchema = createInsertSchema(
  schema.auditEventsTable,
  {
    metadata: z.record(z.string(), z.unknown()).nullable(),
  },
).omit({ id: true, createdAt: true });

export type AuditEvent = z.infer<typeof SelectAuditEventSchema>;
export type InsertAuditEvent = z.infer<typeof InsertAuditEventSchema>;
