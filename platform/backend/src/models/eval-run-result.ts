import { and, asc, count, eq, lt, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  EvalAssertionResult,
  EvalRunResult,
  EvalRunResultStatus,
} from "@/types/eval";

class EvalRunResultModel {
  static async listByRun(params: {
    runId: string;
    limit: number;
    offset: number;
  }): Promise<EvalRunResult[]> {
    return await db
      .select()
      .from(schema.evalRunResultsTable)
      .where(eq(schema.evalRunResultsTable.runId, params.runId))
      .orderBy(asc(schema.evalRunResultsTable.position))
      .limit(params.limit)
      .offset(params.offset);
  }

  static async countByRun(runId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.evalRunResultsTable)
      .where(eq(schema.evalRunResultsTable.runId, runId));
    return result?.count ?? 0;
  }

  /** All results of a run in position order (worker iteration). */
  static async listAllByRun(runId: string): Promise<EvalRunResult[]> {
    return await db
      .select()
      .from(schema.evalRunResultsTable)
      .where(eq(schema.evalRunResultsTable.runId, runId))
      .orderBy(asc(schema.evalRunResultsTable.position));
  }

  /**
   * Atomically claim a pending case for execution. Returns the claimed row or
   * null if another worker got there first (shutdown-timeout requeue can
   * briefly leave two workers on one task; claims make the overlap safe).
   */
  static async claimPending(id: string): Promise<EvalRunResult | null> {
    const [row] = await db
      .update(schema.evalRunResultsTable)
      .set({ status: "running", startedAt: new Date() })
      .where(
        and(
          eq(schema.evalRunResultsTable.id, id),
          eq(schema.evalRunResultsTable.status, "pending"),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Terminal write for a case this attempt claimed; conditional on `running`
   * so it never overwrites a concurrent terminal transition.
   */
  static async complete(params: {
    id: string;
    status: Extract<
      EvalRunResultStatus,
      "passed" | "failed" | "error" | "canceled"
    >;
    outputText?: string | null;
    finishReason?: string | null;
    toolCalls?: string[] | null;
    assertionResults?: EvalAssertionResult[] | null;
    error?: string | null;
    sessionId?: string | null;
    judgeSessionId?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    durationMs?: number | null;
  }): Promise<EvalRunResult | null> {
    const { id, status, ...fields } = params;
    const [row] = await db
      .update(schema.evalRunResultsTable)
      .set({ status, completedAt: new Date(), ...fields })
      .where(
        and(
          eq(schema.evalRunResultsTable.id, id),
          eq(schema.evalRunResultsTable.status, "running"),
        ),
      )
      .returning();
    return row ?? null;
  }

  /**
   * Mark a crash artifact: a row found `running` with a stale `startedAt` is
   * from a worker that died mid-case. It is never re-executed (the agent may
   * have performed side effects), only closed out as an error. Conditional on
   * the observed `startedAt` so a genuinely live worker's row is untouched.
   */
  static async markInterrupted(params: {
    id: string;
    observedStartedAt: Date;
  }): Promise<EvalRunResult | null> {
    const [row] = await db
      .update(schema.evalRunResultsTable)
      .set({
        status: "error",
        error: "interrupted: worker crashed while executing this case",
        completedAt: new Date(),
      })
      .where(
        and(
          eq(schema.evalRunResultsTable.id, params.id),
          eq(schema.evalRunResultsTable.status, "running"),
          lt(
            schema.evalRunResultsTable.startedAt,
            new Date(params.observedStartedAt.getTime() + 1),
          ),
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Cancel every still-pending case of a run (run canceled / failed early). */
  static async cancelPendingByRun(runId: string): Promise<number> {
    const rows = await db
      .update(schema.evalRunResultsTable)
      .set({ status: "canceled", completedAt: new Date() })
      .where(
        and(
          eq(schema.evalRunResultsTable.runId, runId),
          eq(schema.evalRunResultsTable.status, "pending"),
        ),
      )
      .returning({ id: schema.evalRunResultsTable.id });
    return rows.length;
  }

  /** Count results per terminal status (run finalization). */
  static async countByStatus(
    runId: string,
  ): Promise<Record<EvalRunResultStatus, number>> {
    const rows = await db
      .select({
        status: schema.evalRunResultsTable.status,
        count: count(),
      })
      .from(schema.evalRunResultsTable)
      .where(eq(schema.evalRunResultsTable.runId, runId))
      .groupBy(schema.evalRunResultsTable.status);

    const counts: Record<EvalRunResultStatus, number> = {
      pending: 0,
      running: 0,
      passed: 0,
      failed: 0,
      error: 0,
      canceled: 0,
    };
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  /** Token totals across a run's results (run detail aggregates). */
  static async sumTokensByRun(runId: string): Promise<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }> {
    const [row] = await db
      .select({
        inputTokens: sql<
          number | null
        >`SUM(${schema.evalRunResultsTable.inputTokens})`,
        outputTokens: sql<
          number | null
        >`SUM(${schema.evalRunResultsTable.outputTokens})`,
        totalTokens: sql<
          number | null
        >`SUM(${schema.evalRunResultsTable.totalTokens})`,
      })
      .from(schema.evalRunResultsTable)
      .where(eq(schema.evalRunResultsTable.runId, runId));
    return {
      inputTokens: Number(row?.inputTokens ?? 0),
      outputTokens: Number(row?.outputTokens ?? 0),
      totalTokens: Number(row?.totalTokens ?? 0),
    };
  }

  /** Session ids referenced by a run's results (cost aggregation). */
  static async getSessionIds(runId: string): Promise<string[]> {
    const rows = await db
      .select({
        sessionId: schema.evalRunResultsTable.sessionId,
        judgeSessionId: schema.evalRunResultsTable.judgeSessionId,
      })
      .from(schema.evalRunResultsTable)
      .where(eq(schema.evalRunResultsTable.runId, runId));

    const ids = new Set<string>();
    for (const row of rows) {
      if (row.sessionId) ids.add(row.sessionId);
      if (row.judgeSessionId) ids.add(row.judgeSessionId);
    }
    return [...ids];
  }
}

export default EvalRunResultModel;
