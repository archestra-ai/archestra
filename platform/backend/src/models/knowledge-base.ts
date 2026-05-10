import { and, count, desc, eq, ilike, inArray, or } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/_soft-delete";
import { hardDelete, softDelete } from "@/database/soft-delete";
import type {
  InsertKnowledgeBase,
  KnowledgeBase,
  UpdateKnowledgeBase,
} from "@/types";

class KnowledgeBaseModel {
  static async findByOrganization(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<KnowledgeBase[]> {
    const normalizedSearch = params.search?.trim();
    const filters = [
      eq(schema.knowledgeBasesTable.organizationId, params.organizationId),
      notDeleted(schema.knowledgeBasesTable),
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

  static async findById(
    id: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<KnowledgeBase | null> {
    const conditions = [eq(schema.knowledgeBasesTable.id, id)];
    if (!opts.includeDeleted) {
      conditions.push(notDeleted(schema.knowledgeBasesTable));
    }
    const [result] = await db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(and(...conditions));

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
      .where(
        and(
          eq(schema.knowledgeBasesTable.id, id),
          notDeleted(schema.knowledgeBasesTable),
        ),
      )
      .returning();

    return result ?? null;
  }

  static async delete(id: string, tx?: Transaction): Promise<boolean> {
    const count = await softDelete(
      tx ?? db,
      schema.knowledgeBasesTable,
      eq(schema.knowledgeBasesTable.id, id),
    );
    return count > 0;
  }

  static async hardDelete(id: string, tx?: Transaction): Promise<boolean> {
    const count = await hardDelete(
      tx ?? db,
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
      eq(schema.knowledgeBasesTable.organizationId, params.organizationId),
      notDeleted(schema.knowledgeBasesTable),
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
          notDeleted(schema.knowledgeBasesTable),
        ),
      );

    return result ?? null;
  }
}

export default KnowledgeBaseModel;
