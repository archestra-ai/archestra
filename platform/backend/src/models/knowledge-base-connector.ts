// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
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
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
          buildVisibilityFilter({
            canReadAll: params.canReadAll,
            teamIds: params.viewerTeamIds,
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
        eq(schema.knowledgeBaseConnectorsTable.organizationId, organizationId),
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
    } = params;
    const searchPattern = search ? `%${escapeLikePattern(search)}%` : null;

    const filters = [
      eq(schema.knowledgeBaseConnectorsTable.organizationId, organizationId),
      buildVisibilityFilter({ canReadAll, teamIds: viewerTeamIds }),
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
        .orderBy(desc(schema.knowledgeBaseConnectorsTable.createdAt))
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
        enabled: schema.knowledgeBaseConnectorsTable.enabled,
        lastSyncAt: schema.knowledgeBaseConnectorsTable.lastSyncAt,
        lastSyncStatus: schema.knowledgeBaseConnectorsTable.lastSyncStatus,
        lastSyncError: schema.knowledgeBaseConnectorsTable.lastSyncError,
        checkpoint: schema.knowledgeBaseConnectorsTable.checkpoint,
        createdAt: schema.knowledgeBaseConnectorsTable.createdAt,
        updatedAt: schema.knowledgeBaseConnectorsTable.updatedAt,
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
          buildVisibilityFilter({
            canReadAll: params?.canReadAll,
            teamIds: params?.viewerTeamIds,
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
        enabled: schema.knowledgeBaseConnectorsTable.enabled,
        lastSyncAt: schema.knowledgeBaseConnectorsTable.lastSyncAt,
        lastSyncStatus: schema.knowledgeBaseConnectorsTable.lastSyncStatus,
        lastSyncError: schema.knowledgeBaseConnectorsTable.lastSyncError,
        checkpoint: schema.knowledgeBaseConnectorsTable.checkpoint,
        createdAt: schema.knowledgeBaseConnectorsTable.createdAt,
        updatedAt: schema.knowledgeBaseConnectorsTable.updatedAt,
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
          inArray(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            knowledgeBaseIds,
          ),
          buildVisibilityFilter({
            canReadAll: params?.canReadAll,
            teamIds: params?.viewerTeamIds,
          }),
        ),
      );
  }

  static async findById(id: string): Promise<KnowledgeBaseConnector | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, id));

    return result ?? null;
  }

  static async findByIds(ids: string[]): Promise<KnowledgeBaseConnector[]> {
    if (ids.length === 0) return [];

    return await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(inArray(schema.knowledgeBaseConnectorsTable.id, ids));
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

  static async update(
    id: string,
    data: Partial<UpdateKnowledgeBaseConnector>,
  ): Promise<KnowledgeBaseConnector | null> {
    const [result] = await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set(data)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, id))
      .returning();

    return result ?? null;
  }

  static async findAllEnabled(): Promise<KnowledgeBaseConnector[]> {
    return await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.enabled, true));
  }

  static async findAllWithStatus(
    status: ConnectorSyncStatus,
  ): Promise<KnowledgeBaseConnector[]> {
    return await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.lastSyncStatus, status));
  }

  static async delete(id: string): Promise<boolean> {
    const rows = await db
      .delete(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, id))
      .returning({ id: schema.knowledgeBaseConnectorsTable.id });

    return rows.length > 0;
  }

  static async assignToKnowledgeBase(
    connectorId: string,
    knowledgeBaseId: string,
  ): Promise<void> {
    await db
      .insert(schema.knowledgeBaseConnectorAssignmentsTable)
      .values({ connectorId, knowledgeBaseId })
      .onConflictDoNothing();
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
    const results = await db
      .select({
        knowledgeBaseId:
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
      })
      .from(schema.knowledgeBaseConnectorAssignmentsTable)
      .where(
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          connectorId,
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
        eq(schema.knowledgeBaseConnectorsTable.organizationId, organizationId),
      );
  }

  static async getConnectorIds(knowledgeBaseId: string): Promise<string[]> {
    const results = await db
      .select({
        connectorId: schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
      })
      .from(schema.knowledgeBaseConnectorAssignmentsTable)
      .where(
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
          knowledgeBaseId,
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
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
          // only connectors actively authenticating via this App config count;
          // a stale githubAppConfigId left in the JSON after switching to PAT
          // must not block deletion
          sql`${schema.knowledgeBaseConnectorsTable.config}->>'authMethod' = 'github_app'`,
          sql`${schema.knowledgeBaseConnectorsTable.config}->>'githubAppConfigId' = ${params.githubAppConfigId}`,
        ),
      );

    return row?.value ?? 0;
  }

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
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export default KnowledgeBaseConnectorModel;

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
function buildVisibilityFilter(params: {
  canReadAll?: boolean;
  teamIds?: string[];
}) {
  if (params.canReadAll) {
    return undefined;
  }

  // No access context means "org-wide only" by default; callers must opt into
  // team-scoped connectors by passing the viewer's team IDs or canReadAll.
  if (!params.teamIds || params.teamIds.length === 0) {
    return sql`${schema.knowledgeBaseConnectorsTable.visibility} != 'team-scoped'`;
  }

  const teamIds = sql.join(
    params.teamIds.map((teamId) => sql`${teamId}`),
    sql`, `,
  );

  return sql`(
    ${schema.knowledgeBaseConnectorsTable.visibility} != 'team-scoped'
    OR ${schema.knowledgeBaseConnectorsTable.teamIds} ?| ARRAY[${teamIds}]
  )`;
}
// SPDX-SnippetEnd
