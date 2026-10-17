import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { LRUCacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import logger from "@/logging";
import { trackBackgroundWork } from "@/utils/background-work";

/**
 * Keeps `agents.last_used_at` current. The two log writers
 * (`McpToolCallModel.create`, `InteractionModel.create`) call it after each
 * insert, so agent lists read one column instead of scanning the logs.
 */
class AgentUsageModel {
  /**
   * Stamp the agent as used at `usedAt`. Forward-only: an older value never
   * replaces a newer one, so writes that commit out of order cannot move it
   * back. `updated_at` is left as it is, because a use is not an edit.
   */
  static async recordUse(params: {
    agentId: string;
    usedAt: Date;
  }): Promise<void> {
    await db
      .update(schema.agentsTable)
      .set({
        lastUsedAt: params.usedAt,
        // No-op self-assignment: overrides the column's $onUpdate bump.
        updatedAt: sql`${schema.agentsTable.updatedAt}`,
      })
      .where(
        and(
          eq(schema.agentsTable.id, params.agentId),
          or(
            isNull(schema.agentsTable.lastUsedAt),
            lt(schema.agentsTable.lastUsedAt, params.usedAt),
          ),
        ),
      );
  }

  /**
   * {@link recordUse} as tracked background work, so the log write it follows
   * returns without waiting for it. A failed stamp is logged and never fails
   * that write. No-op without an agent.
   *
   * Throttled per process: a use less than {@link STAMP_INTERVAL_MS} after
   * the last one this process stamped for the agent is skipped, so the stored
   * value can lag by up to that interval. Without it, a burst of calls on one
   * agent queues every stamp on the same agents row lock.
   */
  static recordUseInBackground(params: {
    agentId: string | null | undefined;
    usedAt: Date;
  }): void {
    const { agentId, usedAt } = params;
    if (!agentId) return;
    const lastStamped = AgentUsageModel.recentStamps.get(agentId);
    if (
      lastStamped !== undefined &&
      usedAt.getTime() - lastStamped < STAMP_INTERVAL_MS
    ) {
      return;
    }
    AgentUsageModel.recentStamps.set(agentId, usedAt.getTime());
    trackBackgroundWork(
      AgentUsageModel.recordUse({ agentId, usedAt }).catch((error) => {
        // Let the next use retry instead of waiting out the interval.
        AgentUsageModel.recentStamps.delete(agentId);
        logger.error(
          { error, agentId },
          "Failed to update agents.last_used_at",
        );
      }),
    );
  }

  /** When this process last stamped each agent, in epoch milliseconds. */
  private static readonly recentStamps = new LRUCacheManager<number>({
    maxSize: 10_000,
    defaultTtl: 60_000,
  });
}

/** Minimum gap between two background stamps of one agent from one process. */
const STAMP_INTERVAL_MS = 1_000;

export default AgentUsageModel;
