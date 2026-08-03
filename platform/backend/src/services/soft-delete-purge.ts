import type { HardDeleteOpts } from "@/database/soft-delete";
import {
  AgentModel,
  AppModel,
  InternalMcpCatalogModel,
  KnowledgeBaseConnectorModel,
  KnowledgeBaseModel,
  McpServerModel,
  ProjectModel,
  SkillModel,
  ToolModel,
} from "@/models";
import type { AuditableSnapshot, AuditEventName } from "@/types/audit-log";

/**
 * One entry per entity the soft-delete retention sweep purges, so the sweep
 * is a loop rather than nine bespoke branches. Conversations are deliberately
 * absent: the Enterprise content-retention job owns them (and their
 * attachments cascade with them).
 */
export type PurgeableEntity = {
  key:
    | "tool"
    | "mcpServer"
    | "internalMcpCatalog"
    | "knowledgeBaseConnector"
    | "knowledgeBase"
    | "app"
    | "skill"
    | "agent"
    | "project";
  auditAction: AuditEventName;
  /** Audit-registry resourceType vocabulary (audit-log-registry.ts). */
  resourceType: string;
  /**
   * Global batched scan for rows soft-deleted longer ago than the window —
   * no per-org loop, oldest first with an id tie-break. `offset` is the
   * sweep's count of rows it scanned but could not purge, paging the scan
   * past them (see sweepEntity for why that arithmetic is sound). Rows whose
   * organization cannot be resolved are excluded: purging them would destroy
   * data with no audit trail (see `countUnresolvable`).
   *
   * A null `organizationId` means the row genuinely belongs to no tenant —
   * only the global `internal_mcp_catalog` entries — and is purged without an
   * audit row rather than skipped. Not the same case as an unresolvable org.
   */
  findExpired: (params: {
    retentionDays: number;
    limit: number;
    offset: number;
  }) => Promise<{ id: string; organizationId: string | null }[]>;
  /**
   * Expired rows `findExpired` will never return because no organization
   * resolves for them (legacy unowned+teamless installs, orphan tools, an
   * install whose owner belongs to several orgs). Produced by the two tables
   * with no org column of their own.
   */
  countUnresolvable?: (params: { retentionDays: number }) => Promise<number>;
  /**
   * The same hardDelete the manual permanent-delete routes use. Resolves
   * false when the row was skipped — restored or aged back under the window
   * (the FOR UPDATE re-check), or still referenced (a catalog with installs,
   * a skill pinned by a sandbox mount); the next sweep retries. The sweep
   * writes its purge audit row via `onPurged`, inside the delete transaction.
   */
  hardDelete: (
    id: string,
    opts: HardDeleteOpts & { onlyIfDeletedForDays: number },
  ) => Promise<boolean>;
  /**
   * Identity-only audit snapshot ({ id, name, deletedAt, … }) written to the
   * purge audit row's `before`. Deliberately not a full snapshot: writing the
   * whole row into `audit_logs.before` would leave a complete copy of
   * "permanently deleted" content in a table governed by a different
   * retention window.
   */
  identity: (params: {
    id: string;
    organizationId: string | null;
  }) => Promise<AuditableSnapshot>;
};

/**
 * Dependency order matters within a sweep: installs go before their catalog
 * (`mcp_server.catalog_id` is SET NULL + NOT NULL, so a catalog cannot be
 * deleted while an install references it), and tools before both so the
 * highest-volume table drains first.
 */
export const PURGEABLE_ENTITIES: readonly PurgeableEntity[] = [
  {
    key: "tool",
    resourceType: "tool",
    auditAction: "tool.purged",
    findExpired: (params) => ToolModel.findExpiredDeleted(params),
    countUnresolvable: (params) =>
      ToolModel.countExpiredDeletedUnresolvable(params),
    hardDelete: (id, opts) => ToolModel.hardDelete(id, opts),
    identity: ({ id }) => ToolModel.findIdentityForAudit(id),
  },
  {
    key: "mcpServer",
    resourceType: "mcpServer",
    auditAction: "mcpServer.purged",
    findExpired: (params) => McpServerModel.findExpiredDeleted(params),
    countUnresolvable: (params) =>
      McpServerModel.countExpiredDeletedUnresolvable(params),
    hardDelete: (id, opts) => McpServerModel.hardDelete(id, opts),
    identity: ({ id }) => McpServerModel.findIdentityForAudit(id),
  },
  {
    key: "internalMcpCatalog",
    resourceType: "internalMcpCatalog",
    auditAction: "internalMcpCatalog.purged",
    findExpired: (params) => InternalMcpCatalogModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => InternalMcpCatalogModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      InternalMcpCatalogModel.findIdentityForAudit(id, organizationId),
  },
  {
    key: "knowledgeBaseConnector",
    resourceType: "connector",
    auditAction: "connector.purged",
    findExpired: (params) =>
      KnowledgeBaseConnectorModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => KnowledgeBaseConnectorModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      KnowledgeBaseConnectorModel.findIdentityForAudit(
        id,
        requireOrg(organizationId),
      ),
  },
  {
    key: "knowledgeBase",
    resourceType: "knowledgeBase",
    auditAction: "knowledgeBase.purged",
    findExpired: (params) => KnowledgeBaseModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => KnowledgeBaseModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      KnowledgeBaseModel.findIdentityForAudit(id, requireOrg(organizationId)),
  },
  {
    key: "app",
    resourceType: "app",
    auditAction: "app.purged",
    findExpired: (params) => AppModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => AppModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      AppModel.findIdentityForAudit(id, requireOrg(organizationId)),
  },
  {
    key: "skill",
    resourceType: "skill",
    auditAction: "skill.purged",
    findExpired: (params) => SkillModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => SkillModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      SkillModel.findIdentityForAudit(id, requireOrg(organizationId)),
  },
  {
    key: "agent",
    resourceType: "agent",
    auditAction: "agent.purged",
    findExpired: (params) => AgentModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => AgentModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      AgentModel.findIdentityForAudit(id, requireOrg(organizationId)),
  },
  {
    key: "project",
    resourceType: "project",
    auditAction: "project.purged",
    findExpired: (params) => ProjectModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => ProjectModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      ProjectModel.findIdentityForAudit(id, requireOrg(organizationId)),
  },
];

// === Internal ===

/**
 * Assert the org an entity's own NOT NULL column guarantees. Only
 * `internal_mcp_catalog` has a nullable one, so for every other entity a null
 * here means its findExpired stopped matching its schema; the sweep's per-row
 * try/catch turns the throw into a skip-and-log rather than a lost row.
 */
function requireOrg(organizationId: string | null): string {
  if (organizationId === null) {
    throw new Error("purge candidate has no organization");
  }
  return organizationId;
}
