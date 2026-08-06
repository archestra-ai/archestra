// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  or,
  sql,
} from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { hardDelete, softDelete } from "@/database/soft-delete";
import { connectorInEnvironmentPredicate } from "@/services/environments/environment-isolation";
import type {
  InsertKnowledgeBaseConnector,
  KnowledgeBaseConnector,
  UpdateKnowledgeBaseConnector,
} from "@/types";
import type {
  ConnectorSyncStatus,
  ConnectorType,
} from "@/types/knowledge-connector";
import { escapeLikePattern } from "@/utils/sql-search";

class KnowledgeBaseConnectorModel {
  static async findByOrganization(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
    canReadAll?: boolean;
    viewerTeamIds?: string[];
    visibilityScope?: ConnectorVisibilityScope;
    /**
     * When provided (including explicit `null` = Default), restrict to connectors
     * in that environment (environment isolation). Omit to return all
     * environments (e.g. the management UI listing).
     */
    environmentId?: string | null;
  }): Promise<KnowledgeBaseConnector[]> {
    let query = db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          notDeleted(schema.knowledgeBaseConnectorsTable),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
          buildVisibilityFilter({
            canReadAll: params.canReadAll,
            teamIds: params.viewerTeamIds,
            scope: params.visibilityScope,
          }),
          params.environmentId !== undefined
            ? connectorInEnvironmentPredicate(params.environmentId)
            : undefined,
        ),
      )
      .orderBy(desc(schema.knowledgeBaseConnectorsTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async countByOrganization(organizationId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          notDeleted(schema.knowledgeBaseConnectorsTable),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            organizationId,
          ),
        ),
      );

    return result?.count ?? 0;
  }

  static async findByOrganizationPaginated(params: {
    organizationId: string;
    limit: number;
    offset: number;
    search?: string;
    connectorType?: ConnectorType;
    excludeConnectorTypes?: ConnectorType[];
    canReadAll?: boolean;
    viewerTeamIds?: string[];
    visibilityScope?: ConnectorVisibilityScope;
    status?: "active" | "deleted";
  }): Promise<{ data: KnowledgeBaseConnector[]; total: number }> {
    const {
      organizationId,
      limit,
      offset,
      search,
      connectorType,
      excludeConnectorTypes,
      canReadAll,
      viewerTeamIds,
      visibilityScope,
      status,
    } = params;
    const searchPattern = search ? `%${escapeLikePattern(search)}%` : null;

    const filters = [
      // Added once to the shared array: covers both the data query and the
      // count() total below, so a page can never show N rows with a total of
      // N + rows the other filter would have excluded. `status=deleted` is the
      // trash view; every other read stays notDeleted.
      status === "deleted"
        ? isNotNull(schema.knowledgeBaseConnectorsTable.deletedAt)
        : notDeleted(schema.knowledgeBaseConnectorsTable),
      eq(schema.knowledgeBaseConnectorsTable.organizationId, organizationId),
      buildVisibilityFilter({
        canReadAll,
        teamIds: viewerTeamIds,
        scope: visibilityScope,
      }),
      ...(connectorType
        ? [eq(schema.knowledgeBaseConnectorsTable.connectorType, connectorType)]
        : []),
      ...(excludeConnectorTypes && excludeConnectorTypes.length > 0
        ? [
            sql`${schema.knowledgeBaseConnectorsTable.connectorType} NOT IN (${sql.join(
              excludeConnectorTypes.map((type) => sql`${type}`),
              sql`, `,
            )})`,
          ]
        : []),
      ...(searchPattern
        ? [
            or(
              ilike(schema.knowledgeBaseConnectorsTable.name, searchPattern),
              ilike(
                schema.knowledgeBaseConnectorsTable.description,
                searchPattern,
              ),
            ),
          ]
        : []),
    ];

    const [data, totalResult] = await Promise.all([
      db
        .select()
        .from(schema.knowledgeBaseConnectorsTable)
        .where(and(...filters))
        // The trash renders `deletedAt` as its only temporal column, so it
        // sorts by it — ordering by `createdAt` there would scatter the visible
        // column into arbitrary order. `deletedAt` is non-null across that
        // slice by construction (the `isNotNull` filter above), so no null
        // ordering.
        .orderBy(
          status === "deleted"
            ? desc(schema.knowledgeBaseConnectorsTable.deletedAt)
            : desc(schema.knowledgeBaseConnectorsTable.createdAt),
        )
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(schema.knowledgeBaseConnectorsTable)
        .where(and(...filters)),
    ]);

    return { data, total: totalResult[0]?.count ?? 0 };
  }

  static async findByKnowledgeBaseId(
    knowledgeBaseId: string,
    params?: {
      canReadAll?: boolean;
      viewerTeamIds?: string[];
      visibilityScope?: ConnectorVisibilityScope;
      /** When provided (incl. `null` = Default), restrict to this environment. */
      environmentId?: string | null;
    },
  ): Promise<KnowledgeBaseConnector[]> {
    return await db
      .select({
        id: schema.knowledgeBaseConnectorsTable.id,
        organizationId: schema.knowledgeBaseConnectorsTable.organizationId,
        name: schema.knowledgeBaseConnectorsTable.name,
        description: schema.knowledgeBaseConnectorsTable.description,
        visibility: schema.knowledgeBaseConnectorsTable.visibility,
        teamIds: schema.knowledgeBaseConnectorsTable.teamIds,
        connectorType: schema.knowledgeBaseConnectorsTable.connectorType,
        config: schema.knowledgeBaseConnectorsTable.config,
        secretId: schema.knowledgeBaseConnectorsTable.secretId,
        environmentId: schema.knowledgeBaseConnectorsTable.environmentId,
        schedule: schema.knowledgeBaseConnectorsTable.schedule,
        permissionSyncIntervalSeconds:
          schema.knowledgeBaseConnectorsTable.permissionSyncIntervalSeconds,
        enabled: schema.knowledgeBaseConnectorsTable.enabled,
        lastSyncAt: schema.knowledgeBaseConnectorsTable.lastSyncAt,
        lastSyncStatus: schema.knowledgeBaseConnectorsTable.lastSyncStatus,
        lastSyncError: schema.knowledgeBaseConnectorsTable.lastSyncError,
        lastPermissionSyncAt:
          schema.knowledgeBaseConnectorsTable.lastPermissionSyncAt,
        lastPermissionSyncStatus:
          schema.knowledgeBaseConnectorsTable.lastPermissionSyncStatus,
        aclConfigEpoch: schema.knowledgeBaseConnectorsTable.aclConfigEpoch,
        checkpoint: schema.knowledgeBaseConnectorsTable.checkpoint,
        permissionSyncState:
          schema.knowledgeBaseConnectorsTable.permissionSyncState,
        createdAt: schema.knowledgeBaseConnectorsTable.createdAt,
        updatedAt: schema.knowledgeBaseConnectorsTable.updatedAt,
        deletedAt: schema.knowledgeBaseConnectorsTable.deletedAt,
      })
      .from(schema.knowledgeBaseConnectorAssignmentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.knowledgeBaseConnectorsTable.id,
        ),
      )
      .where(
        and(
          notDeleted(schema.knowledgeBaseConnectorsTable),
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            knowledgeBaseId,
          ),
          buildVisibilityFilter({
            canReadAll: params?.canReadAll,
            teamIds: params?.viewerTeamIds,
            scope: params?.visibilityScope,
          }),
          params?.environmentId !== undefined
            ? connectorInEnvironmentPredicate(params.environmentId)
            : undefined,
        ),
      )
      .orderBy(desc(schema.knowledgeBaseConnectorsTable.createdAt));
  }

  static async findByKnowledgeBaseIds(
    knowledgeBaseIds: string[],
    params?: {
      canReadAll?: boolean;
      viewerTeamIds?: string[];
      visibilityScope?: ConnectorVisibilityScope;
    },
  ): Promise<(KnowledgeBaseConnector & { knowledgeBaseId: string })[]> {
    if (knowledgeBaseIds.length === 0) return [];
    return await db
      .select({
        id: schema.knowledgeBaseConnectorsTable.id,
        organizationId: schema.knowledgeBaseConnectorsTable.organizationId,
        name: schema.knowledgeBaseConnectorsTable.name,
        description: schema.knowledgeBaseConnectorsTable.description,
        visibility: schema.knowledgeBaseConnectorsTable.visibility,
        teamIds: schema.knowledgeBaseConnectorsTable.teamIds,
        connectorType: schema.knowledgeBaseConnectorsTable.connectorType,
        config: schema.knowledgeBaseConnectorsTable.config,
        secretId: schema.knowledgeBaseConnectorsTable.secretId,
        environmentId: schema.knowledgeBaseConnectorsTable.environmentId,
        schedule: schema.knowledgeBaseConnectorsTable.schedule,
        permissionSyncIntervalSeconds:
          schema.knowledgeBaseConnectorsTable.permissionSyncIntervalSeconds,
        enabled: schema.knowledgeBaseConnectorsTable.enabled,
        lastSyncAt: schema.knowledgeBaseConnectorsTable.lastSyncAt,
        lastSyncStatus: schema.knowledgeBaseConnectorsTable.lastSyncStatus,
        lastSyncError: schema.knowledgeBaseConnectorsTable.lastSyncError,
        lastPermissionSyncAt:
          schema.knowledgeBaseConnectorsTable.lastPermissionSyncAt,
        lastPermissionSyncStatus:
          schema.knowledgeBaseConnectorsTable.lastPermissionSyncStatus,
        aclConfigEpoch: schema.knowledgeBaseConnectorsTable.aclConfigEpoch,
        checkpoint: schema.knowledgeBaseConnectorsTable.checkpoint,
        permissionSyncState:
          schema.knowledgeBaseConnectorsTable.permissionSyncState,
        createdAt: schema.knowledgeBaseConnectorsTable.createdAt,
        updatedAt: schema.knowledgeBaseConnectorsTable.updatedAt,
        deletedAt: schema.knowledgeBaseConnectorsTable.deletedAt,
        knowledgeBaseId:
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
      })
      .from(schema.knowledgeBaseConnectorAssignmentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.knowledgeBaseConnectorsTable.id,
        ),
      )
      .where(
        and(
          notDeleted(schema.knowledgeBaseConnectorsTable),
          inArray(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            knowledgeBaseIds,
          ),
          buildVisibilityFilter({
            canReadAll: params?.canReadAll,
            teamIds: params?.viewerTeamIds,
            scope: params?.visibilityScope,
          }),
        ),
      );
  }

  static async findById(id: string): Promise<KnowledgeBaseConnector | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          eq(schema.knowledgeBaseConnectorsTable.id, id),
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      );

    return result ?? null;
  }

  static async findByIds(ids: string[]): Promise<KnowledgeBaseConnector[]> {
    if (ids.length === 0) return [];

    return await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          inArray(schema.knowledgeBaseConnectorsTable.id, ids),
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      );
  }

  static async create(
    data: InsertKnowledgeBaseConnector,
  ): Promise<KnowledgeBaseConnector> {
    const [result] = await db
      .insert(schema.knowledgeBaseConnectorsTable)
      .values(data)
      .returning();

    return result;
  }

  /**
   * `notDeleted`-filtered like every read: a soft-deleted connector is gone, so
   * a write must not land on it either. Returns null when nothing matched. The
   * background pipeline relies on this — a sync/embedding job that finishes
   * after its connector was deleted no-ops here instead of stamping sync status
   * onto a deleted row.
   */
  static async update(
    id: string,
    data: Partial<UpdateKnowledgeBaseConnector>,
  ): Promise<KnowledgeBaseConnector | null> {
    const [result] = await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set(data)
      .where(
        and(
          eq(schema.knowledgeBaseConnectorsTable.id, id),
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      )
      .returning();

    return result ?? null;
  }

  /**
   * Advance the connector's sync checkpoint, gated atomically on the given run
   * still being `running`. If the run was reclaimed (its owner became a zombie),
   * the EXISTS guard fails and the stale checkpoint write is dropped — a newer
   * run's checkpoint can't be clobbered.
   */
  /**
   * Atomically bump the connector's ACL fencing epoch. Called whenever
   * visibility or teamIds change so every ACL writer that read the old epoch
   * (an in-flight content-sync or permission-sync write) no-ops — the newest
   * config change always wins regardless of job ordering. Returns the new epoch.
   */
  static async bumpAclConfigEpoch(connectorId: string): Promise<number> {
    const { rows } = await db.execute<{ acl_config_epoch: number }>(sql`
      UPDATE knowledge_base_connectors
      SET acl_config_epoch = acl_config_epoch + 1
      WHERE id = ${connectorId}
        AND deleted_at IS NULL
      RETURNING acl_config_epoch
    `);
    return Number(rows[0]?.acl_config_epoch ?? 0);
  }

  static async setCheckpointIfRunActive(params: {
    connectorId: string;
    runId: string;
    checkpoint: Record<string, unknown>;
  }): Promise<void> {
    await db.execute(sql`
      UPDATE knowledge_base_connectors
      SET checkpoint = ${JSON.stringify(params.checkpoint)}::jsonb
      WHERE id = ${params.connectorId}
        AND deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM connector_runs
          WHERE id = ${params.runId} AND status = 'running'
        )
    `);
  }

  /**
   * Mirror a reaped run's terminal status onto its connector, but only while the
   * connector still reflects THAT run — it is still `running` and its
   * `last_sync_at` equals the run's `started_at` (each run stamps the connector
   * with its own start; see Fix P in connector-sync). If a newer run has since
   * claimed the connector, its `last_sync_at` differs and this no-ops, so the
   * reaper can't clobber it. Compared in SQL against the run's `started_at` to
   * preserve exact timestamp precision.
   */
  static async markReapedStatusIfCurrent(params: {
    connectorId: string;
    runId: string;
    status: ConnectorSyncStatus;
    error: string | null;
  }): Promise<void> {
    await db.execute(sql`
      UPDATE knowledge_base_connectors
      SET last_sync_status = ${params.status}, last_sync_error = ${params.error}
      WHERE id = ${params.connectorId}
        AND deleted_at IS NULL
        AND last_sync_status = 'running'
        AND last_sync_at = (
          SELECT started_at FROM connector_runs WHERE id = ${params.runId}
        )
    `);
  }

  /**
   * Reconcile connectors left showing `running` when they have no running run —
   * e.g. a run finalized but its connector-status write was lost. Derives the
   * connector's status from its latest run (the authoritative source) in one
   * statement, replacing the old task-scanning cleanup loop. A connector whose
   * latest run is still `running` is skipped (it is genuinely in progress), so
   * this never races a live run. Returns the ids it corrected, for logging.
   *
   * Scoped to `content` runs only: `last_sync_status`/`last_sync_error` mirror
   * the CONTENT run family, and (by Guarantee 2) a permission run can be
   * `running` concurrently with a content run. Without this filter the latest
   * run per connector could be a permission run, and mirroring its status into
   * the content fields would clobber a live content run's status — the exact
   * cross-lane leak the runtime-isolation split forbids. Permission-run status
   * lives in `last_permission_sync_*` and is owned by the permission reaper.
   */
  static async reconcileOrphanedConnectorStatuses(): Promise<string[]> {
    const { rows } = await db.execute<{ id: string }>(sql`
      UPDATE knowledge_base_connectors c
      SET last_sync_status = latest.status,
          last_sync_error = latest.error
      FROM (
        SELECT DISTINCT ON (connector_id)
          connector_id, status, error
        FROM connector_runs
        WHERE run_type = 'content'
        ORDER BY connector_id, started_at DESC
      ) latest
      WHERE c.id = latest.connector_id
        AND c.deleted_at IS NULL
        AND c.last_sync_status = 'running'
        AND latest.status <> 'running'
      RETURNING c.id
    `);
    return rows.map((r) => r.id);
  }

  static async findAllEnabled(): Promise<KnowledgeBaseConnector[]> {
    return await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          notDeleted(schema.knowledgeBaseConnectorsTable),
          eq(schema.knowledgeBaseConnectorsTable.enabled, true),
        ),
      );
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Enabled `auto-sync-permissions` connectors of the given types — the
   * permission-sync scheduler's due-loop input. Both predicates are pushed into
   * SQL rather than filtered in the handler: the permission family covers a
   * small slice of a deployment's connectors, so loading every enabled one to
   * throw most of them away scales the scheduler's memory with the whole fleet
   * instead of with the connectors it can actually schedule.
   */
  static async findEnabledAutoSyncPermissions(
    connectorTypes: ConnectorType[],
  ): Promise<KnowledgeBaseConnector[]> {
    if (connectorTypes.length === 0) return [];

    const t = schema.knowledgeBaseConnectorsTable;
    return await db
      .select()
      .from(t)
      .where(
        and(
          notDeleted(t),
          eq(t.enabled, true),
          eq(t.visibility, "auto-sync-permissions"),
          inArray(t.connectorType, connectorTypes),
        ),
      );
  }
  // SPDX-SnippetEnd

  /**
   * Soft-delete: stamps `deleted_at`. Returns false when no active row matched
   * (already deleted / unknown id) — the delete routes surface that as a 404.
   * Side-effects (queued-sync cancellation, secret revocation, cache
   * invalidation) are NOT here; they live in the knowledge-source-deletion
   * service so every write surface (REST + MCP) runs them identically.
   */
  static async delete(id: string): Promise<boolean> {
    const count = await softDelete(
      db,
      schema.knowledgeBaseConnectorsTable,
      eq(schema.knowledgeBaseConnectorsTable.id, id),
    );

    return count > 0;
  }

  /**
   * Restore: clears `deleted_at` AND sets `enabled = false` in the same
   * UPDATE. Not the shared stamp-removal helper on purpose: the stored secret
   * was destroyed at soft-delete (see revokeConnectorSecret in the
   * knowledge-source-deletion service), and both sync schedulers select on
   * `enabled = true` every 30s (findAllEnabled /
   * findEnabledAutoSyncPermissions) — a restore that left `enabled` alone
   * would enroll a credential-less connector into an immediately-failing sync
   * loop. One statement means no window between revive and disable. The
   * connector comes back disabled; an admin re-authenticates, then re-enables.
   * Returns false when no soft-deleted row matched (restore route 404s).
   */
  static async restore(id: string): Promise<boolean> {
    const rows = await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({ deletedAt: null, enabled: false })
      .where(
        and(
          eq(schema.knowledgeBaseConnectorsTable.id, id),
          isNotNull(schema.knowledgeBaseConnectorsTable.deletedAt),
        ),
      )
      .returning({ id: schema.knowledgeBaseConnectorsTable.id });

    return rows.length > 0;
  }

  /**
   * Org-scoped lookup of a SOFT-DELETED connector, for the restore route. Does
   * NOT filter `notDeleted` — it is the one point read that must see deleted
   * rows.
   */
  static async findDeletedByIdForOrganization(
    id: string,
    organizationId: string,
  ): Promise<KnowledgeBaseConnector | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          eq(schema.knowledgeBaseConnectorsTable.id, id),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            organizationId,
          ),
          isNotNull(schema.knowledgeBaseConnectorsTable.deletedAt),
        ),
      );

    return result ?? null;
  }

  /**
   * Physical delete, for the permanent-delete route. Locks on `(id,
   * organization_id, deleted_at IS NOT NULL)` — self-authorizing, and a
   * concurrent restore wins the race; see KnowledgeBaseModel.purge. Children —
   * runs, documents (and their chunks), ACLs, external groups, member
   * overrides, assignments — all cascade. Queued-sync cancellation and secret
   * revocation already happened at soft-delete time (knowledge-source-deletion
   * service), so there is nothing external left.
   *
   * The statement timeout is raised for the duration: the document/chunk
   * cascade of a large connector is a single statement, and under the
   * pool-wide 30s ceiling it would abort identically on every retry, leaving
   * the connector permanently un-purgeable (same reasoning as AgentModel.purge).
   */
  static async purge(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    return await withDbTransaction(async (tx) => {
      // `sql.raw`: SET is a utility command and takes no bind parameters, so
      // `= $1` is a syntax error. The value is a module constant, never input.
      await tx.execute(
        sql.raw(`SET LOCAL statement_timeout = ${PURGE_STATEMENT_TIMEOUT_MS}`),
      );

      const [locked] = await tx
        .select({ id: schema.knowledgeBaseConnectorsTable.id })
        .from(schema.knowledgeBaseConnectorsTable)
        .where(
          and(
            eq(schema.knowledgeBaseConnectorsTable.id, params.id),
            eq(
              schema.knowledgeBaseConnectorsTable.organizationId,
              params.organizationId,
            ),
            isNotNull(schema.knowledgeBaseConnectorsTable.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!locked) return false;

      const count = await hardDelete(
        tx,
        schema.knowledgeBaseConnectorsTable,
        eq(schema.knowledgeBaseConnectorsTable.id, params.id),
      );
      return count > 0;
    });
  }

  /** Identity-only audit snapshot for purge audit rows; org-scoped. */
  static async findIdentityForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select({
        id: schema.knowledgeBaseConnectorsTable.id,
        name: schema.knowledgeBaseConnectorsTable.name,
        connectorType: schema.knowledgeBaseConnectorsTable.connectorType,
        deletedAt: schema.knowledgeBaseConnectorsTable.deletedAt,
      })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          eq(schema.knowledgeBaseConnectorsTable.id, id),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            organizationId,
          ),
        ),
      );
    if (!row) return null;
    return { ...row, deletedAt: row.deletedAt?.toISOString() ?? null };
  }

  /**
   * Link a connector to a knowledge base. Returns false — without writing —
   * when either side is soft-deleted, which every caller surfaces as a 404.
   *
   * A hard delete + FK cascade used to make a link to a gone parent
   * impossible; under soft-delete the rows survive, so the DB would happily
   * accept one. Callers validate both sides first (org scope, access control);
   * this is the last-line guard that closes the delete-in-between window.
   */
  static async assignToKnowledgeBase(
    connectorId: string,
    knowledgeBaseId: string,
  ): Promise<boolean> {
    const [connector] = await db
      .select({ id: schema.knowledgeBaseConnectorsTable.id })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          eq(schema.knowledgeBaseConnectorsTable.id, connectorId),
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      );
    if (!connector) return false;

    const [kb] = await db
      .select({ id: schema.knowledgeBasesTable.id })
      .from(schema.knowledgeBasesTable)
      .where(
        and(
          eq(schema.knowledgeBasesTable.id, knowledgeBaseId),
          notDeleted(schema.knowledgeBasesTable),
        ),
      );
    if (!kb) return false;

    await db
      .insert(schema.knowledgeBaseConnectorAssignmentsTable)
      .values({ connectorId, knowledgeBaseId })
      .onConflictDoNothing();

    return true;
  }

  static async unassignFromKnowledgeBase(
    connectorId: string,
    knowledgeBaseId: string,
  ): Promise<boolean> {
    const rows = await db
      .delete(schema.knowledgeBaseConnectorAssignmentsTable)
      .where(
        and(
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
            connectorId,
          ),
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            knowledgeBaseId,
          ),
        ),
      )
      .returning({
        connectorId: schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
      });

    return rows.length > 0;
  }

  static async getKnowledgeBaseIds(connectorId: string): Promise<string[]> {
    // Join the KB parent so soft-deleted KBs drop out of "which KBs does this
    // connector feed" — symmetric to getConnectorIds filtering deleted connectors.
    const results = await db
      .select({
        knowledgeBaseId:
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
      })
      .from(schema.knowledgeBaseConnectorAssignmentsTable)
      .innerJoin(
        schema.knowledgeBasesTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
          schema.knowledgeBasesTable.id,
        ),
      )
      .where(
        and(
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
            connectorId,
          ),
          notDeleted(schema.knowledgeBasesTable),
        ),
      );

    return results.map((r) => r.knowledgeBaseId);
  }

  static async resetCheckpointsByOrganization(
    organizationId: string,
  ): Promise<void> {
    await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set({ checkpoint: null })
      .where(
        and(
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            organizationId,
          ),
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      );
  }

  static async getConnectorIds(knowledgeBaseId: string): Promise<string[]> {
    // Joins the connector parent so a soft-deleted-but-still-assigned connector
    // is dropped from the returned ids — otherwise non-vectorSearch consumers
    // of these ids (retrieval, hot-path tool visibility) would keep serving it.
    const results = await db
      .select({
        connectorId: schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
      })
      .from(schema.knowledgeBaseConnectorAssignmentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.knowledgeBaseConnectorsTable.id,
        ),
      )
      .where(
        and(
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            knowledgeBaseId,
          ),
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      );

    return results.map((r) => r.connectorId);
  }
  static async findByNameAndType(
    name: string,
    connectorType: ConnectorType,
    organizationId: string,
  ): Promise<KnowledgeBaseConnector | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          eq(schema.knowledgeBaseConnectorsTable.name, name),
          eq(schema.knowledgeBaseConnectorsTable.connectorType, connectorType),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            organizationId,
          ),
          // A soft-deleted connector frees its (name, type) for reuse.
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      );

    return result ?? null;
  }

  static async countReferencingGithubAppConfig(params: {
    githubAppConfigId: string;
    organizationId: string;
  }): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          notDeleted(schema.knowledgeBaseConnectorsTable),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
          // only connectors actively authenticating via this App config count;
          // a stale githubAppConfigId left in the JSON after switching to PAT
          // must not block deletion. A soft-deleted connector no longer counts.
          sql`${schema.knowledgeBaseConnectorsTable.config}->>'authMethod' = 'github_app'`,
          sql`${schema.knowledgeBaseConnectorsTable.config}->>'githubAppConfigId' = ${params.githubAppConfigId}`,
        ),
      );

    return row?.value ?? 0;
  }

  /**
   * Prior/post-state snapshot for the audit hook. `notDeleted`-filtered like
   * every other read: both surfaces capture `before` ahead of the handler (the
   * row is still active then) and never fetch an after-state for a `.deleted`
   * action, so filtering keeps the delete record's before-state intact while a
   * re-delete of an already-deleted connector records no phantom prior state.
   * Returns the raw Drizzle row, not the `omit()`'d API schema.
   */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          eq(schema.knowledgeBaseConnectorsTable.id, id),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            organizationId,
          ),
          notDeleted(schema.knowledgeBaseConnectorsTable),
        ),
      )
      .limit(1);

    if (!row) return null;

    const kbAssigned = await db
      .select({
        id: schema.knowledgeBasesTable.id,
        name: schema.knowledgeBasesTable.name,
      })
      .from(schema.knowledgeBaseConnectorAssignmentsTable)
      .innerJoin(
        schema.knowledgeBasesTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
          schema.knowledgeBasesTable.id,
        ),
      )
      .where(eq(schema.knowledgeBaseConnectorAssignmentsTable.connectorId, id));

    const knowledgeBases = kbAssigned
      .map((r) => `${r.name} (${r.id})`)
      .sort((a, b) => a.localeCompare(b));

    const configKeys =
      row.config && typeof row.config === "object" && !Array.isArray(row.config)
        ? Object.keys(row.config as Record<string, unknown>).sort()
        : [];

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      organizationId: row.organizationId,
      connectorType: row.connectorType,
      visibility: row.visibility,
      teamIds: [...(row.teamIds ?? [])].sort(),
      schedule: row.schedule,
      enabled: row.enabled,
      lastSyncStatus: row.lastSyncStatus ?? null,
      lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
      lastSyncError: row.lastSyncError
        ? String(row.lastSyncError).slice(0, 500)
        : null,
      knowledgeBases,
      configKeys,
      permissionSyncIntervalSeconds: row.permissionSyncIntervalSeconds ?? null,
      environmentId: row.environmentId ?? null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export default KnowledgeBaseConnectorModel;

/**
 * Which access notion a visibility-filtered read serves.
 * - `management` (default): the connector itself (lists, detail, config) —
 *   auto-sync-permissions connectors are visible to knowledgeSource admins only.
 * - `query`: which connectors a user's knowledge queries may span —
 *   auto-sync-permissions connectors stay in scope for everyone; their
 *   per-chunk ACLs enforce what the user actually retrieves.
 */
type ConnectorVisibilityScope = "management" | "query";

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
function buildVisibilityFilter(params: {
  canReadAll?: boolean;
  teamIds?: string[];
  scope?: ConnectorVisibilityScope;
}) {
  if (params.canReadAll) {
    return undefined;
  }

  const conditions = [];
  // Management surfaces (the default) hide auto-sync-permissions connectors
  // from non-admins entirely; "query" scope keeps them in reach because their
  // per-chunk ACLs — not connector visibility — decide what a user retrieves.
  if (params.scope !== "query") {
    conditions.push(
      sql`${schema.knowledgeBaseConnectorsTable.visibility} != 'auto-sync-permissions'`,
    );
  }

  // No access context means "org-wide only" by default; callers must opt into
  // team-scoped connectors by passing the viewer's team IDs or canReadAll.
  if (!params.teamIds || params.teamIds.length === 0) {
    conditions.push(
      sql`${schema.knowledgeBaseConnectorsTable.visibility} != 'team-scoped'`,
    );
  } else {
    const teamIds = sql.join(
      params.teamIds.map((teamId) => sql`${teamId}`),
      sql`, `,
    );

    conditions.push(sql`(
      ${schema.knowledgeBaseConnectorsTable.visibility} != 'team-scoped'
      OR ${schema.knowledgeBaseConnectorsTable.teamIds} ?| ARRAY[${teamIds}]
    )`);
  }

  return and(...conditions);
}
// SPDX-SnippetEnd

/**
 * Ceiling for {@link KnowledgeBaseConnectorModel.purge}'s transaction, ten
 * times the pool-wide default. The document/chunk cascade happens INSIDE the
 * DELETE statement, so the pool-wide 30s `statement_timeout` applies to the
 * whole of it; for a connector with a large corpus that aborts identically on
 * every retry, making the row permanently un-purgeable. `SET LOCAL` scopes the
 * change to this transaction and reverts on commit, so no other query loses
 * its safety net. Finite rather than unlimited: a purge that cannot finish in
 * five minutes should surface as a failure, not hold locks indefinitely.
 */
const PURGE_STATEMENT_TIMEOUT_MS = 300_000;
