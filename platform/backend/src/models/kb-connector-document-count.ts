import { and, count, eq, inArray, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import type { ConnectorType } from "@/types/knowledge-connector";
import { chunkForBulkStatement } from "@/utils/db";

/**
 * Stored per-connector document totals (`kb_connector_document_counts`).
 *
 * Every write stores a connector's current total, counted from `kb_documents`
 * at that moment; nothing adds to or subtracts from a stored value. Writers
 * (sync runs, document deletes and uploads) replace the row. Readers count a
 * connector that has no row yet, store the result only if no writer got there
 * first, and use it. Statements that take a list of connectors run in batches
 * (`chunkForBulkStatement`), so an organization-wide recount stays under the
 * bind-parameter cap.
 */
class KbConnectorDocumentCountModel {
  /**
   * Count one connector's documents and store the total, replacing any stored
   * value. Returns the total.
   */
  static async refresh(connectorId: string): Promise<number> {
    const totals = await KbConnectorDocumentCountModel.countLive([connectorId]);
    await KbConnectorDocumentCountModel.store(totals, { replace: true });
    return totals.get(connectorId) ?? 0;
  }

  /**
   * Recount every connector of an organization, optionally only those of one
   * type, for writes that remove documents across many connectors at once.
   */
  static async refreshForOrganization(params: {
    organizationId: string;
    connectorType?: ConnectorType;
  }): Promise<void> {
    const connectors = await db
      .select({ id: schema.knowledgeBaseConnectorsTable.id })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        and(
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
          params.connectorType
            ? eq(
                schema.knowledgeBaseConnectorsTable.connectorType,
                params.connectorType,
              )
            : undefined,
        ),
      );
    if (connectors.length === 0) return;

    const totals = await KbConnectorDocumentCountModel.countLive(
      connectors.map((connector) => connector.id),
    );
    await KbConnectorDocumentCountModel.store(totals, { replace: true });
  }

  /**
   * Document totals for the given connectors; every id gets a value. A
   * connector that has never been counted is counted now.
   */
  static async findByConnectorIds(
    connectorIds: string[],
  ): Promise<Map<string, number>> {
    if (connectorIds.length === 0) return new Map();

    const totals = new Map<string, number>();
    for (const ids of chunkForBulkStatement(connectorIds)) {
      const stored = await db
        .select({
          connectorId: schema.kbConnectorDocumentCountsTable.connectorId,
          documentCount: schema.kbConnectorDocumentCountsTable.documentCount,
        })
        .from(schema.kbConnectorDocumentCountsTable)
        .where(inArray(schema.kbConnectorDocumentCountsTable.connectorId, ids));
      for (const row of stored) totals.set(row.connectorId, row.documentCount);
    }

    const uncounted = connectorIds.filter((id) => !totals.has(id));
    if (uncounted.length > 0) {
      const counted = await KbConnectorDocumentCountModel.countLive(uncounted);
      await KbConnectorDocumentCountModel.storeFirstCounts(counted);
      for (const [connectorId, total] of counted) {
        totals.set(connectorId, total);
      }
    }
    return totals;
  }

  /**
   * Store totals a reader counted for connectors that had no row. A row a
   * writer stored in the meantime is newer and is kept. A failed write (a
   * connector purged mid-request) is logged and leaves the read unaffected:
   * the next reader counts again.
   */
  static async storeFirstCounts(totals: Map<string, number>): Promise<void> {
    try {
      await KbConnectorDocumentCountModel.store(totals, { replace: false });
    } catch (error) {
      logger.warn(
        { error, connectorIds: [...totals.keys()] },
        "[KbConnectorDocumentCount] Could not store first document counts",
      );
    }
  }

  // ===== Internal helpers =====

  /** Live `count(*)` per connector; connectors without documents get 0. */
  private static async countLive(
    connectorIds: string[],
  ): Promise<Map<string, number>> {
    const totals = new Map(connectorIds.map((id) => [id, 0]));
    for (const ids of chunkForBulkStatement(connectorIds)) {
      const rows = await db
        .select({
          connectorId: schema.kbDocumentsTable.connectorId,
          total: count(),
        })
        .from(schema.kbDocumentsTable)
        .where(inArray(schema.kbDocumentsTable.connectorId, ids))
        .groupBy(schema.kbDocumentsTable.connectorId);
      for (const row of rows) totals.set(row.connectorId, row.total);
    }
    return totals;
  }

  private static async store(
    totals: Map<string, number>,
    options: { replace: boolean },
  ): Promise<void> {
    for (const rows of chunkForBulkStatement([...totals])) {
      const insert = db.insert(schema.kbConnectorDocumentCountsTable).values(
        rows.map(([connectorId, documentCount]) => ({
          connectorId,
          documentCount,
        })),
      );
      if (options.replace) {
        await insert.onConflictDoUpdate({
          target: schema.kbConnectorDocumentCountsTable.connectorId,
          set: { documentCount: sql`excluded.document_count` },
        });
      } else {
        await insert.onConflictDoNothing({
          target: schema.kbConnectorDocumentCountsTable.connectorId,
        });
      }
    }
  }
}

export default KbConnectorDocumentCountModel;
