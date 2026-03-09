import { count, desc, eq, inArray, sql, sum } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ConnectorRun,
  InsertConnectorRun,
  UpdateConnectorRun,
} from "@/types";

/** ConnectorRun without the `logs` field — used for list endpoints to avoid large payloads. */
type ConnectorRunListItem = Omit<ConnectorRun, "logs">;

class ConnectorRunModel {
  /** List runs without the `logs` column (for list endpoints). */
  static async findByConnectorList(params: {
    connectorId: string;
    limit?: number;
    offset?: number;
  }): Promise<ConnectorRunListItem[]> {
    const t = schema.connectorRunsTable;
    let query = db
      .select({
        id: t.id,
        connectorId: t.connectorId,
        status: t.status,
        startedAt: t.startedAt,
        completedAt: t.completedAt,
        documentsProcessed: t.documentsProcessed,
        documentsIngested: t.documentsIngested,
        totalItems: t.totalItems,
        totalBatches: t.totalBatches,
        completedBatches: t.completedBatches,
        error: t.error,
        checkpoint: t.checkpoint,
        createdAt: t.createdAt,
      })
      .from(t)
      .where(eq(t.connectorId, params.connectorId))
      .orderBy(desc(t.startedAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findByConnector(params: {
    connectorId: string;
    limit?: number;
    offset?: number;
  }): Promise<ConnectorRun[]> {
    let query = db
      .select()
      .from(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.connectorId, params.connectorId))
      .orderBy(desc(schema.connectorRunsTable.startedAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async countByConnector(connectorId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.connectorId, connectorId));

    return result?.count ?? 0;
  }

  static async findById(id: string): Promise<ConnectorRun | null> {
    const [result] = await db
      .select()
      .from(schema.connectorRunsTable)
      .where(eq(schema.connectorRunsTable.id, id));

    return result ?? null;
  }

  static async create(data: InsertConnectorRun): Promise<ConnectorRun> {
    const [result] = await db
      .insert(schema.connectorRunsTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: Partial<UpdateConnectorRun>,
  ): Promise<ConnectorRun | null> {
    const [result] = await db
      .update(schema.connectorRunsTable)
      .set(data)
      .where(eq(schema.connectorRunsTable.id, id))
      .returning();

    return result ?? null;
  }

  static async completeBatch(runId: string): Promise<ConnectorRun | null> {
    const t = schema.connectorRunsTable;
    const [result] = await db
      .update(t)
      .set({
        completedBatches: sql`${t.completedBatches} + 1`,
        status: sql`CASE WHEN ${t.completedBatches} + 1 >= ${t.totalBatches} THEN 'success' ELSE ${t.status} END`,
        completedAt: sql`CASE WHEN ${t.completedBatches} + 1 >= ${t.totalBatches} THEN NOW() ELSE ${t.completedAt} END`,
      })
      .where(eq(t.id, runId))
      .returning();
    return result ?? null;
  }

  static async sumDocsIngestedByKnowledgeBaseIds(
    knowledgeBaseIds: string[],
  ): Promise<Map<string, number>> {
    if (knowledgeBaseIds.length === 0) return new Map();

    const results = await db
      .select({
        knowledgeBaseId:
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
        total: sum(schema.connectorRunsTable.documentsIngested),
      })
      .from(schema.connectorRunsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.connectorRunsTable.connectorId,
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
        ),
      )
      .where(
        inArray(
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
          knowledgeBaseIds,
        ),
      )
      .groupBy(schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId);

    return new Map(
      results.map((r) => [r.knowledgeBaseId, Number(r.total ?? 0)]),
    );
  }
}

export default ConnectorRunModel;
