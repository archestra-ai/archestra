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
  "agent.imported",
  // `.purged` = permanent deletion from the trash. Deliberately distinct from
  // `.deleted` (which soft-deletes and is recoverable), and deliberately
  // recorded with identity only — a purge record must not preserve a copy of
  // the content the caller asked to destroy.
  "agent.purged",
  "agentTool.created",
  "agentTool.updated",
  "agentTool.deleted",
  "agentTool.bulk_assigned",
  "agentTool.bulk_removed",
  // One editor save applies adds and removals together, so it is neither a
  // pure grant nor a pure revocation — `.bulk_updated` covers the combined
  // operation that `/api/agents/tools/bulk-update` performs.
  "agentTool.bulk_updated",
  "apiKey.created",
  "apiKey.deleted",
  "app.created",
  "app.updated",
  "app.deleted",
  "chatOpsBinding.created",
  "chatOpsBinding.updated",
  "chatOpsBinding.deleted",
  "chatOpsBinding.refreshed",
  "chatOpsConfig.updated",
  "connector.created",
  "connector.updated",
  "connector.deleted",
  "connector.restored",
  "connector.purged",
  "connector.permission_sync_triggered",
  "connector.synced",
  "defaultUserLimit.created",
  "defaultUserLimit.updated",
  "defaultUserLimit.deleted",
  "environment.created",
  "environment.updated",
  "environment.deleted",
  "githubAppConfig.created",
  "githubAppConfig.updated",
  "githubAppConfig.deleted",
  "githubPat.created",
  "githubPat.updated",
  "githubPat.deleted",
  "identityProvider.created",
  "identityProvider.updated",
  "identityProvider.deleted",
  "internalMcpCatalog.created",
  "internalMcpCatalog.updated",
  "internalMcpCatalog.deleted",
  "internalMcpCatalog.restored",
  "internalMcpCatalog.reinstalled",
  "invitation.created",
  "invitation.deleted",
  "knowledgeBase.created",
  "knowledgeBase.updated",
  "knowledgeBase.deleted",
  "knowledgeBase.restored",
  "knowledgeBase.purged",
  "limit.created",
  "limit.updated",
  "limit.deleted",
  "llmModel.updated",
  "llmModel.synced",
  "llmOauthClient.created",
  "llmOauthClient.updated",
  "llmOauthClient.deleted",
  "llmOauthClient.rotated",
  "llmProviderApiKey.created",
  "llmProviderApiKey.deleted",
  "mcpOauthClient.created",
  "mcpOauthClient.updated",
  "mcpOauthClient.deleted",
  "mcpOauthClient.rotated",
  "mcpServer.created",
  "mcpServer.updated",
  "mcpServer.deleted",
  "mcpServer.restored",
  "mcpServer.reinstalled",
  // Retired with the MCP server installation request feature. Kept in the
  // vocabulary because audit rows written before its removal still carry these
  // names — dropping them would render that history as raw dotted keys. No
  // route produces them any more.
  "mcpServerInstallationRequest.created",
  "mcpServerInstallationRequest.updated",
  "member.created",
  "member.role_updated",
  "member.deleted",
  "optimizationRule.created",
  "optimizationRule.updated",
  "optimizationRule.deleted",
  "organization.updated",
  "project.created",
  "project.updated",
  "project.deleted",
  "project.restored",
  "project.purged",
  "role.created",
  "role.updated",
  "role.deleted",
  "scheduleTrigger.created",
  "scheduleTrigger.updated",
  "scheduleTrigger.deleted",
  "scheduleTrigger.triggered",
  "serviceAccount.created",
  "serviceAccount.updated",
  "serviceAccount.deleted",
  "skill.created",
  "skill.updated",
  "skill.deleted",
  "skill.restored",
  "skill.purged",
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
  "user.password_reset",
  "userToken.rotated",
  "virtualApiKey.created",
  "virtualApiKey.deleted",
  // Auth surface
  "auth.impersonation_started",
  "auth.impersonation_stopped",
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
  // Persisted rows are re-validated on read-back, so this must tolerate
  // actions written by other releases (the registered-action set changes
  // between versions); one nonconforming row would otherwise 500 the entire
  // audit log listing. Writes stay strict via InsertAuditLogSchema.
  action: AuditEventNameSchema.or(z.string()),
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

/**
 * Read shape: audit rows joined with the impersonator's current email so the
 * UI can attribute impersonated actions without an id-only display.
 */
export const AuditLogWithImpersonatorSchema = SelectAuditLogSchema.extend({
  impersonatedByEmail: z.string().nullable(),
});
export type AuditLogWithImpersonator = z.infer<
  typeof AuditLogWithImpersonatorSchema
>;
export type InsertAuditLog = z.infer<typeof InsertAuditLogSchema>;
