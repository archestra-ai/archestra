import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  BatchAnalysis,
  BatchAnalysisCell,
  BatchAnalysisCitation,
  BatchAnalysisRow,
  BatchAnalysisRowSource,
  BatchAnalysisRun,
  InsertBatchAnalysis,
} from "@/types";
import type {
  BatchAnalysisCellFlag,
  BatchAnalysisColumn,
} from "@/types/batch-analysis";
import type { ResourceVisibilityScope } from "@/types/visibility";

/** Who is asking, for visibility filtering. */
export interface BatchAnalysisViewer {
  userId: string;
  teamIds: string[];
  /** Admins with read-all see every analysis, including personal ones. */
  canReadAll: boolean;
}

/**
 * Verification precondition failure — the route maps it to a 400 naming the
 * offending cell rather than a generic 500.
 */
export class CellVerificationError extends Error {}

class BatchAnalysisModel {
  // ===== Analyses =====

  static async create(data: InsertBatchAnalysis): Promise<BatchAnalysis> {
    const [analysis] = await db
      .insert(schema.batchAnalysesTable)
      .values(data)
      .returning();
    return analysis as BatchAnalysis;
  }

  /**
   * `viewer` omitted means an internal caller (the run worker) that has already
   * authorized the request; a request-facing caller must always pass one, or a
   * personal analysis would be readable by the whole organization.
   */
  static async findById(params: {
    analysisId: string;
    organizationId: string;
    viewer?: BatchAnalysisViewer;
  }): Promise<BatchAnalysis | null> {
    const [analysis] = await db
      .select()
      .from(schema.batchAnalysesTable)
      .where(
        and(
          eq(schema.batchAnalysesTable.id, params.analysisId),
          eq(schema.batchAnalysesTable.organizationId, params.organizationId),
          params.viewer
            ? BatchAnalysisModel.visibleTo(params.viewer)
            : undefined,
        ),
      );
    return (analysis as BatchAnalysis | undefined) ?? null;
  }

  static async update(params: {
    analysisId: string;
    organizationId: string;
    data: Partial<{
      name: string;
      agentId: string;
      columns: BatchAnalysisColumn[];
      scope: ResourceVisibilityScope;
    }>;
  }): Promise<BatchAnalysis | null> {
    const [analysis] = await db
      .update(schema.batchAnalysesTable)
      .set(params.data)
      .where(
        and(
          eq(schema.batchAnalysesTable.id, params.analysisId),
          eq(schema.batchAnalysesTable.organizationId, params.organizationId),
        ),
      )
      .returning();
    return (analysis as BatchAnalysis | undefined) ?? null;
  }

  static async delete(params: {
    analysisId: string;
    organizationId: string;
  }): Promise<boolean> {
    const deleted = await db
      .delete(schema.batchAnalysesTable)
      .where(
        and(
          eq(schema.batchAnalysesTable.id, params.analysisId),
          eq(schema.batchAnalysesTable.organizationId, params.organizationId),
        ),
      )
      .returning({ id: schema.batchAnalysesTable.id });
    return deleted.length > 0;
  }

  static async findTeamIds(analysisId: string): Promise<string[]> {
    const rows = await db
      .select({ teamId: schema.batchAnalysisTeamTable.teamId })
      .from(schema.batchAnalysisTeamTable)
      .where(eq(schema.batchAnalysisTeamTable.batchAnalysisId, analysisId));
    return rows.map((row) => row.teamId);
  }

  /** Team ids per analysis, batched so a listing does not query per row. */
  static async findTeamIdsForAnalyses(
    analysisIds: string[],
  ): Promise<Map<string, string[]>> {
    if (analysisIds.length === 0) return new Map();
    const rows = await db
      .select({
        analysisId: schema.batchAnalysisTeamTable.batchAnalysisId,
        teamId: schema.batchAnalysisTeamTable.teamId,
      })
      .from(schema.batchAnalysisTeamTable)
      .where(
        inArray(schema.batchAnalysisTeamTable.batchAnalysisId, analysisIds),
      );

    const byAnalysis = new Map<string, string[]>();
    for (const row of rows) {
      const existing = byAnalysis.get(row.analysisId);
      if (existing) existing.push(row.teamId);
      else byAnalysis.set(row.analysisId, [row.teamId]);
    }
    return byAnalysis;
  }

  /** Replaces the analysis's team assignments wholesale. */
  static async setTeams(params: {
    analysisId: string;
    teamIds: string[];
  }): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.batchAnalysisTeamTable)
        .where(
          eq(schema.batchAnalysisTeamTable.batchAnalysisId, params.analysisId),
        );
      if (params.teamIds.length === 0) return;
      await tx.insert(schema.batchAnalysisTeamTable).values(
        params.teamIds.map((teamId) => ({
          batchAnalysisId: params.analysisId,
          teamId,
        })),
      );
    });
  }

  static async findAllByOrganization(params: {
    organizationId: string;
    viewer: BatchAnalysisViewer;
    search?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: BatchAnalysis[]; total: number }> {
    const where = and(
      eq(schema.batchAnalysesTable.organizationId, params.organizationId),
      BatchAnalysisModel.visibleTo(params.viewer),
      ...(params.search
        ? [ilike(schema.batchAnalysesTable.name, `%${params.search}%`)]
        : []),
    );
    const [items, [counted]] = await Promise.all([
      db
        .select()
        .from(schema.batchAnalysesTable)
        .where(where)
        .orderBy(desc(schema.batchAnalysesTable.createdAt))
        .limit(params.limit)
        .offset(params.offset),
      db
        .select({ value: count() })
        .from(schema.batchAnalysesTable)
        .where(where),
    ]);
    return {
      items: items as BatchAnalysis[],
      total: counted?.value ?? 0,
    };
  }

  /**
   * Snapshot for the audit log. Columns carry the prompts an analysis will run
   * against every row, so a change to them changes what the platform asks on the
   * operator's behalf — that belongs in the audit trail, not just in the row.
   */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const analysis = await BatchAnalysisModel.findById({
      analysisId: id,
      organizationId,
    });
    if (!analysis) return null;

    // Row count and latest-run identity are included so every mutation this
    // registry covers produces a non-empty diff: adding rows moves `rowCount`,
    // and dispatching a run (or retrying a cell) moves `latestRunId`. Without
    // them a run would audit as an empty before/after, which reads as "nothing
    // happened" for the one action that actually spends money.
    const [rows, latestRun] = await Promise.all([
      BatchAnalysisModel.findRows(id),
      BatchAnalysisModel.findLatestRun(id),
    ]);

    return {
      id: analysis.id,
      name: analysis.name,
      agentId: analysis.agentId,
      columns: analysis.columns,
      createdBy: analysis.createdBy,
      rowCount: rows.length,
      latestRunId: latestRun?.id ?? null,
      latestRunStatus: latestRun?.status ?? null,
    };
  }

  // ===== Rows =====

  /**
   * Audit snapshot for the cell-verification route. The parent analysis
   * snapshot carries no cell state, so verification changes would diff as
   * "nothing happened"; this one carries the verification surface itself. A
   * digest over every verified `(row, column, verifier)` triple guarantees a
   * real diff even for count-neutral mutations (verify one cell, unverify
   * another; or the same cell re-verified by someone else), and the explicit
   * map is included while it stays small enough to read in the audit UI.
   */
  static async findVerificationForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const analysis = await BatchAnalysisModel.findById({
      analysisId: id,
      organizationId,
    });
    if (!analysis) return null;

    const rows = await db
      .select({
        rowId: schema.batchAnalysisCellsTable.rowId,
        columnKey: schema.batchAnalysisCellsTable.columnKey,
        verifiedBy: schema.batchAnalysisCellsTable.verifiedBy,
        verifiedAt: schema.batchAnalysisCellsTable.verifiedAt,
      })
      .from(schema.batchAnalysisCellsTable)
      .innerJoin(
        schema.batchAnalysisRowsTable,
        eq(
          schema.batchAnalysisRowsTable.id,
          schema.batchAnalysisCellsTable.rowId,
        ),
      )
      .where(
        and(
          eq(schema.batchAnalysisRowsTable.analysisId, id),
          isNotNull(schema.batchAnalysisCellsTable.verifiedAt),
        ),
      );

    const entries = rows
      .map(
        (row) =>
          // verifiedAt is part of the identity: re-verifying the same cell by
          // the same reviewer is still a state change worth a differing digest.
          `${row.rowId}:${row.columnKey}:${row.verifiedBy ?? ""}:${row.verifiedAt?.toISOString() ?? ""}`,
      )
      .sort();
    return {
      id: analysis.id,
      name: analysis.name,
      verifiedCellCount: entries.length,
      verificationDigest: createHash("sha256")
        .update(entries.join("\n"))
        .digest("hex"),
      ...(entries.length <= VERIFICATION_AUDIT_MAP_LIMIT
        ? { verifiedCells: entries }
        : {}),
    };
  }

  /**
   * Toggle human sign-off on a set of cells, all-or-nothing. Every entry must
   * name a `done` cell belonging to this analysis — verifying a pending,
   * generating, failed, or foreign cell is refused before anything mutates.
   * Returns the updated cells in entry order.
   */
  static async setCellsVerification(params: {
    analysisId: string;
    userId: string;
    entries: { rowId: string; columnKey: string; verified: boolean }[];
  }): Promise<BatchAnalysisCell[]> {
    // Duplicate coordinates collapse to the last occurrence — the bulk UPDATE
    // counts distinct rows, so an uncollapsed duplicate would read as "a cell
    // changed underneath us" and fail the whole batch.
    const entries = [
      ...new Map(
        params.entries.map((entry) => [
          `${entry.rowId}:${entry.columnKey}`,
          entry,
        ]),
      ).values(),
    ];
    return db.transaction(async (tx) => {
      const targets = await tx
        .select({
          id: schema.batchAnalysisCellsTable.id,
          rowId: schema.batchAnalysisCellsTable.rowId,
          columnKey: schema.batchAnalysisCellsTable.columnKey,
          status: schema.batchAnalysisCellsTable.status,
        })
        .from(schema.batchAnalysisCellsTable)
        .innerJoin(
          schema.batchAnalysisRowsTable,
          eq(
            schema.batchAnalysisRowsTable.id,
            schema.batchAnalysisCellsTable.rowId,
          ),
        )
        .where(
          and(
            eq(schema.batchAnalysisRowsTable.analysisId, params.analysisId),
            inArray(
              schema.batchAnalysisCellsTable.rowId,
              entries.map((entry) => entry.rowId),
            ),
          ),
        );
      const byKey = new Map(
        targets.map((cell) => [`${cell.rowId}:${cell.columnKey}`, cell]),
      );

      for (const entry of entries) {
        const cell = byKey.get(`${entry.rowId}:${entry.columnKey}`);
        if (!cell) {
          throw new CellVerificationError(
            `Cell ${entry.columnKey} on row ${entry.rowId} does not exist in this analysis`,
          );
        }
        if (cell.status !== "done") {
          throw new CellVerificationError(
            `Cell ${entry.columnKey} on row ${entry.rowId} has no completed answer to verify`,
          );
        }
      }

      // Two bulk UPDATEs (verify set, unverify set) instead of one per entry:
      // a 500-entry request must not hold the transaction open across 500
      // round trips. The `status = 'done'` predicate is re-asserted inside the
      // UPDATE — a concurrent retry can flip a cell off `done` between the
      // validation read above and here, and a sign-off must never land on a
      // cell that no longer holds the answer it was given for. A short row
      // count → the whole batch rolls back.
      const updated = new Map<string, BatchAnalysisCell>();
      for (const verified of [true, false]) {
        const group = entries.filter((entry) => entry.verified === verified);
        if (group.length === 0) continue;
        const cells = await tx
          .update(schema.batchAnalysisCellsTable)
          .set(
            verified
              ? { verifiedBy: params.userId, verifiedAt: new Date() }
              : { verifiedBy: null, verifiedAt: null },
          )
          .where(
            and(
              or(
                ...group.map((entry) =>
                  and(
                    eq(schema.batchAnalysisCellsTable.rowId, entry.rowId),
                    eq(
                      schema.batchAnalysisCellsTable.columnKey,
                      entry.columnKey,
                    ),
                  ),
                ),
              ),
              eq(schema.batchAnalysisCellsTable.status, "done"),
            ),
          )
          .returning();
        if (cells.length !== group.length) {
          throw new CellVerificationError(
            "A cell changed while verifying; retry after the grid settles",
          );
        }
        for (const cell of cells as BatchAnalysisCell[]) {
          updated.set(`${cell.rowId}:${cell.columnKey}`, cell);
        }
      }
      return entries.map(
        (entry) =>
          updated.get(`${entry.rowId}:${entry.columnKey}`) as BatchAnalysisCell,
      );
    });
  }

  static async addRows(
    analysisId: string,
    rows: Array<{
      label: string;
      source: BatchAnalysisRowSource;
      sortIndex: number;
    }>,
  ): Promise<BatchAnalysisRow[]> {
    if (rows.length === 0) return [];
    const inserted = await db
      .insert(schema.batchAnalysisRowsTable)
      .values(
        rows.map((row) => ({
          analysisId,
          label: row.label,
          sourceType: row.source.type,
          source: row.source,
          sortIndex: row.sortIndex,
        })),
      )
      .returning();
    return inserted as BatchAnalysisRow[];
  }

  static async findRows(analysisId: string): Promise<BatchAnalysisRow[]> {
    const rows = await db
      .select()
      .from(schema.batchAnalysisRowsTable)
      .where(eq(schema.batchAnalysisRowsTable.analysisId, analysisId))
      .orderBy(asc(schema.batchAnalysisRowsTable.sortIndex));
    return rows as BatchAnalysisRow[];
  }

  /**
   * Delete one row; its cells go with it (FK cascade). Scoped to the analysis
   * so a rowId from a different analysis cannot be deleted through this one's
   * route authorization.
   */
  static async deleteRow(params: {
    analysisId: string;
    rowId: string;
  }): Promise<boolean> {
    const deleted = await db
      .delete(schema.batchAnalysisRowsTable)
      .where(
        and(
          eq(schema.batchAnalysisRowsTable.id, params.rowId),
          eq(schema.batchAnalysisRowsTable.analysisId, params.analysisId),
        ),
      )
      .returning({ id: schema.batchAnalysisRowsTable.id });
    return deleted.length > 0;
  }

  /**
   * Null the stored triage flags for columns that opted OUT of flagging. The
   * answers stand — only the classification is withdrawn, matching what the
   * column configuration now promises.
   */
  static async clearFlagsForColumns(params: {
    analysisId: string;
    columnKeys: string[];
  }): Promise<void> {
    if (params.columnKeys.length === 0) return;
    const rowIds = db
      .select({ id: schema.batchAnalysisRowsTable.id })
      .from(schema.batchAnalysisRowsTable)
      .where(eq(schema.batchAnalysisRowsTable.analysisId, params.analysisId));
    await db
      .update(schema.batchAnalysisCellsTable)
      .set({ flag: null })
      .where(
        and(
          inArray(schema.batchAnalysisCellsTable.rowId, rowIds),
          inArray(schema.batchAnalysisCellsTable.columnKey, params.columnKeys),
        ),
      );
  }

  /**
   * Drop cells whose column no longer exists on the analysis. Run after a
   * column edit: orphaned cells render nowhere but still count in progress
   * totals, so "12/15 cells" would never reach 15 again after removing a
   * column.
   */
  static async deleteCellsForRemovedColumns(params: {
    analysisId: string;
    keptColumnKeys: string[];
  }): Promise<void> {
    const rows = db
      .select({ id: schema.batchAnalysisRowsTable.id })
      .from(schema.batchAnalysisRowsTable)
      .where(eq(schema.batchAnalysisRowsTable.analysisId, params.analysisId));
    await db
      .delete(schema.batchAnalysisCellsTable)
      .where(
        and(
          inArray(schema.batchAnalysisCellsTable.rowId, rows),
          params.keptColumnKeys.length > 0
            ? notInArray(
                schema.batchAnalysisCellsTable.columnKey,
                params.keptColumnKeys,
              )
            : undefined,
        ),
      );
  }

  static async findRowById(rowId: string): Promise<BatchAnalysisRow | null> {
    const [row] = await db
      .select()
      .from(schema.batchAnalysisRowsTable)
      .where(eq(schema.batchAnalysisRowsTable.id, rowId));
    return (row as BatchAnalysisRow | undefined) ?? null;
  }

  // ===== Cells =====

  /**
   * Create any missing cells for the given rows/columns as `pending`, leaving
   * existing cells untouched. Idempotent via the `(row_id, column_key)` unique
   * index, which is what makes starting a run over an already-populated grid
   * safe — a re-run must never wipe results it is about to skip.
   */
  static async ensureCells(params: {
    rowIds: string[];
    columnKeys: string[];
  }): Promise<void> {
    if (params.rowIds.length === 0 || params.columnKeys.length === 0) return;
    const values = params.rowIds.flatMap((rowId) =>
      params.columnKeys.map((columnKey) => ({
        rowId,
        columnKey,
        status: "pending" as const,
      })),
    );
    await db
      .insert(schema.batchAnalysisCellsTable)
      .values(values)
      .onConflictDoNothing({
        target: [
          schema.batchAnalysisCellsTable.rowId,
          schema.batchAnalysisCellsTable.columnKey,
        ],
      });
  }

  static async findCellsByRows(rowIds: string[]): Promise<BatchAnalysisCell[]> {
    if (rowIds.length === 0) return [];
    const cells = await db
      .select()
      .from(schema.batchAnalysisCellsTable)
      .where(inArray(schema.batchAnalysisCellsTable.rowId, rowIds));
    return cells as BatchAnalysisCell[];
  }

  /**
   * Column keys on this row that are not already `done`. This is the resume
   * primitive: a re-run asks only for what is missing, so completed work is
   * never recomputed and never re-billed.
   */
  static async findUnfinishedColumnKeys(rowId: string): Promise<string[]> {
    const cells = await db
      .select({ columnKey: schema.batchAnalysisCellsTable.columnKey })
      .from(schema.batchAnalysisCellsTable)
      .where(
        and(
          eq(schema.batchAnalysisCellsTable.rowId, rowId),
          ne(schema.batchAnalysisCellsTable.status, "done"),
        ),
      );
    return cells.map((cell) => cell.columnKey);
  }

  /**
   * Atomically claim the cells this worker may generate, returning only the
   * ones it actually won.
   *
   * The claim is the `status IN ('pending','error')` predicate: an UPDATE takes
   * a row lock, so when the same row is dispatched twice — a duplicate delivery,
   * or a resumed run racing a straggler — the second statement blocks, then sees
   * `generating` and matches nothing. Without the predicate both workers claimed
   * the same cells, both called the model (double spend), both wrote a result,
   * and both incremented the run counters, which could finalize a run early.
   *
   * A cell left `generating` by a crashed worker is deliberately NOT reclaimed
   * here — reclaiming on sight is exactly the double-execution this prevents.
   * Recovering those needs an age-gated sweep (see
   * `KbDocumentModel.recoverStalledEmbeddings` for the established pattern);
   * until then a stuck cell is recovered with the per-cell retry.
   */
  static async claimCellsForGeneration(params: {
    rowId: string;
    columnKeys: string[];
  }): Promise<string[]> {
    if (params.columnKeys.length === 0) return [];
    const claimed = await db
      .update(schema.batchAnalysisCellsTable)
      .set({ status: "generating", error: null })
      .where(
        and(
          eq(schema.batchAnalysisCellsTable.rowId, params.rowId),
          inArray(schema.batchAnalysisCellsTable.columnKey, params.columnKeys),
          inArray(schema.batchAnalysisCellsTable.status, ["pending", "error"]),
        ),
      )
      .returning({ columnKey: schema.batchAnalysisCellsTable.columnKey });
    return claimed.map((cell) => cell.columnKey);
  }

  static async writeCellResult(params: {
    rowId: string;
    columnKey: string;
    content: string;
    citations: BatchAnalysisCitation[] | null;
    flag: BatchAnalysisCellFlag | null;
  }): Promise<void> {
    await db
      .update(schema.batchAnalysisCellsTable)
      .set({
        status: "done",
        content: params.content,
        citations: params.citations,
        flag: params.flag,
        error: null,
        // A regenerated answer is a new answer; any human sign-off applied to
        // the previous one no longer holds.
        verifiedBy: null,
        verifiedAt: null,
      })
      .where(
        and(
          eq(schema.batchAnalysisCellsTable.rowId, params.rowId),
          eq(schema.batchAnalysisCellsTable.columnKey, params.columnKey),
        ),
      );
  }

  static async writeCellError(params: {
    rowId: string;
    columnKeys: string[];
    error: string;
  }): Promise<void> {
    if (params.columnKeys.length === 0) return;
    await db
      .update(schema.batchAnalysisCellsTable)
      .set({
        status: "error",
        error: params.error,
        flag: null,
        verifiedBy: null,
        verifiedAt: null,
      })
      .where(
        and(
          eq(schema.batchAnalysisCellsTable.rowId, params.rowId),
          inArray(schema.batchAnalysisCellsTable.columnKey, params.columnKeys),
        ),
      );
  }

  /**
   * Reset one cell to `pending` so it can be re-dispatched on its own. Returns
   * the owning row when the cell exists, since the caller needs it to enqueue.
   */
  static async resetCell(params: {
    rowId: string;
    columnKey: string;
  }): Promise<BatchAnalysisCell | null> {
    const [cell] = await db
      .update(schema.batchAnalysisCellsTable)
      // Derived state resets with the answer: a stale triage flag or human
      // sign-off must never survive into pending/generating.
      .set({
        status: "pending",
        error: null,
        flag: null,
        verifiedBy: null,
        verifiedAt: null,
      })
      .where(
        and(
          eq(schema.batchAnalysisCellsTable.rowId, params.rowId),
          eq(schema.batchAnalysisCellsTable.columnKey, params.columnKey),
        ),
      )
      .returning();
    return (cell as BatchAnalysisCell | undefined) ?? null;
  }

  // ===== Runs =====

  static async createRun(params: {
    analysisId: string;
    organizationId: string;
    totalRows: number;
    totalCells: number;
  }): Promise<BatchAnalysisRun> {
    const [run] = await db
      .insert(schema.batchAnalysisRunsTable)
      .values({
        analysisId: params.analysisId,
        organizationId: params.organizationId,
        status: "running",
        totalRows: params.totalRows,
        totalCells: params.totalCells,
        startedAt: new Date(),
      })
      .returning();
    return run as BatchAnalysisRun;
  }

  static async findRunById(runId: string): Promise<BatchAnalysisRun | null> {
    const [run] = await db
      .select()
      .from(schema.batchAnalysisRunsTable)
      .where(eq(schema.batchAnalysisRunsTable.id, runId));
    return (run as BatchAnalysisRun | undefined) ?? null;
  }

  static async findLatestRun(
    analysisId: string,
  ): Promise<BatchAnalysisRun | null> {
    const [run] = await db
      .select()
      .from(schema.batchAnalysisRunsTable)
      .where(eq(schema.batchAnalysisRunsTable.analysisId, analysisId))
      .orderBy(desc(schema.batchAnalysisRunsTable.startedAt))
      .limit(1);
    return (run as BatchAnalysisRun | undefined) ?? null;
  }

  static async findRunningRun(
    analysisId: string,
  ): Promise<BatchAnalysisRun | null> {
    const [run] = await db
      .select()
      .from(schema.batchAnalysisRunsTable)
      .where(
        and(
          eq(schema.batchAnalysisRunsTable.analysisId, analysisId),
          eq(schema.batchAnalysisRunsTable.status, "running"),
        ),
      );
    return (run as BatchAnalysisRun | undefined) ?? null;
  }

  /**
   * Record one row's completion and, when it is the last one, flip the run
   * terminal — in a single UPDATE.
   *
   * Doing this as read-then-write would race: two workers finishing the final
   * two rows could both observe `completedRows < totalRows` and neither would
   * finalize, leaving the run `running` forever. Every SET expression sees the
   * pre-update row, so this row's own counts are added explicitly inside the
   * status CASE.
   *
   * Guarded on `status = 'running'` so a cancelled run's stragglers cannot
   * resurrect it.
   */
  static async completeRow(params: {
    runId: string;
    doneCells: number;
    erroredCells: number;
  }): Promise<BatchAnalysisRun | null> {
    const t = schema.batchAnalysisRunsTable;
    const { doneCells, erroredCells } = params;
    const [run] = await db
      .update(t)
      .set({
        completedRows: sql`${t.completedRows} + 1`,
        doneCells: sql`${t.doneCells} + ${doneCells}`,
        erroredCells: sql`${t.erroredCells} + ${erroredCells}`,
        status: sql`CASE
          WHEN ${t.completedRows} + 1 >= ${t.totalRows} AND ${t.erroredCells} + ${erroredCells} > 0 THEN 'completed_with_errors'
          WHEN ${t.completedRows} + 1 >= ${t.totalRows} THEN 'success'
          ELSE ${t.status}
        END`,
        completedAt: sql`CASE WHEN ${t.completedRows} + 1 >= ${t.totalRows} THEN NOW() ELSE ${t.completedAt} END`,
      })
      .where(and(eq(t.id, params.runId), eq(t.status, "running")))
      .returning();
    return (run as BatchAnalysisRun | undefined) ?? null;
  }

  static async failRun(params: {
    runId: string;
    error: string;
  }): Promise<void> {
    const t = schema.batchAnalysisRunsTable;
    await db
      .update(t)
      .set({
        status: "failed",
        error: params.error,
        completedAt: new Date(),
      })
      .where(and(eq(t.id, params.runId), eq(t.status, "running")));
  }

  static async cancelRun(runId: string): Promise<BatchAnalysisRun | null> {
    const t = schema.batchAnalysisRunsTable;
    const [run] = await db
      .update(t)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(and(eq(t.id, runId), eq(t.status, "running")))
      .returning();
    return (run as BatchAnalysisRun | undefined) ?? null;
  }

  // ===== internal =====

  /**
   * WHERE fragment restricting a query to the analyses `viewer` may see.
   * `undefined` means "no restriction", which composes with `and(...)`.
   */
  private static visibleTo(viewer: BatchAnalysisViewer) {
    if (viewer.canReadAll) return undefined;

    const teamClause = viewer.teamIds.length
      ? and(
          eq(schema.batchAnalysesTable.scope, "team"),
          sql`EXISTS (
            SELECT 1 FROM ${schema.batchAnalysisTeamTable}
            WHERE ${schema.batchAnalysisTeamTable.batchAnalysisId} = ${schema.batchAnalysesTable.id}
              AND ${schema.batchAnalysisTeamTable.teamId} IN ${viewer.teamIds}
          )`,
        )
      : undefined;

    return or(
      eq(schema.batchAnalysesTable.scope, "org"),
      and(
        eq(schema.batchAnalysesTable.scope, "personal"),
        eq(schema.batchAnalysesTable.createdBy, viewer.userId),
      ),
      ...(teamClause ? [teamClause] : []),
    );
  }
}

export default BatchAnalysisModel;

/** Above this many verified cells the audit snapshot keeps only the digest. */
const VERIFICATION_AUDIT_MAP_LIMIT = 200;
