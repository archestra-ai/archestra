import { and, asc, count, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertRunner, Runner, UpdateRunner } from "@/types";

/**
 * Runner definitions: the container an agent's long-running work executes in.
 *
 * A definition, not a session — sessions are A2A tasks, and the pod carrying
 * one is recorded in `runner_sessions`.
 */
class RunnerModel {
  static async create(runner: InsertRunner): Promise<Runner> {
    const [created] = await db
      .insert(schema.runnersTable)
      .values(runner)
      .returning();
    return created;
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
  }): Promise<{ runners: Runner[]; total: number }> {
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

    const matchingIds = await RunnerModel.idsMatchingLabels(params.labels);
    if (matchingIds !== null) {
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

    return { runners, total };
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

  // ===================== internals =====================

  /**
   * Runner ids carrying every requested label key with one of its accepted
   * values. Null means no label filter was asked for, which is different from
   * a filter that matched nothing.
   */
  private static async idsMatchingLabels(
    labels: Record<string, string[]> | undefined,
  ): Promise<string[] | null> {
    const entries = Object.entries(labels ?? {}).filter(
      ([, values]) => values.length > 0,
    );
    if (entries.length === 0) return null;

    let matching: string[] | null = null;
    for (const [key, values] of entries) {
      const rows = await db
        .select({ runnerId: schema.runnerLabelsTable.runnerId })
        .from(schema.runnerLabelsTable)
        .innerJoin(
          schema.labelKeysTable,
          eq(schema.labelKeysTable.id, schema.runnerLabelsTable.labelKeyId),
        )
        .innerJoin(
          schema.labelValuesTable,
          eq(schema.labelValuesTable.id, schema.runnerLabelsTable.labelValueId),
        )
        .where(
          and(
            eq(schema.labelKeysTable.key, key),
            inArray(schema.labelValuesTable.value, values),
          ),
        );
      const ids = rows.map((row) => row.runnerId);
      // Keys are ANDed: a runner has to satisfy every one of them.
      matching =
        matching === null ? ids : matching.filter((id) => ids.includes(id));
      if (matching.length === 0) return [];
    }
    return matching;
  }
}

export default RunnerModel;
