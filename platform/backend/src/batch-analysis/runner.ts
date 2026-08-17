import config from "@/config";
import logger from "@/logging";
import { BatchAnalysisModel } from "@/models";
import { taskQueueService } from "@/task-queue";
import { ApiError, type BatchAnalysisRun } from "@/types";

/**
 * Dispatch work for an analysis.
 *
 * Only rows with at least one not-`done` cell are dispatched, and within a row
 * only the unfinished columns are asked for. That single rule gives three
 * behaviours for free: a fresh run does everything, a resumed run does only what
 * is missing, and a single-cell retry does exactly one cell — no separate code
 * path for any of them.
 */
export async function startBatchAnalysisRun(params: {
  analysisId: string;
  organizationId: string;
}): Promise<BatchAnalysisRun> {
  const analysis = await BatchAnalysisModel.findById({
    analysisId: params.analysisId,
    organizationId: params.organizationId,
  });
  if (!analysis) {
    throw new ApiError(404, "Analysis not found");
  }
  if (analysis.columns.length === 0) {
    throw new ApiError(400, "Analysis has no columns");
  }

  // Single-flight: the partial unique index enforces this at the database, but
  // checking first turns a constraint violation into a clear error.
  const existing = await BatchAnalysisModel.findRunningRun(params.analysisId);
  if (existing) {
    throw new ApiError(409, "A run is already in progress for this analysis");
  }

  const rows = await BatchAnalysisModel.findRows(params.analysisId);
  if (rows.length === 0) {
    throw new ApiError(400, "Analysis has no rows");
  }
  if (rows.length > config.batchAnalysis.maxRowsPerAnalysis) {
    throw new ApiError(
      400,
      `Analysis exceeds the maximum of ${config.batchAnalysis.maxRowsPerAnalysis} rows`,
    );
  }

  const columnKeys = analysis.columns.map((column) => column.key);
  await BatchAnalysisModel.ensureCells({
    rowIds: rows.map((row) => row.id),
    columnKeys,
  });

  // Work out the outstanding set BEFORE creating the run, so the run's totals
  // describe what it will actually do rather than the size of the whole grid.
  const pendingByRow = new Map<string, number>();
  for (const row of rows) {
    const unfinished = await BatchAnalysisModel.findUnfinishedColumnKeys(
      row.id,
    );
    if (unfinished.length > 0) {
      pendingByRow.set(row.id, unfinished.length);
    }
  }

  const totalRows = pendingByRow.size;
  const totalCells = [...pendingByRow.values()].reduce(
    (sum, count) => sum + count,
    0,
  );

  const run = await BatchAnalysisModel.createRun({
    analysisId: params.analysisId,
    organizationId: params.organizationId,
    totalRows,
    totalCells,
  });

  if (totalRows === 0) {
    // Everything is already done. Recording a completed run is more honest than
    // refusing: "I ran it and there was nothing left to do" is a real answer.
    await BatchAnalysisModel.completeRow({
      runId: run.id,
      doneCells: 0,
      erroredCells: 0,
    });
    const settled = await BatchAnalysisModel.findRunById(run.id);
    return settled ?? run;
  }

  for (const rowId of pendingByRow.keys()) {
    await taskQueueService.enqueue({
      taskType: "batch_analysis_row",
      payload: { runId: run.id, rowId },
      // A row's own failures are recorded on its cells rather than thrown, so a
      // retry here only ever covers infrastructure faults. Few attempts is
      // right: repeatedly replaying a row means repeatedly paying for its
      // tokens.
      maxAttempts: 2,
    });
  }

  logger.info(
    { runId: run.id, analysisId: params.analysisId, totalRows, totalCells },
    "[BatchAnalysis] Run started",
  );

  return run;
}

/**
 * Reset a single cell and dispatch it. Implemented as "make the cell unfinished,
 * then start a run" so retry shares the resume path exactly — there is no second
 * notion of what needs doing.
 */
export async function retryBatchAnalysisCell(params: {
  analysisId: string;
  organizationId: string;
  rowId: string;
  columnKey: string;
}): Promise<BatchAnalysisRun> {
  const analysis = await BatchAnalysisModel.findById({
    analysisId: params.analysisId,
    organizationId: params.organizationId,
  });
  if (!analysis) {
    throw new ApiError(404, "Analysis not found");
  }

  const row = await BatchAnalysisModel.findRowById(params.rowId);
  if (!row || row.analysisId !== params.analysisId) {
    throw new ApiError(404, "Row not found on this analysis");
  }

  const cell = await BatchAnalysisModel.resetCell({
    rowId: params.rowId,
    columnKey: params.columnKey,
  });
  if (!cell) {
    throw new ApiError(404, "Cell not found");
  }

  return startBatchAnalysisRun({
    analysisId: params.analysisId,
    organizationId: params.organizationId,
  });
}
