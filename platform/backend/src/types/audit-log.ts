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
  "agent.bulk_updated",
  "agent.bulk_deleted",
  "agentExecution.created",
  "agentExecution.canceled",
  "agentExecution.updated",
  "agentExecution.deleted",
  "executionCredential.created",
  "executionCredential.updated",
  "executionCredential.deleted",
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
  "apiKey.bulk_deleted",
  "app.created",
  "app.updated",
  "app.deleted",
  "app.bulk_updated",
  "app.bulk_deleted",
  "chatOpsBinding.created",
  "chatOpsBinding.updated",
  "chatOpsBinding.deleted",
  "chatOpsBinding.refreshed",
  "chatOpsConfig.updated",
  "plugin.created",
  "plugin.updated",
  "plugin.deleted",
  "plugin.syncTriggered",
  "connector.created",
  "connector.updated",
  "connector.deleted",
  "connector.restored",
  "connector.purged",
  "connector.bulk_updated",
  "connector.bulk_deleted",
  "connector.permission_sync_triggered",
  "connector.synced",
  "defaultUserLimit.created",
  "defaultUserLimit.updated",
  "defaultUserLimit.deleted",
  "environment.created",
  "environment.updated",
  "environment.deleted",
  "environment.bulk_deleted",
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
  "knowledgeBase.bulk_deleted",
  "knowledgeDirectory.created",
  "knowledgeDirectory.updated",
  "knowledgeDirectory.deleted",
  "knowledgeDirectory.bulk_updated",
  "knowledgeDirectory.bulk_deleted",
  "knowledgeFile.created",
  "knowledgeFile.updated",
  "knowledgeFile.deleted",
  "knowledgeFile.bulk_updated",
  "knowledgeFile.bulk_deleted",
  "limit.created",
  "limit.updated",
  "limit.deleted",
  "limit.bulk_deleted",
  "llmModel.updated",
  "llmModel.synced",
  "llmModel.bulk_updated",
  "llmOauthClient.created",
  "llmOauthClient.updated",
  "llmOauthClient.deleted",
  "llmOauthClient.rotated",
  "llmOauthClient.bulk_deleted",
  "llmProviderApiKey.created",
  "llmProviderApiKey.deleted",
  "llmProxy.updated",
  "llmProviderApiKey.bulk_deleted",
  "mcpOauthClient.created",
  "mcpOauthClient.updated",
  "mcpOauthClient.deleted",
  "mcpOauthClient.rotated",
  "mcpServer.created",
  "mcpServer.updated",
  "mcpServer.deleted",
  "mcpServer.restored",
  "mcpServer.reinstalled",
  "mcpServer.hardReset",
  "mcpServer.bulk_deleted",
  "member.bulk_deleted",
  // Retired with the MCP server installation request feature. Kept in the
  // vocabulary because audit rows written before its removal still carry these
  // names — dropping them would render that history as raw dotted keys. No
  // route produces them any more.
  "mcpServerInstallationRequest.created",
  "mcpServerInstallationRequest.updated",
  "member.created",
  "member.role_updated",
  "member.deleted",
  // Retired with the LLM optimization rules feature. Kept in the vocabulary
  // because audit rows written before its removal still carry these names —
  // dropping them would render that history as raw dotted keys. No route
  // produces them any more.
  "optimizationRule.created",
  "optimizationRule.updated",
  "optimizationRule.deleted",
  "organization.updated",
  "project.created",
  "project.updated",
  "project.deleted",
  "project.restored",
  "project.purged",
  "project.bulk_updated",
  "project.bulk_deleted",
  "role.created",
  "role.updated",
  "role.deleted",
  "role.bulk_deleted",
  "scheduleTrigger.created",
  "scheduleTrigger.updated",
  "scheduleTrigger.deleted",
  "scheduleTrigger.triggered",
  "serviceAccount.created",
  "serviceAccount.updated",
  "serviceAccount.deleted",
  "serviceAccount.bulk_deleted",
  "serviceAccount.bulk_updated",
  "skill.created",
  "skill.updated",
  // Visibility changed / soft-deleted across a batch of skills in one request.
  // Distinct from the per-skill actions so a sweep over many skills is
  // recognizable as one act rather than a burst of unrelated edits.
  "skill.bulk_updated",
  "skill.deleted",
  "skill.bulk_deleted",
  "skill.restored",
  "skill.purged",
  "skill.imported",
  "skillShareLink.created",
  "skillShareLink.rotated",
  "skillShareLink.revoked",
  "team.created",
  "team.updated",
  "team.deleted",
  "team.bulk_deleted",
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
  "virtualApiKey.bulk_deleted",
  // Auth surface
  "auth.impersonation_started",
  "auth.impersonation_stopped",
  "auth.signed_in",
  "auth.signed_out",
  "auth.signed_up",
  "auth.sso_callback",
  "auth.sessions_revoked",
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
