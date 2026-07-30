import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { softDelete } from "@/database/soft-delete";
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

  static async update(
    id: string,
    data: Partial<UpdateKnowledgeBase>,
  ): Promise<KnowledgeBase | null> {
    const [result] = await db
      .update(schema.knowledgeBasesTable)
      .set(data)
      .where(eq(schema.knowledgeBasesTable.id, id))
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

  // NOTE: findByIdForAudit is deliberately NOT notDeleted-filtered — the delete
  // audit reads the row *after* it is stamped, so it must see soft-deleted rows.
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
