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
  "resourcePermissions.updated",
  "hook.created",
  "hook.updated",
  "hook.deleted",
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
  "agent.bulk_deleted",
  "agentRun.created",
  "agentRun.canceled",
  "agentRun.updated",
  "agentRun.deleted",
  "agentRun.reviewDecided",
  // An admin signed a member out of the browser: their saved cookies were deleted
  "browserStorageState.deleted",
  "credential.created",
  "credential.updated",
  "credential.deleted",
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
  "clientConnection.updated",
  "connectedClient.disconnected",
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
  "knowledgeDirectory.bulk_deleted",
  "knowledgeFile.created",
  "knowledgeFile.updated",
  "knowledgeFile.content_upserted",
  "knowledgeFile.deleted",
  "knowledgeFile.bulk_deleted",
  "limit.created",
  "limit.updated",
  "limit.reset",
  "limit.deleted",
  "limit.bulk_deleted",
  "llmModel.updated",
  "llmModel.synced",
  "llmModel.bulk_updated",
  "oauthClient.created",
  "oauthClient.updated",
  "oauthClient.deleted",
  "oauthClient.rotated",
  "oauthClient.bulk_deleted",
  "llmProviderApiKey.created",
  "llmProviderApiKey.updated",
  "llmProviderApiKey.deleted",
  "llmProxy.updated",
  "llmProviderApiKey.bulk_deleted",
  "mcpServer.created",
  "mcpServer.updated",
  "mcpServer.deleted",
  "mcpServer.restored",
  "mcpServer.reinstalled",
  "mcpServer.hardReset",
  "mcpServer.bulk_deleted",
  "member.bulk_deleted",
  "member.created",
  "member.role_updated",
  "member.deleted",
  "organization.updated",
  "project.created",
  "project.updated",
  "project.deleted",
  "project.restored",
  "project.purged",
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
  "skill.deleted",
  // Soft-deleted across a batch of skills in one request. Distinct from the
  // per-skill actions so a sweep over many skills is recognizable as one act
  // rather than a burst of unrelated edits.
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
  "guardrailsPolicy.updated",
  "openappaYell.updated",
  "openappaBatteryInstall.created",
  "openappaBatteryInstall.updated",
  "openappaBatteryInstall.deleted",
  "openappaBatteryPackage.updated",
  "openappaBatteryPackage.deleted",
  "openappaCredentialBinding.updated",
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
