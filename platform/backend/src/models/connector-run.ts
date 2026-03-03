import { count, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ConnectorRun,
  InsertConnectorRun,
  UpdateConnectorRun,
} from "@/types";

class ConnectorRunModel {
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
}

export default ConnectorRunModel;
