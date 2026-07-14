import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { KnowledgeSourceVisibilitySchema } from "./knowledge-base";
import {
  ConnectorCheckpointSchema,
  ConnectorConfigSchema,
  ConnectorRunTypeSchema,
  ConnectorSyncStatusSchema,
  ConnectorTypeSchema,
} from "./knowledge-connector";

// ===== Knowledge Base Schemas =====

export const SelectKnowledgeBaseSchema = createSelectSchema(
  schema.knowledgeBasesTable,
);
export const InsertKnowledgeBaseSchema = createInsertSchema(
  schema.knowledgeBasesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateKnowledgeBaseSchema = createUpdateSchema(
  schema.knowledgeBasesTable,
).pick({
  name: true,
  description: true,
  status: true,
});

export type KnowledgeBase = z.infer<typeof SelectKnowledgeBaseSchema>;
export type InsertKnowledgeBase = z.infer<typeof InsertKnowledgeBaseSchema>;
export type UpdateKnowledgeBase = z.infer<typeof UpdateKnowledgeBaseSchema>;

// ===== Knowledge Base Connector Schemas =====

const NullableConnectorSyncStatusSchema = ConnectorSyncStatusSchema.nullable();

export const SelectKnowledgeBaseConnectorSchema = createSelectSchema(
  schema.knowledgeBaseConnectorsTable,
  {
    visibility: KnowledgeSourceVisibilitySchema,
    teamIds: z.array(z.string()),
    connectorType: ConnectorTypeSchema,
    config: ConnectorConfigSchema,
    lastSyncStatus: NullableConnectorSyncStatusSchema,
    lastPermissionSyncStatus: NullableConnectorSyncStatusSchema,
  },
);
export const InsertKnowledgeBaseConnectorSchema = createInsertSchema(
  schema.knowledgeBaseConnectorsTable,
  {
    visibility: KnowledgeSourceVisibilitySchema.optional(),
    teamIds: z.array(z.string()).optional(),
    connectorType: ConnectorTypeSchema,
    config: ConnectorConfigSchema,
    checkpoint: ConnectorCheckpointSchema.optional(),
    lastSyncStatus: NullableConnectorSyncStatusSchema.optional(),
    lastPermissionSyncStatus: NullableConnectorSyncStatusSchema.optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });
export const UpdateKnowledgeBaseConnectorSchema = createUpdateSchema(
  schema.knowledgeBaseConnectorsTable,
  {
    visibility: KnowledgeSourceVisibilitySchema.optional(),
    teamIds: z.array(z.string()).optional(),
    connectorType: ConnectorTypeSchema.optional(),
    config: ConnectorConfigSchema.optional(),
    checkpoint: ConnectorCheckpointSchema.nullable().optional(),
    lastSyncStatus: NullableConnectorSyncStatusSchema.optional(),
    lastPermissionSyncStatus: NullableConnectorSyncStatusSchema.optional(),
  },
).pick({
  name: true,
  description: true,
  visibility: true,
  teamIds: true,
  config: true,
  secretId: true,
  environmentId: true,
  schedule: true,
  permissionSyncIntervalSeconds: true,
  permissionSyncState: true,
  enabled: true,
  lastSyncAt: true,
  lastSyncStatus: true,
  lastSyncError: true,
  lastPermissionSyncAt: true,
  lastPermissionSyncStatus: true,
  aclConfigEpoch: true,
  checkpoint: true,
});

export type KnowledgeBaseConnector = z.infer<
  typeof SelectKnowledgeBaseConnectorSchema
>;
export type InsertKnowledgeBaseConnector = z.infer<
  typeof InsertKnowledgeBaseConnectorSchema
>;
export type UpdateKnowledgeBaseConnector = z.infer<
  typeof UpdateKnowledgeBaseConnectorSchema
>;

// ===== Connector Run Schemas =====

/**
 * Outcome stats of a permission-sync pass, stored on its `connector_runs` row
 * (`stats` jsonb) and updated per checkpoint so a running pass shows live
 * progress. The generic document counters stay 0 for permission runs — these
 * are the family-relevant numbers an admin needs: how much of the corpus was
 * scanned, what changed, what fail-closed, and whether the pass ran while a
 * content sync was still ingesting (in which case later-ingested documents
 * stay access-restricted until the next pass).
 */
export const PermissionSyncRunStatsSchema = z.object({
  /**
   * How the pass reconciled: a probe-driven "delta" touching only drifted
   * containers, or the periodic "full" backstop that also runs the
   * vanished-container and unassigned sweeps. Optional — absent on runs from
   * before the two-tier cadence.
   */
  mode: z.enum(["full", "delta"]).optional(),
  /** Documents in the corpus when the pass started (the scan denominator). */
  totalDocs: z.number(),
  docsScanned: z.number(),
  aclsChanged: z.number(),
  chunksRewritten: z.number(),
  /** Docs no longer visible upstream, swept to an empty ACL. */
  failClosed: z.number(),
  groupsSynced: z.number(),
  membershipsUpserted: z.number(),
  /**
   * Memberships revoked upstream and deleted by the completion-gated diff —
   * without it a removal-only group sync reads as "nothing changed". Optional
   * — absent on runs from before this counter existed.
   */
  membershipsRemoved: z.number().optional(),
  /**
   * Upstream permission containers (spaces/projects/repos + nested
   * exceptions) observed by the pass. Optional — absent on runs from before
   * the container-ACL model.
   */
  containersSynced: z.number().optional(),
  /** Containers whose stored audience actually changed — the entire write cost of an upstream audience change. */
  containersChanged: z.number().optional(),
  /**
   * Containers whose upstream permissions could NOT be read (a failed Jira
   * permission-scheme / security-level lookup, Confluence space-permission or
   * restriction read, GitHub repo audience). Their documents are fail-closed
   * for this pass — indistinguishable, without this counter, from a container
   * upstream genuinely grants nobody. A non-zero value is the answer to "why
   * can nobody see this project?". Optional — absent on runs from before it
   * existed.
   */
  containerAudienceFailures: z.number().optional(),
  /** Documents assigned to a container for the first time (freshly ingested). */
  docsAdopted: z.number().optional(),
  /** Documents whose container changed (moved issue/page, restriction applied or lifted). */
  docsReassigned: z.number().optional(),
  /**
   * True when the group step failed mid-pass: the membership snapshot was NOT
   * fully refreshed (documents still reconciled against the previous
   * snapshot). `membershipsUpserted` only counts batches that actually
   * persisted. Optional — absent on runs from before this flag existed.
   */
  groupSyncFailed: z.boolean().optional(),
  /** True when a content sync was running when this pass started. */
  contentSyncActiveDuringRun: z.boolean(),
});
export type PermissionSyncRunStats = z.infer<
  typeof PermissionSyncRunStatsSchema
>;

export const SelectConnectorRunSchema = createSelectSchema(
  schema.connectorRunsTable,
  {
    status: ConnectorSyncStatusSchema,
    runType: ConnectorRunTypeSchema,
    stats: PermissionSyncRunStatsSchema.nullable(),
  },
);
// Internal liveness-lease columns — never exposed in API responses.
const CONNECTOR_RUN_LEASE_FIELDS = {
  leaseOwner: true,
  leaseExpiresAt: true,
  leaseEpoch: true,
  heartbeatAt: true,
} as const;
/** Detail response: full run minus internal lease plumbing. */
export const SelectConnectorRunDetailSchema = SelectConnectorRunSchema.omit(
  CONNECTOR_RUN_LEASE_FIELDS,
);
/** List response: also drops the large `logs` column. */
export const SelectConnectorRunListSchema = SelectConnectorRunSchema.omit({
  logs: true,
  ...CONNECTOR_RUN_LEASE_FIELDS,
});
export const InsertConnectorRunSchema = createInsertSchema(
  schema.connectorRunsTable,
  {
    status: ConnectorSyncStatusSchema,
    runType: ConnectorRunTypeSchema.optional(),
  },
).omit({ id: true, createdAt: true });
export const UpdateConnectorRunSchema = createUpdateSchema(
  schema.connectorRunsTable,
  { status: ConnectorSyncStatusSchema.optional() },
).pick({
  status: true,
  completedAt: true,
  documentsProcessed: true,
  documentsIngested: true,
  totalItems: true,
  error: true,
  logs: true,
  checkpoint: true,
  stats: true,
  totalBatches: true,
  completedBatches: true,
  itemErrors: true,
  itemsSkipped: true,
});

export type ConnectorRun = z.infer<typeof SelectConnectorRunSchema>;
/** A run as returned by list endpoints: no `logs`, no internal lease columns. */
export type ConnectorRunListItem = z.infer<typeof SelectConnectorRunListSchema>;
export type InsertConnectorRun = z.infer<typeof InsertConnectorRunSchema>;
export type UpdateConnectorRun = z.infer<typeof UpdateConnectorRunSchema>;
