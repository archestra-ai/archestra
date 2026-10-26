import { and, eq, lt } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
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
   * own age. Usage whose decision is gone is an orphan the fit already ignores.
   */
  static async purgeExpired(
    now: Date = new Date(),
  ): Promise<{ decisions: number; usage: number }> {
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    return withDbTransaction(async (tx) => {
      const purgedDecisions = await tx
        .delete(decisions)
        .where(lt(decisions.createdAt, cutoff))
        .returning({ id: decisions.id });
      const purgedUsage = await tx
        .delete(usage)
        .where(lt(usage.createdAt, cutoff))
        .returning({ id: usage.interactionId });
      return {
        decisions: purgedDecisions.length,
        usage: purgedUsage.length,
      };
    });
  }
}

export default RoutingDecisionModel;
