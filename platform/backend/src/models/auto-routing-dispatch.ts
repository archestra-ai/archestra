import { and, eq, gt, gte, isNotNull, notExists, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";

const routers = schema.autoRoutersTable;
const organizations = schema.organizationsTable;
const tiers = schema.autoRoutingTiersTable;
const plans = schema.routingPlansTable;
const tasks = schema.tasksTable;

class AutoRoutingDispatchModel {
  /**
   * Fully configured routers, in organizations with auto routing on, whose
   * plan is due: a plan-relevant write since the last fit outcome, or no
   * outcome since `staleBefore`.
   */
  static async findDueRouters(staleBefore: Date): Promise<string[]> {
    const recentFit = db
      .select({ id: plans.id })
      .from(plans)
      .where(
        and(eq(plans.routerId, routers.id), gte(plans.createdAt, staleBefore)),
      );
    const tierCount = db
      .select({ total: sql<number>`count(*)` })
      .from(tiers)
      .where(eq(tiers.routerId, routers.id));
    const rows = await db
      .select({ id: routers.id })
      .from(routers)
      .innerJoin(organizations, eq(organizations.id, routers.organizationId))
      .where(
        and(
          eq(organizations.autoRoutingEnabled, true),
          or(
            isNotNull(routers.budgetUsdPerDay),
            isNotNull(routers.budgetPreset),
          ),
          // Every tier is set.
          sql`(${tierCount}) = 3`,
          or(
            gt(routers.generation, routers.plannedGeneration),
            notExists(recentFit),
          ),
        ),
      );
    return rows.map((row) => row.id);
  }

  /** One `auto_routing_fit` per router at a time; the partial unique index drops duplicates. */
  static async enqueueFits(routerIds: string[]): Promise<number> {
    if (routerIds.length === 0) return 0;
    const inserted = await db
      .insert(tasks)
      .values(
        routerIds.map((routerId) => ({
          taskType: "auto_routing_fit" as const,
          payload: { routerId },
          maxAttempts: 1,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: tasks.id });
    return inserted.length;
  }

  /** Queues a backfill run unless one is already queued; the run claims whichever backfill is free. */
  static async enqueueBackfillRun(): Promise<void> {
    const queued = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.taskType, "auto_routing_backfill"),
          eq(tasks.status, "pending"),
        ),
      )
      .limit(1);
    if (queued.length > 0) return;
    await db.insert(tasks).values({
      taskType: "auto_routing_backfill",
      payload: {},
      maxAttempts: 1,
    });
  }
}

export default AutoRoutingDispatchModel;
