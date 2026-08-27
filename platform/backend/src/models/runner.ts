import { and, asc, count, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type {
  AgentLabelWithDetails,
  InsertRunner,
  Runner,
  RunnerWithLabels,
  UpdateRunner,
} from "@/types";
import RunnerLabelModel from "./runner-label";

/**
 * Runner definitions: the container an agent's long-running work executes in.
 *
 * A definition, not a session — sessions are A2A tasks, and the pod carrying
 * one is recorded in `runner_sessions`.
 */
class RunnerModel {
  static async create(
    runner: InsertRunner,
    labels?: AgentLabelWithDetails[],
  ): Promise<Runner> {
    return withDbTransaction(async (tx) => {
      const [created] = await tx
        .insert(schema.runnersTable)
        .values(runner)
        .returning();
      if (labels) {
        await RunnerLabelModel.syncRunnerLabels(created.id, labels, tx);
      }
      return created;
    });
  }

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
    search?: string;
    environmentId?: string | null;
    /** Label filter as key -> accepted values; a runner must match every key. */
    labels?: Record<string, string[]>;
    limit?: number;
    offset?: number;
  }): Promise<{ runners: RunnerWithLabels[]; total: number }> {
    const filters = [
      eq(schema.runnersTable.organizationId, params.organizationId),
    ];
    if (params.search) {
      const term = `%${params.search}%`;
      const nameOrDescription = or(
        ilike(schema.runnersTable.name, term),
        ilike(schema.runnersTable.description, term),
      );
      if (nameOrDescription) filters.push(nameOrDescription);
    }
    // `undefined` means no filter at all; `null` means the Default environment,
    // which is stored as a NULL column rather than a row of its own.
    if (params.environmentId !== undefined) {
      filters.push(
        params.environmentId === null
          ? isNull(schema.runnersTable.environmentId)
          : eq(schema.runnersTable.environmentId, params.environmentId),
      );
    }

    const labelFilter = Object.fromEntries(
      Object.entries(params.labels ?? {}).filter(
        ([, values]) => values.length > 0,
      ),
    );
    if (Object.keys(labelFilter).length > 0) {
      const matchingIds =
        await RunnerLabelModel.getRunnerIdsMatchingLabels(labelFilter);
      if (matchingIds.length === 0) return { runners: [], total: 0 };
      filters.push(inArray(schema.runnersTable.id, matchingIds));
    }

    const where = and(...filters);
    const [{ total }] = await db
      .select({ total: count() })
      .from(schema.runnersTable)
      .where(where);

    const runners = await db
      .select()
      .from(schema.runnersTable)
      .where(where)
      .orderBy(asc(schema.runnersTable.name))
      .limit(params.limit ?? 50)
      .offset(params.offset ?? 0);

    // One query for every runner's labels rather than one per row.
    const labelsByRunner = await RunnerLabelModel.getLabelsForRunners(
      runners.map((runner) => runner.id),
    );

    return {
      runners: runners.map((runner) => ({
        ...runner,
        labels: labelsByRunner.get(runner.id) ?? [],
      })),
      total,
    };
  }

  static async update(
    id: string,
    organizationId: string,
    values: UpdateRunner,
    labels?: AgentLabelWithDetails[],
  ): Promise<Runner | null> {
    return withDbTransaction(async (tx) => {
      const [updated] = await tx
        .update(schema.runnersTable)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(schema.runnersTable.id, id),
            eq(schema.runnersTable.organizationId, organizationId),
          ),
        )
        .returning();
      if (!updated) return null;
      if (labels) {
        await RunnerLabelModel.syncRunnerLabels(id, labels, tx);
      }
      return updated;
    });
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

  /** Audit hook snapshot; see `AuditableModel`. */
  static async findByIdForAudit(
    id: string,
    orgId: string,
  ): Promise<Record<string, unknown> | null> {
    return RunnerModel.findById(id, orgId);
  }
}

export default RunnerModel;
