import { and, eq, inArray } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import {
  type McpServerAlertMute,
  type McpServerMutableAlertKind,
  McpServerMutableAlertKindSchema,
} from "@/types";

/** The subset of an install a mute's applicability is decided against. */
type MutableAlertSource = {
  id: string;
  oauthRefreshFailedAt: Date | null;
};

/**
 * Per-viewer mutes on MCP connection alerts. Every read is scoped to one user:
 * a mute hides an alert for the person who took it and for nobody else, so
 * there is deliberately no "who muted this connection" query.
 */
class McpServerAlertMuteModel {
  /**
   * Take (or re-take) a viewer's mute on one alert, pinned to the failure
   * episode the connection is in right now. Returns null when the connection is
   * not reporting the alert, so there is nothing to pin to.
   *
   * The pin is read and the row is written in one transaction, under a row lock
   * on the install: without it a refresh failure landing between the read and
   * the write would leave a row pinned to an episode that is already over, and
   * the caller would be told the alert was muted while the listing kept showing
   * it. `previous` is the caller's prior mute, returned so the route can audit
   * both sides of the change without a second read racing the same window.
   */
  static async muteLiveAlert(params: {
    userId: string;
    mcpServerId: string;
    issueKind: McpServerMutableAlertKind;
    reason: string;
  }): Promise<{
    previous: McpServerAlertMute | null;
    mute: McpServerAlertMute;
  } | null> {
    return withDbTransaction(async (tx) => {
      const [server] = await tx
        .select({
          oauthRefreshError: schema.mcpServersTable.oauthRefreshError,
          oauthRefreshFailedAt: schema.mcpServersTable.oauthRefreshFailedAt,
        })
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, params.mcpServerId))
        .for("update");

      // `oauthRefreshFailedAt` is written with `oauthRefreshError` and cleared
      // with it, so a live alert always carries a timestamp.
      if (!server?.oauthRefreshError || !server.oauthRefreshFailedAt) {
        return null;
      }

      const [existing] = await tx
        .select()
        .from(schema.mcpServerAlertMutesTable)
        .where(viewerAlert(params));

      const [row] = await tx
        .insert(schema.mcpServerAlertMutesTable)
        .values({
          userId: params.userId,
          mcpServerId: params.mcpServerId,
          issueKind: params.issueKind,
          reason: params.reason,
          oauthRefreshFailedAt: server.oauthRefreshFailedAt,
        })
        .onConflictDoUpdate({
          target: [
            schema.mcpServerAlertMutesTable.userId,
            schema.mcpServerAlertMutesTable.mcpServerId,
            schema.mcpServerAlertMutesTable.issueKind,
          ],
          set: {
            reason: params.reason,
            oauthRefreshFailedAt: server.oauthRefreshFailedAt,
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

  /**
   * Drop a viewer's mute, returning the row that was removed so the caller can
   * audit what it said; null when they had no mute for this alert.
   */
  static async unmute(params: {
    userId: string;
    mcpServerId: string;
    issueKind: McpServerMutableAlertKind;
  }): Promise<McpServerAlertMute | null> {
    const [deleted] = await db
      .delete(schema.mcpServerAlertMutesTable)
      .where(viewerAlert(params))
      .returning();

    return deleted ? toAlertMute(deleted) : null;
  }

  /**
   * Drop every viewer's mutes on one connection, for use where the fault they
   * silence is cleared. A mute is scoped to one failure episode; once that
   * episode ends, keeping the rows would risk a later, genuinely new fault
   * being born already muted for whoever silenced the previous one.
   */
  static async deleteForMcpServer(mcpServerId: string): Promise<void> {
    await db
      .delete(schema.mcpServerAlertMutesTable)
      .where(eq(schema.mcpServerAlertMutesTable.mcpServerId, mcpServerId));
  }

  /**
   * The viewer's mutes that still apply, keyed by install — one query for the
   * whole listing rather than one per row.
   *
   * A mute applies only while the install's `oauthRefreshFailedAt` is still the
   * one it was taken against. That timestamp marks the start of a failure
   * episode, not the last retry, so re-observing the same fault keeps the mute
   * alive while a fault that clears and returns produces a new one. Stale rows
   * are left in place, to be replaced by the next mute, so a read never mutates.
   */
  static async findApplicableForViewer(params: {
    userId: string;
    mcpServers: MutableAlertSource[];
  }): Promise<Map<string, McpServerAlertMute[]>> {
    const byServerId = new Map<string, McpServerAlertMute[]>();
    if (params.mcpServers.length === 0) {
      return byServerId;
    }

    const rows = await db
      .select()
      .from(schema.mcpServerAlertMutesTable)
      .where(
        and(
          eq(schema.mcpServerAlertMutesTable.userId, params.userId),
          inArray(
            schema.mcpServerAlertMutesTable.mcpServerId,
            params.mcpServers.map((server) => server.id),
          ),
          // A row naming an alert that is not mutable must never silence one.
          // The route rejects such a kind and a CHECK constraint rejects the
          // write, but the read refuses to honour it either way.
          inArray(schema.mcpServerAlertMutesTable.issueKind, MUTABLE_KINDS),
        ),
      );

    const failedAtByServerId = new Map(
      params.mcpServers.map((server) => [
        server.id,
        server.oauthRefreshFailedAt?.getTime() ?? null,
      ]),
    );

    for (const row of rows) {
      const currentFailedAt = failedAtByServerId.get(row.mcpServerId) ?? null;
      if (currentFailedAt !== row.oauthRefreshFailedAt.getTime()) {
        continue;
      }
      const mutes = byServerId.get(row.mcpServerId) ?? [];
      mutes.push(toAlertMute(row));
      byServerId.set(row.mcpServerId, mutes);
    }

    return byServerId;
  }
}

export default McpServerAlertMuteModel;

// === Internal helpers

const MUTABLE_KINDS: McpServerMutableAlertKind[] = [
  ...McpServerMutableAlertKindSchema.options,
];

/** The unique-index triple that identifies one viewer's mute on one alert. */
function viewerAlert(params: {
  userId: string;
  mcpServerId: string;
  issueKind: McpServerMutableAlertKind;
}) {
  return and(
    eq(schema.mcpServerAlertMutesTable.userId, params.userId),
    eq(schema.mcpServerAlertMutesTable.mcpServerId, params.mcpServerId),
    eq(schema.mcpServerAlertMutesTable.issueKind, params.issueKind),
  );
}

/**
 * Project a row onto the read shape. `mutedAt` is `updatedAt`, not `createdAt`:
 * re-muting after a fresh failure reuses the row, and the viewer means "when
 * did I silence THIS alert".
 */
function toAlertMute(
  row: typeof schema.mcpServerAlertMutesTable.$inferSelect,
): McpServerAlertMute {
  return {
    mcpServerId: row.mcpServerId,
    issueKind: row.issueKind,
    reason: row.reason,
    mutedAt: row.updatedAt,
  };
}
