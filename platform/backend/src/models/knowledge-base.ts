import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  or,
} from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { hardDelete, restore, softDelete } from "@/database/soft-delete";
import type {
  InsertKnowledgeBase,
  KnowledgeBase,
  UpdateKnowledgeBase,
} from "@/types";
import KnowledgeBaseConnectorModel from "./knowledge-base-connector";

/**
 * Filters shared by the list and its count, so a page can never show N rows
 * with a total of N + rows the other filter would have excluded. `status`
 * picks the lifecycle slice: `deleted` is the trash view, every other read
 * stays `notDeleted`.
 */
function buildOrgFilters(params: {
  organizationId: string;
  search?: string;
  status?: "active" | "deleted";
}) {
  const normalizedSearch = params.search?.trim();
  return [
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
  }): Promise<KnowledgeBase[]> {
    const filters = buildOrgFilters(params);

    let query = db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(and(...filters))
      .orderBy(desc(schema.knowledgeBasesTable.createdAt))
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

  static async create(data: InsertKnowledgeBase): Promise<KnowledgeBase> {
    const [result] = await db
      .insert(schema.knowledgeBasesTable)
      .values(data)
      .returning();

    return result;
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
  }): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.knowledgeBasesTable)
      .where(and(...buildOrgFilters(params)));

    return result?.count ?? 0;
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
      connectors: connectors.map((c) => c.name).sort(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

export default KnowledgeBaseModel;
