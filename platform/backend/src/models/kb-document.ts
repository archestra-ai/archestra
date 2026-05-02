import { and, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  AclEntry,
  ConnectorType,
  InsertKbDocument,
  KbDocument,
  UpdateKbDocument,
} from "@/types";

type KbDocumentListItem = KbDocument & {
  connectorType: ConnectorType;
};

type KbDocumentListItemWithoutContent = Omit<KbDocumentListItem, "content">;

class KbDocumentModel {
  static async findById(id: string): Promise<KbDocument | null> {
    const [result] = await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.id, id));

    return result ?? null;
  }

  static async findByIds(ids: string[]): Promise<KbDocument[]> {
    if (ids.length === 0) return [];

    return await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(inArray(schema.kbDocumentsTable.id, ids));
  }

  static async findByKnowledgeBase(params: {
    knowledgeBaseId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<KbDocument[]> {
    const normalizedSearch = params.search?.trim();
    let query = db
      .select({
        id: schema.kbDocumentsTable.id,
        organizationId: schema.kbDocumentsTable.organizationId,
        sourceId: schema.kbDocumentsTable.sourceId,
        connectorId: schema.kbDocumentsTable.connectorId,
        title: schema.kbDocumentsTable.title,
        content: schema.kbDocumentsTable.content,
        contentHash: schema.kbDocumentsTable.contentHash,
        sourceUrl: schema.kbDocumentsTable.sourceUrl,
        acl: schema.kbDocumentsTable.acl,
        metadata: schema.kbDocumentsTable.metadata,
        embeddingStatus: schema.kbDocumentsTable.embeddingStatus,
        chunkCount: schema.kbDocumentsTable.chunkCount,
        createdAt: schema.kbDocumentsTable.createdAt,
        updatedAt: schema.kbDocumentsTable.updatedAt,
      })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            params.knowledgeBaseId,
          ),
          normalizedSearch
            ? ilike(schema.kbDocumentsTable.title, `%${normalizedSearch}%`)
            : undefined,
        ),
      )
      .orderBy(desc(schema.kbDocumentsTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findListItemByIdAndKnowledgeBase(params: {
    documentId: string;
    knowledgeBaseId: string;
    organizationId: string;
  }): Promise<KbDocumentListItem | null> {
    const [result] = await db
      .select({
        id: schema.kbDocumentsTable.id,
        organizationId: schema.kbDocumentsTable.organizationId,
        sourceId: schema.kbDocumentsTable.sourceId,
        connectorId: schema.kbDocumentsTable.connectorId,
        connectorType: schema.knowledgeBaseConnectorsTable.connectorType,
        title: schema.kbDocumentsTable.title,
        content: schema.kbDocumentsTable.content,
        contentHash: schema.kbDocumentsTable.contentHash,
        sourceUrl: schema.kbDocumentsTable.sourceUrl,
        acl: schema.kbDocumentsTable.acl,
        metadata: schema.kbDocumentsTable.metadata,
        embeddingStatus: schema.kbDocumentsTable.embeddingStatus,
        chunkCount: schema.kbDocumentsTable.chunkCount,
        createdAt: schema.kbDocumentsTable.createdAt,
        updatedAt: schema.kbDocumentsTable.updatedAt,
      })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorsTable.id,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(schema.kbDocumentsTable.id, params.documentId),
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            params.knowledgeBaseId,
          ),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .limit(1);

    return result ?? null;
  }

  static async findListItemsByKnowledgeBase(params: {
    knowledgeBaseId: string;
    organizationId: string;
    limit?: number;
    offset?: number;
    search?: string;
    connectorId?: string;
  }): Promise<KbDocumentListItemWithoutContent[]> {
    const normalizedSearch = params.search?.trim();
    let query = db
      .select({
        id: schema.kbDocumentsTable.id,
        organizationId: schema.kbDocumentsTable.organizationId,
        sourceId: schema.kbDocumentsTable.sourceId,
        connectorId: schema.kbDocumentsTable.connectorId,
        connectorType: schema.knowledgeBaseConnectorsTable.connectorType,
        title: schema.kbDocumentsTable.title,
        contentHash: schema.kbDocumentsTable.contentHash,
        sourceUrl: schema.kbDocumentsTable.sourceUrl,
        acl: schema.kbDocumentsTable.acl,
        metadata: schema.kbDocumentsTable.metadata,
        embeddingStatus: schema.kbDocumentsTable.embeddingStatus,
        chunkCount: schema.kbDocumentsTable.chunkCount,
        createdAt: schema.kbDocumentsTable.createdAt,
        updatedAt: schema.kbDocumentsTable.updatedAt,
      })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorsTable.id,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            params.knowledgeBaseId,
          ),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
          normalizedSearch
            ? ilike(schema.kbDocumentsTable.title, `%${normalizedSearch}%`)
            : undefined,
          params.connectorId
            ? eq(schema.kbDocumentsTable.connectorId, params.connectorId)
            : undefined,
        ),
      )
      .orderBy(desc(schema.kbDocumentsTable.updatedAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findBySourceId(params: {
    connectorId: string;
    sourceId: string;
  }): Promise<KbDocument | null> {
    const [result] = await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          eq(schema.kbDocumentsTable.sourceId, params.sourceId),
        ),
      );

    return result ?? null;
  }

  static async create(data: InsertKbDocument): Promise<KbDocument> {
    const [result] = await db
      .insert(schema.kbDocumentsTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: Partial<UpdateKbDocument>,
  ): Promise<KbDocument | null> {
    const [result] = await db
      .update(schema.kbDocumentsTable)
      .set(data)
      .where(eq(schema.kbDocumentsTable.id, id))
      .returning();

    return result ?? null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }

  static async countByConnector(connectorId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.connectorId, connectorId));

    return result?.count ?? 0;
  }

  static async countByKnowledgeBase(params: {
    knowledgeBaseId: string;
    organizationId: string;
  }): Promise<number> {
    return KbDocumentModel.countByKnowledgeBaseWithSearch({
      knowledgeBaseId: params.knowledgeBaseId,
      organizationId: params.organizationId,
    });
  }

  static async countByKnowledgeBaseWithSearch(params: {
    knowledgeBaseId: string;
    organizationId: string;
    search?: string;
    connectorId?: string;
  }): Promise<number> {
    const normalizedSearch = params.search?.trim();
    const [result] = await db
      .select({ count: count() })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorsTable.id,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            params.knowledgeBaseId,
          ),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
          normalizedSearch
            ? ilike(schema.kbDocumentsTable.title, `%${normalizedSearch}%`)
            : undefined,
          params.connectorId
            ? eq(schema.kbDocumentsTable.connectorId, params.connectorId)
            : undefined,
        ),
      );

    return result?.count ?? 0;
  }

  static async findByIdAndKnowledgeBase(params: {
    documentId: string;
    knowledgeBaseId: string;
    organizationId: string;
  }): Promise<KbDocument | null> {
    const [result] = await db
      .select({
        id: schema.kbDocumentsTable.id,
        organizationId: schema.kbDocumentsTable.organizationId,
        sourceId: schema.kbDocumentsTable.sourceId,
        connectorId: schema.kbDocumentsTable.connectorId,
        title: schema.kbDocumentsTable.title,
        content: schema.kbDocumentsTable.content,
        contentHash: schema.kbDocumentsTable.contentHash,
        sourceUrl: schema.kbDocumentsTable.sourceUrl,
        acl: schema.kbDocumentsTable.acl,
        metadata: schema.kbDocumentsTable.metadata,
        embeddingStatus: schema.kbDocumentsTable.embeddingStatus,
        chunkCount: schema.kbDocumentsTable.chunkCount,
        createdAt: schema.kbDocumentsTable.createdAt,
        updatedAt: schema.kbDocumentsTable.updatedAt,
      })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorsTable.id,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(schema.kbDocumentsTable.id, params.documentId),
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            params.knowledgeBaseId,
          ),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .limit(1);

    return result ?? null;
  }

  static async deleteByConnector(connectorId: string): Promise<number> {
    const result = await db
      .delete(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.connectorId, connectorId));

    return result.rowCount ?? 0;
  }

  static async deleteByOrganization(organizationId: string): Promise<number> {
    const result = await db
      .delete(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.organizationId, organizationId));

    return result.rowCount ?? 0;
  }

  static async updateAclByConnector(
    connectorId: string,
    acl: AclEntry[],
  ): Promise<number> {
    // Skip rows that already have the target ACL to avoid unnecessary rewrites,
    // WAL churn, and vacuum work when connector visibility is re-applied.
    const result = await db.execute(sql`
      WITH updated AS (
        UPDATE ${schema.kbDocumentsTable}
        SET acl = ${JSON.stringify(acl)}::jsonb
        WHERE ${schema.kbDocumentsTable.connectorId} = ${connectorId}
          AND ${schema.kbDocumentsTable.acl} IS DISTINCT FROM ${JSON.stringify(acl)}::jsonb
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);

    const count = result.rows[0]?.count;
    return typeof count === "number" ? count : Number(count ?? 0);
  }

  static async countByKnowledgeBaseIds(
    knowledgeBaseIds: string[],
  ): Promise<Map<string, number>> {
    if (knowledgeBaseIds.length === 0) return new Map();

    const results = await db
      .select({
        knowledgeBaseId:
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
        count: count(),
      })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        inArray(
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
          knowledgeBaseIds,
        ),
      )
      .groupBy(schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId);

    return new Map(results.map((r) => [r.knowledgeBaseId, r.count]));
  }
}

export default KbDocumentModel;
