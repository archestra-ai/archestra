import type { CreatedBy, ResourcePermissionGrant } from "@archestra/shared";
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  not,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { hardDelete, restore, softDelete } from "@/database/soft-delete";
import { qualified } from "@/database/utils/qualified-column";
import type {
  InsertKnowledgeBase,
  KnowledgeBase,
  UpdateKnowledgeBase,
} from "@/types";
import type { ConnectorType } from "@/types/knowledge-connector";
import type { LabelWithDetails } from "@/types/label";
import CreatedByModel from "./created-by";
import KnowledgeBaseConnectorModel from "./knowledge-base-connector";
import ResourcePermissionPolicyModel from "./resource-permission-policy";
import ResourcePermissionSubjectModel, {
  type GrantPrincipal,
  type ResourceAccessSelection,
} from "./resource-permission-subject";

/**
 * Filters shared by the list and its count, so a page can never show N rows
 * with a total of N + rows the other filter would have excluded. `status`
 * picks the lifecycle slice: `deleted` is the trash view, every other read
 * stays `notDeleted`.
 */
async function buildOrgFilters(params: {
  organizationId: string;
  search?: string;
  status?: "active" | "deleted";
  /**
   * Knowledge base ids matching the caller's `?labels=` filter, resolved once
   * by the route so the list and count queries agree without resolving twice.
   */
  labelFilteredIds?: string[];
  canReadAll?: boolean;
  viewerTeamIds?: string[];
  viewerUserId?: string;
  scope?: "personal" | "team" | "org";
  teamIds?: string[];
  authorIds?: string[];
  excludeAuthorIds?: string[];
  excludeOtherPersonal?: boolean;
  /** The list's "Show" filter, read against `viewerUserId`. */
  access?: ResourceAccessSelection;
}) {
  const normalizedSearch = params.search?.trim();
  const viewer = params.viewerUserId
    ? await ResourcePermissionSubjectModel.resolvePrincipal({
        organizationId: params.organizationId,
        userId: params.viewerUserId,
      })
    : null;
  return [
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    ...(viewer
      ? [
          ResourcePermissionPolicyModel.grantCondition({
            ...viewer,
            resource: "knowledgeBase",
            scopeColumn: schema.knowledgeBasesTable.id,
            action: "read",
          }),
        ]
      : params.canReadAll === false
        ? [
            // A caller with no user of its own reaches what is published to
            // the organization at large, plus what its teams were granted.
            or(
              ResourcePermissionPolicyModel.organizationAccessCondition({
                organizationId: params.organizationId,
                resource: "knowledgeBase",
                scopeColumn: schema.knowledgeBasesTable.id,
                action: "read",
              }),
              ResourcePermissionPolicyModel.grantsReadToAnyTeam({
                organizationId: params.organizationId,
                resource: "knowledgeBase",
                scopeColumn: schema.knowledgeBasesTable.id,
                teamIds: params.viewerTeamIds ?? [],
              }),
            ),
          ]
        : []),
    // SPDX-SnippetEnd
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // The personal / team / org label and the team filter come from each
    // knowledge base's own grants, not the retired visibility columns.
    ...(params.scope
      ? [
          ResourcePermissionPolicyModel.audienceIs({
            ...ownAudienceContext(params.organizationId),
            audience: params.scope,
          }),
        ]
      : []),
    ...(params.teamIds?.length
      ? [
          ResourcePermissionPolicyModel.grantsReadToAnyTeam({
            ...ownAudienceContext(params.organizationId),
            teamIds: params.teamIds,
          }),
        ]
      : []),
    ...(viewer && params.viewerUserId && params.access
      ? [
          ResourcePermissionPolicyModel.accessRelationCondition({
            ...ownAudienceContext(params.organizationId),
            userId: params.viewerUserId,
            subjects: viewer.subjects,
            ...params.access,
          }),
        ]
      : []),
    // SPDX-SnippetEnd
    ...(params.authorIds?.length
      ? [inArray(schema.knowledgeBasesTable.createdBy, params.authorIds)]
      : []),
    ...(params.excludeAuthorIds?.length
      ? [
          or(
            sql`${schema.knowledgeBasesTable.createdBy} IS NULL`,
            notInArray(
              schema.knowledgeBasesTable.createdBy,
              params.excludeAuthorIds,
            ),
          ),
        ]
      : []),
    ...(params.excludeOtherPersonal
      ? [
          or(
            not(
              ResourcePermissionPolicyModel.audienceIs({
                ...ownAudienceContext(params.organizationId),
                audience: "personal",
              }),
            ),
            params.viewerUserId
              ? eq(schema.knowledgeBasesTable.createdBy, params.viewerUserId)
              : sql`false`,
          ),
        ]
      : []),
    ...(params.labelFilteredIds !== undefined
      ? [inArray(schema.knowledgeBasesTable.id, params.labelFilteredIds)]
      : []),
    params.status === "deleted"
      ? isNotNull(schema.knowledgeBasesTable.deletedAt)
      : notDeleted(schema.knowledgeBasesTable),
    eq(schema.knowledgeBasesTable.organizationId, params.organizationId),
    ...(normalizedSearch
      ? [
          or(
            ilike(schema.knowledgeBasesTable.name, `%${normalizedSearch}%`),
            ilike(
              schema.knowledgeBasesTable.description,
              `%${normalizedSearch}%`,
            ),
          ),
        ]
      : []),
  ];
}

class KnowledgeBaseModel {
  static async findByOrganization(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
    search?: string;
    status?: "active" | "deleted";
    /** Knowledge base ids matching a `?labels=` filter; omit when not filtering. */
    labelFilteredIds?: string[];
    canReadAll?: boolean;
    viewerTeamIds?: string[];
    viewerUserId?: string;
    scope?: "personal" | "team" | "org";
    teamIds?: string[];
    authorIds?: string[];
    excludeAuthorIds?: string[];
    excludeOtherPersonal?: boolean;
    /** The list's "Show" filter, read against `viewerUserId`. */
    access?: ResourceAccessSelection;
  }): Promise<KnowledgeBase[]> {
    const filters = await buildOrgFilters(params);

    let query = db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(and(...filters))
      // The trash renders `deletedAt` as its only temporal column, so it sorts
      // by it — ordering by `createdAt` there would scatter the visible column
      // into arbitrary order. `deletedAt` is non-null across that slice by
      // construction (buildOrgFilters pins `isNotNull`), so no null ordering.
      //
      // `id` breaks ties on both branches: LIMIT/OFFSET needs a total order, or
      // a tie group straddling a page boundary renders a row twice and drops
      // another. Ties are the normal case, not the edge one — `createdAt`
      // defaults to now(), the transaction timestamp, so rows inserted together
      // are stamped identically, and a cascade hands `softDelete` one shared
      // `at` deliberately. The uuid is random: a determinism key, not a recency
      // proxy. This settles the order for a fixed snapshot only — OFFSET paging
      // still shifts under a concurrent restore/purge, which would take keyset
      // pagination to close.
      .orderBy(
        params.status === "deleted"
          ? desc(schema.knowledgeBasesTable.deletedAt)
          : desc(schema.knowledgeBasesTable.createdAt),
        desc(schema.knowledgeBasesTable.id),
      )
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findById(id: string): Promise<KnowledgeBase | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(
        and(
          eq(schema.knowledgeBasesTable.id, id),
          notDeleted(schema.knowledgeBasesTable),
        ),
      );

    return result ?? null;
  }

  static async findByIds(ids: string[]): Promise<KnowledgeBase[]> {
    if (ids.length === 0) return [];
    return await db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(
        and(
          inArray(schema.knowledgeBasesTable.id, ids),
          notDeleted(schema.knowledgeBasesTable),
        ),
      );
  }

  static async create(
    data: InsertKnowledgeBase,
    /** Explicit starting audience; omitted derives one from the visibility. */
    options?: {
      initialPermissionGrants?: ResourcePermissionGrant[];
      /** Publish to the whole organization; for system callers only. */
      publishToOrganization?: boolean;
    },
  ): Promise<KnowledgeBase> {
    // The access policy is written with the row it governs, so a failure
    // cannot leave a knowledge base nobody can reach.
    return await withDbTransaction(async (tx) => {
      const [result] = await tx
        .insert(schema.knowledgeBasesTable)
        .values(
          await CreatedByModel.forInsert({
            data: data,
            userIdField: "createdBy",
            transaction: tx,
          }),
        )
        .returning();
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissionPolicyModel.createInitial({
        tx,
        organizationId: result.organizationId,
        resource: "knowledgeBase",
        scope: result.id,
        grants: options?.initialPermissionGrants,
        // The creator gets full access, like the author of every other
        // resource. A base a system caller creates has no creator.
        authorId: CreatedByModel.id(result, result.createdBy) ?? null,
        publishToOrganization: options?.publishToOrganization,
      });
      // SPDX-SnippetEnd

      return result;
    });
  }

  /**
   * `notDeleted`-filtered like every read: a soft-deleted KB is gone, so a
   * write must not land on it either. Returns null when nothing matched.
   */
  static async update(
    id: string,
    data: Partial<UpdateKnowledgeBase>,
  ): Promise<KnowledgeBase | null> {
    const [result] = await db
      .update(schema.knowledgeBasesTable)
      .set(data)
      .where(
        and(
          eq(schema.knowledgeBasesTable.id, id),
          notDeleted(schema.knowledgeBasesTable),
        ),
      )
      .returning();

    return result ?? null;
  }

  /**
   * Soft-delete: stamps `deleted_at` so the row survives for a follow-up
   * restore/purge but drops out of every `notDeleted()`-filtered read. Returns
   * false when no active row matched (already deleted / unknown id), which the
   * delete routes surface as a 404. Cross-model side-effects (queued-sync
   * cancellation, cache invalidation) live in the knowledge-source-deletion
   * service, not here.
   */
  static async delete(id: string): Promise<boolean> {
    const count = await softDelete(
      db,
      schema.knowledgeBasesTable,
      eq(schema.knowledgeBasesTable.id, id),
    );

    return count > 0;
  }

  /**
   * Restore: clears `deleted_at`, pure stamp-removal. Junction rows (agent
   * assignments, connector links) were never stamped, so the KB comes back
   * with its prior assignments live. Returns false when no soft-deleted row
   * matched, which the restore route surfaces as a 404.
   */
  static async restore(id: string): Promise<boolean> {
    const count = await restore(
      db,
      schema.knowledgeBasesTable,
      eq(schema.knowledgeBasesTable.id, id),
    );

    return count > 0;
  }

  /**
   * Org-scoped lookup of a SOFT-DELETED knowledge base, for the restore route.
   * Does NOT filter `notDeleted` — it is the one point read that must see
   * deleted rows.
   */
  static async findDeletedByIdForOrganization(
    id: string,
    organizationId: string,
  ): Promise<KnowledgeBase | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(
        and(
          eq(schema.knowledgeBasesTable.id, id),
          eq(schema.knowledgeBasesTable.organizationId, organizationId),
          isNotNull(schema.knowledgeBasesTable.deletedAt),
        ),
      );

    return result ?? null;
  }

  /**
   * Physical delete, for the permanent-delete route. Locks on `(id,
   * organization_id, deleted_at IS NOT NULL)` so the purge is
   * self-authorizing — the route needs no separate existence read — and a
   * concurrent restore wins the race (it either commits first, leaving no
   * soft-deleted row to find, or blocks until this transaction commits and
   * then finds no row at all). Children (agent assignments, connector
   * assignments) cascade.
   */
  static async purge(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    return await withDbTransaction(async (tx) => {
      const [locked] = await tx
        .select({ id: schema.knowledgeBasesTable.id })
        .from(schema.knowledgeBasesTable)
        .where(
          and(
            eq(schema.knowledgeBasesTable.id, params.id),
            eq(
              schema.knowledgeBasesTable.organizationId,
              params.organizationId,
            ),
            isNotNull(schema.knowledgeBasesTable.deletedAt),
          ),
        )
        .for("update")
        .limit(1);
      if (!locked) return false;

      const count = await hardDelete(
        tx,
        schema.knowledgeBasesTable,
        eq(schema.knowledgeBasesTable.id, params.id),
      );
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      await ResourcePermissionPolicyModel.deleteForTarget({
        tx,
        resources: ["knowledgeBase"],
        scope: params.id,
      });
      // SPDX-SnippetEnd
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
        id: schema.knowledgeBasesTable.id,
        name: schema.knowledgeBasesTable.name,
        deletedAt: schema.knowledgeBasesTable.deletedAt,
      })
      .from(schema.knowledgeBasesTable)
      .where(
        and(
          eq(schema.knowledgeBasesTable.id, id),
          eq(schema.knowledgeBasesTable.organizationId, organizationId),
        ),
      );
    if (!row) return null;
    return { ...row, deletedAt: row.deletedAt?.toISOString() ?? null };
  }

  static async countByOrganization(params: {
    organizationId: string;
    search?: string;
    status?: "active" | "deleted";
    /** Knowledge base ids matching a `?labels=` filter; omit when not filtering. */
    labelFilteredIds?: string[];
    canReadAll?: boolean;
    viewerTeamIds?: string[];
    viewerUserId?: string;
    scope?: "personal" | "team" | "org";
    teamIds?: string[];
    authorIds?: string[];
    excludeAuthorIds?: string[];
    excludeOtherPersonal?: boolean;
    /** The list's "Show" filter, read against `viewerUserId`. */
    access?: ResourceAccessSelection;
  }): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.knowledgeBasesTable)
      .where(and(...(await buildOrgFilters(params))));

    return result?.count ?? 0;
  }

  /**
   * Everything the list shows besides each knowledge base's own row, in one
   * statement over the page's ids: its creator, the connectors the viewer can
   * see, its document total, the live agents in its organization assigned to
   * it, and its labels.
   *
   * The document total sums every assigned connector, soft-deleted and unseen
   * ones included. A connector gives its stored total, or a live count when
   * it has none. The live counts come back in `firstCounts` for the caller to
   * store, as KbConnectorDocumentCountModel.findByConnectorIds does.
   * `identityOnly` (the trash view) reads the creator alone.
   *
   * Connectors come by name, agents in assignment order.
   */
  static async findListEnrichment(params: {
    knowledgeBaseIds: string[];
    organizationId: string;
    canReadAll?: boolean;
    viewerTeamIds?: string[];
    viewerUserId?: string;
    viewerPrincipal?: GrantPrincipal;
    identityOnly?: boolean;
    /** False lists no agents and counts them instead. Defaults to true. */
    includeAssignedAgents?: boolean;
  }): Promise<{
    byId: Map<string, KnowledgeBaseListEnrichment>;
    firstCounts: Map<string, number>;
  }> {
    const byId = new Map<string, KnowledgeBaseListEnrichment>();
    const firstCounts = new Map<string, number>();
    if (params.knowledgeBaseIds.length === 0) return { byId, firstCounts };

    const kbId = qualified(schema.knowledgeBasesTable.id);
    const assignment = schema.knowledgeBaseConnectorAssignmentsTable;
    const connector = schema.knowledgeBaseConnectorsTable;
    const visibleConnectors = db
      .select({
        id: connector.id,
        name: connector.name,
        connectorType: connector.connectorType,
      })
      .from(assignment)
      .innerJoin(connector, eq(assignment.connectorId, connector.id))
      .where(
        and(
          eq(assignment.knowledgeBaseId, kbId),
          notDeleted(connector),
          await KnowledgeBaseConnectorModel.visibilityCondition(params),
        ),
      );
    const empty = sql`'[]'::json`;
    // The live agents of the organization assigned to the outer row.
    const assignedLiveAgents = sql`${schema.agentKnowledgeBasesTable} akb
      INNER JOIN ${schema.agentsTable} ag ON ag.id = akb.agent_id
      WHERE akb.knowledge_base_id = ${kbId}
        AND ag.organization_id = ${params.organizationId}
        AND ag.deleted_at IS NULL`;

    const rows = await db
      .select({
        id: schema.knowledgeBasesTable.id,
        creatorUser: sql<{ id: string; name: string; email: string } | null>`(
          SELECT json_build_object('id', u.id, 'name', u.name, 'email', u.email)
          FROM ${schema.usersTable} u
          WHERE u.id = ${qualified(schema.knowledgeBasesTable.createdBy)})`,
        creatorServiceAccount: sql<{ id: string; name: string } | null>`(
          SELECT json_build_object('id', sa.id, 'name', sa.name)
          FROM ${schema.serviceAccountsTable} sa
          WHERE sa.id = ${qualified(schema.knowledgeBasesTable.createdByServiceAccountId)})`,
        connectors: params.identityOnly
          ? sql<KnowledgeBaseListEnrichment["connectors"]>`${empty}`
          : sql<KnowledgeBaseListEnrichment["connectors"]>`(
              SELECT coalesce(json_agg(json_build_object(
                'id', c.id, 'name', c.name, 'connectorType', c.connector_type
              ) ORDER BY c.name, c.id), '[]'::json)
              FROM (${visibleConnectors}) c)`,
        documentTotals: params.identityOnly
          ? sql<DocumentTotal[]>`${empty}`
          : sql<DocumentTotal[]>`(
              SELECT coalesce(json_agg(json_build_object(
                'connectorId', a.connector_id,
                'stored', dc.document_count,
                'live', CASE WHEN dc.connector_id IS NULL THEN (
                  SELECT count(*) FROM ${schema.kbDocumentsTable} d
                  WHERE d.connector_id = a.connector_id) END
              )), '[]'::json)
              FROM ${schema.knowledgeBaseConnectorAssignmentsTable} a
                LEFT JOIN ${schema.kbConnectorDocumentCountsTable} dc
                  ON dc.connector_id = a.connector_id
              WHERE a.knowledge_base_id = ${kbId})`,
        assignedAgents:
          params.identityOnly || params.includeAssignedAgents === false
            ? sql<KnowledgeBaseListEnrichment["assignedAgents"]>`${empty}`
            : sql<KnowledgeBaseListEnrichment["assignedAgents"]>`(
              SELECT coalesce(json_agg(json_build_object(
                'id', ag.id, 'name', ag.name, 'agentType', ag.agent_type
              ) ORDER BY akb.created_at, akb.agent_id), '[]'::json)
              FROM ${assignedLiveAgents})`,
        // Counted in SQL only when the agents are not listed; otherwise the
        // count is the listed agents', by the same rule.
        assignedAgentCount:
          params.identityOnly || params.includeAssignedAgents !== false
            ? sql<number | null>`NULL::int`
            : sql<
                number | null
              >`(SELECT count(*)::int FROM ${assignedLiveAgents})`,
        labels: params.identityOnly
          ? sql<LabelWithDetails[]>`${empty}`
          : sql<LabelWithDetails[]>`(
              SELECT coalesce(json_agg(json_build_object(
                'keyId', kl.key_id, 'valueId', kl.value_id,
                'key', coalesce(lk.key, ''), 'value', coalesce(lv.value, '')
              ) ORDER BY lk.key), '[]'::json)
              FROM ${schema.knowledgeBaseLabelsTable} kl
                LEFT JOIN ${schema.labelKeysTable} lk ON lk.id = kl.key_id
                LEFT JOIN ${schema.labelValuesTable} lv ON lv.id = kl.value_id
              WHERE kl.knowledge_base_id = ${kbId})`,
      })
      .from(schema.knowledgeBasesTable)
      .where(inArray(schema.knowledgeBasesTable.id, params.knowledgeBaseIds));

    for (const row of rows) {
      let totalDocsIndexed = 0;
      for (const total of row.documentTotals) {
        const documents = Number(total.stored ?? total.live ?? 0);
        if (total.stored === null)
          firstCounts.set(total.connectorId, documents);
        totalDocsIndexed += documents;
      }
      byId.set(row.id, {
        createdBy: row.creatorServiceAccount
          ? CreatedByModel.fromServiceAccount(row.creatorServiceAccount)
          : row.creatorUser
            ? CreatedByModel.fromUser(row.creatorUser)
            : null,
        connectors: row.connectors,
        totalDocsIndexed,
        assignedAgents: row.assignedAgents,
        assignedAgentCount: row.assignedAgentCount ?? row.assignedAgents.length,
        labels: row.labels,
      });
    }
    return { byId, firstCounts };
  }

  static async findByName(
    name: string,
    organizationId: string,
  ): Promise<KnowledgeBase | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(
        and(
          eq(schema.knowledgeBasesTable.name, name),
          eq(schema.knowledgeBasesTable.organizationId, organizationId),
          // A soft-deleted KB frees its name for reuse.
          notDeleted(schema.knowledgeBasesTable),
        ),
      );

    return result ?? null;
  }

  /**
   * Prior/post-state snapshot for the audit hook. `notDeleted`-filtered like
   * every other read: both the REST hook and the MCP tool dispatch capture
   * `before` ahead of the handler (the row is still active then) and never
   * fetch an after-state for a `.deleted` action, so the delete record keeps
   * its full before-state while a re-delete of an already-deleted KB records no
   * phantom prior state.
   */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(
        and(
          eq(schema.knowledgeBasesTable.id, id),
          eq(schema.knowledgeBasesTable.organizationId, organizationId),
          notDeleted(schema.knowledgeBasesTable),
        ),
      )
      .limit(1);

    if (!row) return null;

    // Fetch connectors to include in the audit snapshot. The snapshot is a
    // system-level record, not a viewer surface, so it bypasses visibility
    // filtering and lists every assigned connector.
    const connectors = await KnowledgeBaseConnectorModel.findByKnowledgeBaseId(
      id,
      { canReadAll: true },
    );

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? null,
      organizationId: row.organizationId,
      status: row.status,
      visibility: row.visibility,
      teamIds: row.teamIds,
      connectors: connectors.map((c) => c.name).sort(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export default KnowledgeBaseModel;

function ownAudienceContext(organizationId: string) {
  return {
    organizationId,
    resource: "knowledgeBase" as const,
    scopeColumn: schema.knowledgeBasesTable.id,
    ownerColumn: schema.knowledgeBasesTable.createdBy,
  };
}

type KnowledgeBaseListEnrichment = {
  createdBy: CreatedBy | null;
  connectors: { id: string; name: string; connectorType: ConnectorType }[];
  totalDocsIndexed: number;
  assignedAgents: { id: string; name: string; agentType: string }[];
  assignedAgentCount: number;
  labels: LabelWithDetails[];
};

/** One assigned connector's documents: its stored total, else a live count. */
type DocumentTotal = {
  connectorId: string;
  stored: number | null;
  live: number | null;
};
