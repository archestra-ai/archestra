import { and, eq, gt, gte, isNotNull, notExists, or } from "drizzle-orm";
import db, { schema } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";

const agents = schema.agentsTable;
const plans = schema.routingPlansTable;
const tasks = schema.tasksTable;

class AutoRoutingDispatchModel {
  /**
   * Organizations with auto routing fully configured whose plan is due: a
   * plan-relevant write since the last fit outcome, or no outcome since
   * `staleBefore`.
   */
  static async findDueOrganizations(staleBefore: Date): Promise<string[]> {
    const recentFit = db
      .select({ id: plans.id })
      .from(plans)
      .where(
        and(
          eq(plans.organizationId, agents.organizationId),
          gte(plans.createdAt, staleBefore),
        ),
      );
    const rows = await db
      .select({ organizationId: agents.organizationId })
      .from(agents)
      .where(
        and(
          eq(agents.agentType, "llm_proxy"),
          eq(agents.isDefault, true),
          notDeleted(agents),
          eq(agents.autoRoutingEnabled, true),
          isNotNull(agents.autoRoutingBudgetUsdPerDay),
          isNotNull(agents.autoRoutingFastModelId),
          isNotNull(agents.autoRoutingNormalModelId),
          isNotNull(agents.autoRoutingSmartModelId),
          or(
            gt(
              agents.autoRoutingGeneration,
              agents.autoRoutingPlannedGeneration,
            ),
            notExists(recentFit),
          ),
        ),
      );
    return rows.map((row) => row.organizationId);
  }

  /** One `auto_routing_fit` per organization at a time; the partial unique index drops duplicates. */
  static async enqueueFits(organizationIds: string[]): Promise<number> {
    if (organizationIds.length === 0) return 0;
    const inserted = await db
      .insert(tasks)
      .values(
        organizationIds.map((organizationId) => ({
          taskType: "auto_routing_fit" as const,
          payload: { organizationId },
          maxAttempts: 1,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: tasks.id });
    return inserted.length;
  }
}

export default AutoRoutingDispatchModel;
