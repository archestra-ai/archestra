import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertRunner, Runner, RunnerState, UpdateRunner } from "@/types";
import { RUNNER_TERMINAL_STATES } from "@/types";

class RunnerModel {
  static async create(runner: InsertRunner): Promise<Runner> {
    const [created] = await db
      .insert(schema.runnersTable)
      .values(runner)
      .returning();
    return created;
  }

  /**
   * Organization-scoped read. Callers never look a runner up by bare id: a
   * runner grants shell access to a pod holding its creator's credentials, so
   * every lookup carries the tenant boundary.
   */
  static async findById(
    id: string,
    organizationId: string,
  ): Promise<Runner | null> {
    const [runner] = await db
      .select()
      .from(schema.runnersTable)
      .where(
        and(
          eq(schema.runnersTable.id, id),
          eq(schema.runnersTable.organizationId, organizationId),
        ),
      )
      .limit(1);
    return runner ?? null;
  }

  static async list(params: {
    organizationId: string;
    agentId?: string;
    createdByUserId?: string;
    states?: RunnerState[];
  }): Promise<Runner[]> {
    const filters = [
      eq(schema.runnersTable.organizationId, params.organizationId),
    ];
    if (params.agentId) {
      filters.push(eq(schema.runnersTable.agentId, params.agentId));
    }
    if (params.createdByUserId) {
      filters.push(
        eq(schema.runnersTable.createdByUserId, params.createdByUserId),
      );
    }
    if (params.states?.length) {
      filters.push(inArray(schema.runnersTable.state, params.states));
    }
    return db
      .select()
      .from(schema.runnersTable)
      .where(and(...filters))
      .orderBy(desc(schema.runnersTable.createdAt));
  }

  static async update(
    id: string,
    organizationId: string,
    values: UpdateRunner,
  ): Promise<Runner | null> {
    const [updated] = await db
      .update(schema.runnersTable)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(schema.runnersTable.id, id),
          eq(schema.runnersTable.organizationId, organizationId),
        ),
      )
      .returning();
    return updated ?? null;
  }

  /**
   * Move a runner to a new state, optionally only from an expected current
   * state. The compare-and-set form is what keeps two reconciler passes (or a
   * reconciler racing a user's stop) from both driving a transition — the
   * loser gets null back and re-reads instead of clobbering.
   */
  static async transition(params: {
    id: string;
    organizationId: string;
    to: RunnerState;
    from?: RunnerState[];
    statusReason?: string | null;
  }): Promise<Runner | null> {
    const filters = [
      eq(schema.runnersTable.id, params.id),
      eq(schema.runnersTable.organizationId, params.organizationId),
    ];
    if (params.from?.length) {
      filters.push(inArray(schema.runnersTable.state, params.from));
    }
    const values: Record<string, unknown> = {
      state: params.to,
      updatedAt: new Date(),
    };
    if (params.statusReason !== undefined) {
      values.statusReason = params.statusReason;
    }
    if (params.to === "running") {
      values.startedAt = new Date();
      values.lastActivityAt = new Date();
    }
    if (RUNNER_TERMINAL_STATES.includes(params.to)) {
      values.stoppedAt = new Date();
    }
    const [updated] = await db
      .update(schema.runnersTable)
      .set(values)
      .where(and(...filters))
      .returning();
    return updated ?? null;
  }

  /** Push the idle clock forward; called on steer, attach and heartbeat. */
  static async touchActivity(id: string): Promise<void> {
    await db
      .update(schema.runnersTable)
      .set({ lastActivityAt: new Date() })
      .where(eq(schema.runnersTable.id, id));
  }

  /**
   * Runners that should currently have a workload, across every organization.
   * Used by the runtime manager's adopt pass on boot and by the reaper.
   */
  static async listLive(): Promise<Runner[]> {
    return db
      .select()
      .from(schema.runnersTable)
      .where(
        inArray(schema.runnersTable.state, [
          "pending",
          "provisioning",
          "running",
          "stopping",
        ]),
      )
      .orderBy(asc(schema.runnersTable.createdAt));
  }

  /**
   * Live runners whose TTL has elapsed, or which have been idle past their
   * timeout. Both clocks are evaluated in SQL so a backend restart cannot
   * reset them.
   */
  static async listExpired(now: Date): Promise<Runner[]> {
    return db
      .select()
      .from(schema.runnersTable)
      .where(
        and(
          inArray(schema.runnersTable.state, ["running", "provisioning"]),
          or(
            and(
              isNotNull(schema.runnersTable.ttlHours),
              lt(
                sql`${schema.runnersTable.createdAt} + make_interval(hours => ${schema.runnersTable.ttlHours})`,
                now,
              ),
            ),
            and(
              isNotNull(schema.runnersTable.idleTimeoutMinutes),
              isNotNull(schema.runnersTable.lastActivityAt),
              lt(
                sql`${schema.runnersTable.lastActivityAt} + make_interval(mins => ${schema.runnersTable.idleTimeoutMinutes})`,
                now,
              ),
            ),
          ),
        ),
      );
  }

  /** Deployment names of every runner still expected to own a workload. */
  static async listLiveDeploymentNames(): Promise<string[]> {
    const rows = await db
      .select({ deploymentName: schema.runnersTable.deploymentName })
      .from(schema.runnersTable)
      .where(
        and(
          isNotNull(schema.runnersTable.deploymentName),
          inArray(schema.runnersTable.state, [
            "pending",
            "provisioning",
            "running",
            "stopping",
          ]),
        ),
      );
    return rows
      .map((row) => row.deploymentName)
      .filter((name): name is string => name !== null);
  }

  static async delete(id: string, organizationId: string): Promise<boolean> {
    const deleted = await db
      .delete(schema.runnersTable)
      .where(
        and(
          eq(schema.runnersTable.id, id),
          eq(schema.runnersTable.organizationId, organizationId),
        ),
      )
      .returning({ id: schema.runnersTable.id });
    return deleted.length > 0;
  }
}

export default RunnerModel;
