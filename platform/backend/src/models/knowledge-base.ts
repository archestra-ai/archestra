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
import {
  findExpiredSoftDeleted,
  type HardDeleteOpts,
  hardDelete,
  lockRowForPurge,
  restore,
  softDelete,
} from "@/database/soft-delete";
import type {
  InsertKnowledgeBase,
  KnowledgeBase,
  UpdateKnowledgeBase,
} from "@/types";
import KnowledgeBaseConnectorModel from "./knowledge-base-connector";

class KnowledgeBaseModel {
  static async findByOrganization(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<KnowledgeBase[]> {
    const normalizedSearch = params.search?.trim();
    const filters = [
      notDeleted(schema.knowledgeBasesTable),
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
   * Org-scoped listing of SOFT-DELETED knowledge bases, for the
   * `status=deleted` trash view. Does NOT filter `notDeleted` — it is a
   * deleted-only read, and deliberately org-wide rather than team-visibility
   * scoped: deleted-resource lifecycle is one org-scoped capability
   * (`knowledgeSource:manage-deleted`), matching the MCP catalog's trash.
   */
  static async findDeletedForOrganization(
    organizationId: string,
  ): Promise<KnowledgeBase[]> {
    return await db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(
        and(
          eq(schema.knowledgeBasesTable.organizationId, organizationId),
          isNotNull(schema.knowledgeBasesTable.deletedAt),
        ),
      )
      .orderBy(desc(schema.knowledgeBasesTable.deletedAt));
  }

  /**
   * Org-scoped lookup of a SOFT-DELETED knowledge base, for the restore and
   * permanent-delete routes. Does NOT filter `notDeleted` — it is the one
   * point read that must see deleted rows.
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
   * Physical delete for the purge paths (`onlyIfDeletedForDays` restricts to
   * aged-out soft-deleted rows, re-checked under FOR UPDATE so a concurrent
   * restore wins). Children (agent assignments, connector assignments)
   * cascade; the single-statement delete is the established pattern and
   * nothing writes to a soft-deleted knowledge base.
   */
  static async hardDelete(id: string, opts?: HardDeleteOpts): Promise<boolean> {
    return await withDbTransaction(async (tx) => {
      if (
        !(await lockRowForPurge(
          tx,
          schema.knowledgeBasesTable,
          eq(schema.knowledgeBasesTable.id, id),
          opts,
        ))
      ) {
        return false;
      }
      const count = await hardDelete(
        tx,
        schema.knowledgeBasesTable,
        eq(schema.knowledgeBasesTable.id, id),
      );
      if (count === 0) return false;
      await opts?.onPurged?.(tx);
      return true;
    });
  }

  /** The purge sweep's find-expired scan; see findExpiredSoftDeleted. */
  static async findExpiredDeleted(params: {
    retentionDays: number;
    limit: number;
    offset: number;
  }): Promise<{ id: string; organizationId: string }[]> {
    return findExpiredSoftDeleted(
      db,
      schema.knowledgeBasesTable,
      {
        id: schema.knowledgeBasesTable.id,
        organizationId: schema.knowledgeBasesTable.organizationId,
      },
      params,
    );
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
  }): Promise<number> {
    const normalizedSearch = params.search?.trim();
    const filters = [
      notDeleted(schema.knowledgeBasesTable),
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

    const [result] = await db
      .select({ count: count() })
      .from(schema.knowledgeBasesTable)
      .where(and(...filters));

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
