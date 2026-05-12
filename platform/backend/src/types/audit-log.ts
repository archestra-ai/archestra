import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const AuditActionSchema = z.enum([
  "create",
  "update",
  "delete",
  "sign_in",
  "sign_out",
  "sign_up",
  "sso_callback",
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const AuditableSnapshotSchema = z
  .record(z.string(), z.unknown())
  .nullable();
export type AuditableSnapshot = z.infer<typeof AuditableSnapshotSchema>;

export const SelectAuditLogSchema = createSelectSchema(schema.auditLogsTable, {
  action: AuditActionSchema,
}).extend({
  priorState: AuditableSnapshotSchema,
  postState: AuditableSnapshotSchema,
});

export const InsertAuditLogSchema = createInsertSchema(schema.auditLogsTable, {
  action: AuditActionSchema,
})
  .omit({ id: true, createdAt: true })
  .extend({
    priorState: AuditableSnapshotSchema.optional(),
    postState: AuditableSnapshotSchema.optional(),
  });

export type AuditLog = z.infer<typeof SelectAuditLogSchema>;
export type InsertAuditLog = z.infer<typeof InsertAuditLogSchema>;
