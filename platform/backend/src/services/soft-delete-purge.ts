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
  /**
   * Global batched scan for rows soft-deleted longer ago than the window —
   * no per-org loop. Rows whose organization cannot be resolved are excluded:
   * purging them would destroy data with no audit trail (see
   * `countUnresolvable`).
   */
  findExpired: (params: {
    retentionDays: number;
    limit: number;
  }) => Promise<{ id: string; organizationId: string }[]>;
  /**
   * Expired rows `findExpired` will never return because no organization
   * resolves for them (legacy unowned+teamless installs, orphan tools).
   * Only the two tables without an org column can produce these.
   */
  countUnresolvable?: (params: { retentionDays: number }) => Promise<number>;
  /**
   * The same hardDelete the manual permanent-delete routes use. Resolves
   * false when the row was skipped — restored or aged back under the window
   * (the FOR UPDATE re-check), or still referenced (a catalog with installs,
   * a skill pinned by a sandbox mount); the next sweep retries.
   */
  hardDelete: (
    id: string,
    opts: { onlyIfDeletedForDays: number },
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
    organizationId: string;
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
    auditAction: "tool.purged",
    findExpired: (params) => ToolModel.findExpiredDeleted(params),
    countUnresolvable: (params) =>
      ToolModel.countExpiredDeletedUnresolvable(params),
    hardDelete: (id, opts) => ToolModel.hardDelete(id, opts),
    identity: ({ id }) => ToolModel.findIdentityForAudit(id),
  },
  {
    key: "mcpServer",
    auditAction: "mcpServer.purged",
    findExpired: (params) => McpServerModel.findExpiredDeleted(params),
    countUnresolvable: (params) =>
      McpServerModel.countExpiredDeletedUnresolvable(params),
    hardDelete: (id, opts) => McpServerModel.hardDelete(id, opts),
    identity: ({ id }) => McpServerModel.findIdentityForAudit(id),
  },
  {
    key: "internalMcpCatalog",
    auditAction: "internalMcpCatalog.purged",
    findExpired: (params) => InternalMcpCatalogModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => InternalMcpCatalogModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      InternalMcpCatalogModel.findIdentityForAudit(id, organizationId),
  },
  {
    key: "knowledgeBaseConnector",
    auditAction: "connector.purged",
    findExpired: (params) =>
      KnowledgeBaseConnectorModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => KnowledgeBaseConnectorModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      KnowledgeBaseConnectorModel.findIdentityForAudit(id, organizationId),
  },
  {
    key: "knowledgeBase",
    auditAction: "knowledgeBase.purged",
    findExpired: (params) => KnowledgeBaseModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => KnowledgeBaseModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      KnowledgeBaseModel.findIdentityForAudit(id, organizationId),
  },
  {
    key: "app",
    auditAction: "app.purged",
    findExpired: (params) => AppModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => AppModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      AppModel.findIdentityForAudit(id, organizationId),
  },
  {
    key: "skill",
    auditAction: "skill.purged",
    findExpired: (params) => SkillModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => SkillModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      SkillModel.findIdentityForAudit(id, organizationId),
  },
  {
    key: "agent",
    auditAction: "agent.purged",
    findExpired: (params) => AgentModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => AgentModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      AgentModel.findIdentityForAudit(id, organizationId),
  },
  {
    key: "project",
    auditAction: "project.purged",
    findExpired: (params) => ProjectModel.findExpiredDeleted(params),
    hardDelete: (id, opts) => ProjectModel.hardDelete(id, opts),
    identity: ({ id, organizationId }) =>
      ProjectModel.findIdentityForAudit(id, organizationId),
  },
];
