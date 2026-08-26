import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
  type SQL,
} from "drizzle-orm";
import db, { schema, withDbTransaction } from "@/database";
import type { EvalRun, EvalRunStatus } from "@/types/eval";
import { escapeLikePattern } from "@/utils/sql-search";

type EvalRunListFilters = {
  organizationId: string;
  suiteId?: string;
  agentId?: string;
  status?: EvalRunStatus;
  groupId?: string;
  /** Case-insensitive substring over the run label and agent name snapshot. */
  search?: string;
};

class EvalRunModel {
  /**
   * Create a run and snapshot the suite's current cases into pending result
   * rows, all in one transaction — the run grades a fixed case set even if
   * the suite is edited afterwards.
   */
  static async createWithResults(params: {
    organizationId: string;
    suiteId: string;
    agentId: string;
    /** Shared by runs started together (multi-agent comparison). */
    groupId: string;
    agentNameSnapshot: string;
    modelSnapshot: string | null;
    name: string | null;
    createdBy: string;
    cases: Array<
      Pick<
        typeof schema.evalCasesTable.$inferSelect,
        "id" | "name" | "messages" | "assertions" | "position"
      >
    >;
  }): Promise<EvalRun> {
    return await withDbTransaction(async (tx) => {
      const [run] = await tx
        .insert(schema.evalRunsTable)
        .values({
          organizationId: params.organizationId,
          suiteId: params.suiteId,
          agentId: params.agentId,
          groupId: params.groupId,
          agentNameSnapshot: params.agentNameSnapshot,
          modelSnapshot: params.modelSnapshot,
          name: params.name,
          createdBy: params.createdBy,
          totalCases: params.cases.length,
        })
        .returning();

      if (params.cases.length > 0) {
        await tx.insert(schema.evalRunResultsTable).values(
          params.cases.map((evalCase) => ({
            runId: run.id,
            caseId: evalCase.id,
            caseName: evalCase.name,
            messages: evalCase.messages,
            assertions: evalCase.assertions,
            position: evalCase.position,
          })),
        );
      }

      return run;
    });
  }

  /** Org-scoped lookup. */
  static async findById(
    id: string,
    organizationId: string,
  ): Promise<EvalRun | null> {
    const [run] = await db
      .select()
      .from(schema.evalRunsTable)
      .where(
        and(
          eq(schema.evalRunsTable.id, id),
          eq(schema.evalRunsTable.organizationId, organizationId),
        ),
      );
    return run ?? null;
  }

  /** Unscoped lookup for the task-queue worker (payload carries only runId). */
  static async findByIdUnscoped(id: string): Promise<EvalRun | null> {
    const [run] = await db
      .select()
      .from(schema.evalRunsTable)
      .where(eq(schema.evalRunsTable.id, id));
    return run ?? null;
  }

  static async countByOrganization(
    filters: EvalRunListFilters,
  ): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.evalRunsTable)
      .where(and(...buildListFilters(filters)));
    return result?.count ?? 0;
  }

  static async listByOrganization(
    params: EvalRunListFilters & { limit: number; offset: number },
  ): Promise<EvalRun[]> {
    return await db
      .select()
      .from(schema.evalRunsTable)
      .where(and(...buildListFilters(params)))
      .orderBy(desc(schema.evalRunsTable.createdAt))
      .limit(params.limit)
      .offset(params.offset);
  }

  /**
   * Claim the run for execution. Conditional on non-terminal status so a
   * cancel or a concurrent finalize is never overwritten; `pending` and
   * `running` are both claimable (a retried task resumes a crashed run).
   */
  static async markRunning(id: string): Promise<EvalRun | null> {
    const [run] = await db
      .update(schema.evalRunsTable)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(
          eq(schema.evalRunsTable.id, id),
          inArray(schema.evalRunsTable.status, ["pending", "running"]),
        ),
      )
      .returning();
    return run ?? null;
  }

  /**
   * Terminal transition owned by the executing worker: only a `running` run
   * is finalized, so a cancel that landed first wins.
   */
  static async finalize(params: {
    id: string;
    status: Extract<EvalRunStatus, "completed" | "failed">;
    error?: string;
    counts: {
      passedCases: number;
      failedCases: number;
      erroredCases: number;
      canceledCases: number;
    };
  }): Promise<EvalRun | null> {
    const [run] = await db
      .update(schema.evalRunsTable)
      .set({
        status: params.status,
        error: params.error ?? null,
        completedAt: new Date(),
        ...params.counts,
      })
      .where(
        and(
          eq(schema.evalRunsTable.id, params.id),
          eq(schema.evalRunsTable.status, "running"),
        ),
      )
      .returning();
    return run ?? null;
  }

  /**
   * Fail a run from any non-terminal state (worker-side validation failures,
   * enqueue compensation).
   */
  static async markFailed(id: string, error: string): Promise<EvalRun | null> {
    const [run] = await db
      .update(schema.evalRunsTable)
      .set({ status: "failed", error, completedAt: new Date() })
      .where(
        and(
          eq(schema.evalRunsTable.id, id),
          inArray(schema.evalRunsTable.status, ["pending", "running"]),
        ),
      )
      .returning();
    return run ?? null;
  }

  /**
   * Request cancellation. Only pending/running runs can be canceled; the
   * worker observes the status flip and aborts the in-flight case.
   */
  static async cancel(
    id: string,
    organizationId: string,
  ): Promise<EvalRun | null> {
    const [run] = await db
      .update(schema.evalRunsTable)
      .set({ status: "canceled", completedAt: new Date() })
      .where(
        and(
          eq(schema.evalRunsTable.id, id),
          eq(schema.evalRunsTable.organizationId, organizationId),
          inArray(schema.evalRunsTable.status, ["pending", "running"]),
        ),
      )
      .returning();
    return run ?? null;
  }

  /**
   * Rewrite the denormalized counts regardless of run status — used on the
   * cancel/fail paths, where the run row is already terminal but the per-case
   * tallies still need to reflect the results table.
   */
  static async updateCounts(
    id: string,
    counts: {
      passedCases: number;
      failedCases: number;
      erroredCases: number;
      canceledCases: number;
    },
  ): Promise<void> {
    await db
      .update(schema.evalRunsTable)
      .set(counts)
      .where(eq(schema.evalRunsTable.id, id));
  }

  /** Audit snapshot for evalRun.canceled records. */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const run = await EvalRunModel.findById(id, organizationId);
    if (!run) return null;
    return {
      id: run.id,
      suiteId: run.suiteId,
      agentId: run.agentId,
      agentName: run.agentNameSnapshot,
      name: run.name,
      status: run.status,
      totalCases: run.totalCases,
      createdBy: run.createdBy,
      createdAt: run.createdAt.toISOString(),
    };
  }

  /** Re-read just the status (cancellation watchdog poll). */
  static async getStatus(id: string): Promise<EvalRunStatus | null> {
    const [run] = await db
      .select({ status: schema.evalRunsTable.status })
      .from(schema.evalRunsTable)
      .where(eq(schema.evalRunsTable.id, id));
    return run?.status ?? null;
  }
}

export default EvalRunModel;

function buildListFilters(filters: EvalRunListFilters): SQL[] {
  const conditions: SQL[] = [
    eq(schema.evalRunsTable.organizationId, filters.organizationId),
  ];
  if (filters.suiteId !== undefined) {
    conditions.push(eq(schema.evalRunsTable.suiteId, filters.suiteId));
  }
  if (filters.agentId !== undefined) {
    conditions.push(eq(schema.evalRunsTable.agentId, filters.agentId));
  }
  if (filters.status !== undefined) {
    conditions.push(eq(schema.evalRunsTable.status, filters.status));
  }
  if (filters.groupId !== undefined) {
    conditions.push(eq(schema.evalRunsTable.groupId, filters.groupId));
  }
  if (filters.search) {
    const pattern = `%${escapeLikePattern(filters.search)}%`;
    const match = or(
      ilike(schema.evalRunsTable.name, pattern),
      ilike(schema.evalRunsTable.agentNameSnapshot, pattern),
    );
    if (match) conditions.push(match);
  }
  return conditions;
}
