import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Audit log metadata — additional context about the event.
 * - ip: Request IP address
 * - userAgent: Browser / client user-agent string
 * - diff: Optional object describing what changed (old/new values)
 */
export const AuditLogMetadataSchema = z.object({
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  diff: z.record(z.string(), z.unknown()).nullable(),
});

export type AuditLogMetadata = z.infer<typeof AuditLogMetadataSchema>;

/**
 * Select schema for audit logs (includes joined userName)
 */
export const SelectAuditLogSchema = createSelectSchema(
  schema.auditLogsTable,
  {
    metadata: AuditLogMetadataSchema,
  },
).extend({
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
});

/**
 * Insert schema for audit logs
 */
export const InsertAuditLogSchema = createInsertSchema(
  schema.auditLogsTable,
  {
    metadata: AuditLogMetadataSchema,
  },
).omit({
  id: true,
  createdAt: true,
});

export type AuditLog = z.infer<typeof SelectAuditLogSchema>;
export type InsertAuditLog = z.infer<typeof InsertAuditLogSchema>;

/**
 * Action type constants for consistent audit log entries.
 */
export const AuditLogAction = {
  // User management
  UserInvited: "user.invited",
  UserDeleted: "user.deleted",
  UserRoleChanged: "user.role_changed",

  // Role management
  RoleCreated: "role.created",
  RoleUpdated: "role.updated",
  RoleDeleted: "role.deleted",

  // API Keys
  ApiKeyCreated: "api_key.created",
  ApiKeyDeleted: "api_key.deleted",

  // Organization settings
  OrgSettingsUpdated: "org.settings_updated",

  // Team management
  TeamCreated: "team.created",
  TeamUpdated: "team.updated",
  TeamDeleted: "team.deleted",
  TeamMembershipChanged: "team.membership_changed",

  // Identity providers
  IdpCreated: "idp.created",
  IdpUpdated: "idp.updated",
  IdpDeleted: "idp.deleted",

  // Secrets
  SecretUpdated: "secret.updated",

  // Audit log itself (for completeness)
  AuditLogRetentionCleared: "audit_log.retention_cleared",
} as const;

export type AuditLogActionType = (typeof AuditLogAction)[keyof typeof AuditLogAction];
