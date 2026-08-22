import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type {
  McpServerAlertMute,
  McpServerDismissibleAlertKind,
} from "@/types";

/**
 * Per-viewer dismissals of MCP registry alerts. A dismissal changes only one
 * viewer's queue; its fingerprint prevents a later failure episode from
 * inheriting the decision.
 */
class McpServerAlertMuteModel {
  static async dismiss(params: {
    userId: string;
    catalogId: string;
    mcpServerId: string | null;
    issueKind: McpServerDismissibleAlertKind;
    issueFingerprint: string;
    reason: string;
  }): Promise<{
    previous: McpServerAlertMute | null;
    mute: McpServerAlertMute;
  }> {
    return withDbTransaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.mcpServerAlertMutesTable)
        .where(viewerAlert(params));

      const values = {
        userId: params.userId,
        catalogId: params.catalogId,
        mcpServerId: params.mcpServerId,
        issueKind: params.issueKind,
        issueFingerprint: params.issueFingerprint,
        reason: params.reason,
      };
      const serverTarget = params.mcpServerId !== null;
      const [row] = await tx
        .insert(schema.mcpServerAlertMutesTable)
        .values(values)
        .onConflictDoUpdate({
          target: serverTarget
            ? [
                schema.mcpServerAlertMutesTable.userId,
                schema.mcpServerAlertMutesTable.mcpServerId,
                schema.mcpServerAlertMutesTable.issueKind,
              ]
            : [
                schema.mcpServerAlertMutesTable.userId,
                schema.mcpServerAlertMutesTable.catalogId,
                schema.mcpServerAlertMutesTable.issueKind,
              ],
          targetWhere: serverTarget
            ? isNotNull(schema.mcpServerAlertMutesTable.mcpServerId)
            : isNull(schema.mcpServerAlertMutesTable.mcpServerId),
          set: {
            issueFingerprint: params.issueFingerprint,
            reason: params.reason,
            updatedAt: new Date(),
          },
        })
        .returning();

      return {
        previous: existing ? toAlertMute(existing) : null,
        mute: toAlertMute(row),
      };
    });
  }

  static async restore(params: {
    userId: string;
    catalogId: string;
    mcpServerId: string | null;
    issueKind: McpServerDismissibleAlertKind;
    issueFingerprint: string;
  }): Promise<McpServerAlertMute | null> {
    const [deleted] = await db
      .delete(schema.mcpServerAlertMutesTable)
      .where(
        and(
          viewerAlert(params),
          eq(
            schema.mcpServerAlertMutesTable.issueFingerprint,
            params.issueFingerprint,
          ),
        ),
      )
      .returning();
    return deleted ? toAlertMute(deleted) : null;
  }

  static async deleteForMcpServer(mcpServerId: string): Promise<void> {
    await db
      .delete(schema.mcpServerAlertMutesTable)
      .where(eq(schema.mcpServerAlertMutesTable.mcpServerId, mcpServerId));
  }

  /** The viewer's dismissals grouped by catalog for one registry read. */
  static async findForViewer(params: {
    userId: string;
    catalogIds: string[];
  }): Promise<Map<string, McpServerAlertMute[]>> {
    const byCatalogId = new Map<string, McpServerAlertMute[]>();
    if (params.catalogIds.length === 0) return byCatalogId;

    const rows = await db
      .select()
      .from(schema.mcpServerAlertMutesTable)
      .where(
        and(
          eq(schema.mcpServerAlertMutesTable.userId, params.userId),
          inArray(schema.mcpServerAlertMutesTable.catalogId, params.catalogIds),
        ),
      );

    for (const row of rows) {
      const dismissals = byCatalogId.get(row.catalogId) ?? [];
      dismissals.push(toAlertMute(row));
      byCatalogId.set(row.catalogId, dismissals);
    }
    return byCatalogId;
  }
}

export default McpServerAlertMuteModel;

// === Internal helpers

function viewerAlert(params: {
  userId: string;
  catalogId: string;
  mcpServerId: string | null;
  issueKind: McpServerDismissibleAlertKind;
}) {
  return and(
    eq(schema.mcpServerAlertMutesTable.userId, params.userId),
    eq(schema.mcpServerAlertMutesTable.catalogId, params.catalogId),
    params.mcpServerId
      ? eq(schema.mcpServerAlertMutesTable.mcpServerId, params.mcpServerId)
      : isNull(schema.mcpServerAlertMutesTable.mcpServerId),
    eq(schema.mcpServerAlertMutesTable.issueKind, params.issueKind),
  );
}

function toAlertMute(
  row: typeof schema.mcpServerAlertMutesTable.$inferSelect,
): McpServerAlertMute {
  return {
    catalogId: row.catalogId,
    mcpServerId: row.mcpServerId,
    issueKind: row.issueKind,
    issueFingerprint: row.issueFingerprint,
    reason: row.reason,
    mutedAt: row.updatedAt,
  };
}
