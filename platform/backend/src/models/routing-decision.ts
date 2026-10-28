import { and, eq, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import db, { schema } from "@/database";
import { hashMessage } from "@/models/interaction-delta-manager";
import {
  type InsertRoutingDecision,
  type RoutingDecision,
  type RoutingSessionKey,
  RoutingSessionKeySchema,
  SelectRoutingDecisionSchema,
} from "@/types/auto-routing";

const decisions = schema.routingDecisionsTable;
const usage = schema.routingUsageTable;

/** Routing history older than this is purged; its sessions route afresh. */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

class RoutingDecisionModel {
  /**
   * The client's session id, else the virtual key plus the hash of the first
   * user message, so a client resending its conversation keeps its tier.
   * Identical first messages under one key share a decision. Null when there
   * is nothing to stick to.
   */
  static sessionKey(params: {
    sessionId: string | null;
    virtualKeyId: string | null;
    firstUserMessage: unknown;
  }): RoutingSessionKey | null {
    const { sessionId, virtualKeyId, firstUserMessage } = params;
    if (sessionId) return RoutingSessionKeySchema.parse(sessionId);
    if (!virtualKeyId || firstUserMessage == null) return null;
    return RoutingSessionKeySchema.parse(
      `auto-routing:${virtualKeyId}:${hashMessage(firstUserMessage)}`,
    );
  }

  static async find(params: {
    organizationId: string;
    sessionKey: RoutingSessionKey;
    segment?: number;
  }): Promise<RoutingDecision | null> {
    const [row] = await db
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.organizationId, params.organizationId),
          eq(decisions.sessionKey, params.sessionKey),
          eq(decisions.segment, params.segment ?? 0),
        ),
      );
    return row ? SelectRoutingDecisionSchema.parse(row) : null;
  }

  /** The session's decision: `values` when first, else the one a concurrent request stored. */
  static async insertOrGet(
    values: InsertRoutingDecision,
  ): Promise<{ decision: RoutingDecision; created: boolean }> {
    const [inserted] = await db
      .insert(decisions)
      .values(values)
      .onConflictDoNothing({
        target: [
          decisions.organizationId,
          decisions.sessionKey,
          decisions.segment,
        ],
      })
      .returning();
    if (inserted) {
      return {
        decision: SelectRoutingDecisionSchema.parse(inserted),
        created: true,
      };
    }
    const existing = await RoutingDecisionModel.find(values);
    if (!existing)
      throw new Error("Routing decision conflicted but could not be read");
    return { decision: existing, created: false };
  }

  /**
   * Deletes decisions and usage older than the retention window, each by its
   * own age, `batchSize` rows per statement. Usage whose decision is gone is an
   * orphan the fit already ignores.
   */
  static async purgeExpired(
    now: Date = new Date(),
    batchSize = PURGE_BATCH_SIZE,
  ): Promise<{ decisions: number; usage: number }> {
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    return {
      decisions: await deleteBefore(
        decisions,
        decisions.id,
        decisions.createdAt,
        cutoff,
        batchSize,
      ),
      usage: await deleteBefore(
        usage,
        usage.interactionId,
        usage.createdAt,
        cutoff,
        batchSize,
      ),
    };
  }
}

export default RoutingDecisionModel;

const PURGE_BATCH_SIZE = 5000;

/** Deletes `table` rows created before `cutoff` in batches, counting them without returning them. */
async function deleteBefore(
  table: PgTable,
  key: AnyPgColumn,
  createdAt: AnyPgColumn,
  cutoff: Date,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await db.execute<{ deleted: number }>(sql`
      with batch as (
        select ${key} as key from ${table}
        where ${createdAt} < ${cutoff.toISOString()}::timestamptz
        limit ${batchSize}
      ),
      removed as (
        delete from ${table} where ${key} in (select key from batch)
        returning 1
      )
      select count(*)::int as deleted from removed
    `);
    const deleted = Number(result.rows[0]?.deleted ?? 0);
    total += deleted;
    if (deleted < batchSize) return total;
  }
}
