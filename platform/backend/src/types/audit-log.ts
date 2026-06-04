import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * Closed vocabulary of audit event names. Dotted form: `<resourceType>.<verb>`
 * for resource events, `auth.<verb>` for authentication events.
 *
 * Adding a new event requires:
 * 1. Appending the name here (alphabetically grouped by prefix).
 * 2. Wiring it to a route in `AUDITABLE_ROUTES` (either by override or by
 *    method-derivation against an existing `resourceType`).
 * 3. Adding a human-readable label in the frontend
 *    `audit-log-action-labels.ts` ACTION_LABEL map.
 */
export const AuditEventNameSchema = z.enum([
  // Resource CRUD — alphabetical by prefix
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "agent.restored",
  "agentTool.created",
  "agentTool.updated",
  "agentTool.deleted",
  "agentTool.bulk_assigned",
  "apiKey.created",
  "apiKey.deleted",
  "chatOpsBinding.created",
  "chatOpsBinding.updated",
  "chatOpsBinding.deleted",
  "chatOpsBinding.refreshed",
  "chatOpsConfig.updated",
  "connector.created",
  "connector.updated",
  "connector.deleted",
  "environment.created",
  "environment.updated",
  "environment.deleted",
  "identityProvider.created",
  "identityProvider.updated",
  "identityProvider.deleted",
  "internalMcpCatalog.created",
  "internalMcpCatalog.updated",
  "internalMcpCatalog.deleted",
  "invitation.created",
  "invitation.deleted",
  "knowledgeBase.created",
  "knowledgeBase.updated",
  "knowledgeBase.deleted",
  "limit.created",
  "limit.updated",
  "limit.deleted",
  "llmModel.updated",
  "llmModel.synced",
  "llmOauthClient.created",
  "llmOauthClient.updated",
  "llmOauthClient.deleted",
  "llmProviderApiKey.created",
  "llmProviderApiKey.deleted",
  "mcpServer.created",
  "mcpServer.updated",
  "mcpServer.deleted",
  "mcpServer.reinstalled",
  "mcpServerInstallationRequest.created",
  "mcpServerInstallationRequest.updated",
  "member.created",
  "member.role_updated",
  "member.deleted",
  "optimizationRule.created",
  "optimizationRule.updated",
  "optimizationRule.deleted",
  "organization.updated",
  "role.created",
  "role.updated",
  "role.deleted",
  "scheduleTrigger.created",
  "scheduleTrigger.updated",
  "scheduleTrigger.deleted",
  "serviceAccount.created",
  "serviceAccount.updated",
  "serviceAccount.deleted",
  "skill.created",
  "skill.updated",
  "skill.deleted",
  "skill.imported",
  "team.created",
  "team.updated",
  "team.deleted",
  "teamToken.rotated",
  "tool.deleted",
  "toolInvocationPolicy.created",
  "toolInvocationPolicy.updated",
  "toolInvocationPolicy.deleted",
  "toolInvocationPolicy.bulk_defaulted",
  "toolInvocationPolicy.auto_configured",
  "trustedDataPolicy.created",
  "trustedDataPolicy.updated",
  "trustedDataPolicy.deleted",
  "trustedDataPolicy.bulk_defaulted",
  "userToken.rotated",
  "virtualApiKey.created",
  "virtualApiKey.deleted",
  // Auth surface
  "auth.signed_in",
  "auth.signed_out",
  "auth.signed_up",
  "auth.sso_callback",
  // Catch-all for unregistered routes; logged + warned so we can extend.
  "unknown.created",
  "unknown.updated",
  "unknown.deleted",
]);
export type AuditEventName = z.infer<typeof AuditEventNameSchema>;

export const AuditActorTypeSchema = z.enum([
  "user",
  "api_key",
  "service_account",
  "system",
  "sso",
]);
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const AuditOutcomeSchema = z.enum(["success", "failure", "denied"]);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

export const AuditableSnapshotSchema = z
  .record(z.string(), z.unknown())
  .nullable();
export type AuditableSnapshot = z.infer<typeof AuditableSnapshotSchema>;

export const SelectAuditLogSchema = createSelectSchema(schema.auditLogsTable, {
  action: AuditEventNameSchema,
  actorType: AuditActorTypeSchema,
  outcome: AuditOutcomeSchema,
}).extend({
  before: AuditableSnapshotSchema,
  after: AuditableSnapshotSchema,
});

export const InsertAuditLogSchema = createInsertSchema(schema.auditLogsTable, {
  action: AuditEventNameSchema,
  actorType: AuditActorTypeSchema,
  outcome: AuditOutcomeSchema,
})
  .omit({ id: true, eventSequence: true, createdAt: true })
  .extend({
    before: AuditableSnapshotSchema.optional(),
    after: AuditableSnapshotSchema.optional(),
  });

export type AuditLog = z.infer<typeof SelectAuditLogSchema>;
export type InsertAuditLog = z.infer<typeof InsertAuditLogSchema>;
