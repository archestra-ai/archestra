import { executeRow } from "@/batch-analysis/executor";
import logger from "@/logging";
import { BatchAnalysisModel } from "@/models";

/**
 * Process one row of a batch analysis run.
 *
 * The contract with the queue is deliberate: expected failures (an unreadable
 * source, a model that returned nothing usable) are written onto the cells and
 * the task SUCCEEDS, so the run's completion counter always advances and the run
 * always reaches a terminal state. Only genuine infrastructure faults are
 * allowed to throw, because those are the only ones a retry can fix.
 *
 * The alternative — throwing on model failures — is what leaves runs stuck
 * `running` forever once a task exhausts its attempts, since the parent's
 * denominator is never reached.
 */
export async function handleBatchAnalysisRow(
  payload: Record<string, unknown>,
): Promise<void> {
  const runId = payload.runId as string;
  const rowId = payload.rowId as string;

  if (!runId || !rowId) {
    throw new Error("Missing runId or rowId in batch_analysis_row payload");
  }

  const run = await BatchAnalysisModel.findRunById(runId);
  if (!run) {
    logger.warn({ runId, rowId }, "[BatchAnalysis] Run no longer exists");
    return;
  }
  if (run.status !== "running") {
    // Cancelled or already terminal — drop the work instead of writing cells
    // that nobody is waiting for and that would contradict the run's counters.
    logger.info(
      { runId, rowId, status: run.status },
      "[BatchAnalysis] Skipping row for a run that is no longer running",
    );
    return;
  }

  const [analysis, row] = await Promise.all([
    BatchAnalysisModel.findById({
      analysisId: run.analysisId,
      organizationId: run.organizationId,
    }),
    BatchAnalysisModel.findRowById(rowId),
  ]);

  if (!analysis || !row) {
    logger.warn(
      { runId, rowId },
      "[BatchAnalysis] Analysis or row disappeared mid-run",
    );
    await BatchAnalysisModel.completeRow({
      runId,
      doneCells: 0,
      erroredCells: 0,
    });
    return;
  }

  // Claim rather than read-then-write: the payload's cell set may be stale, and
  // a single conditional UPDATE is what keeps a duplicate delivery from having
  // two workers generate — and bill for — the same cells. Only the cells this
  // worker actually won are generated; anything already finished or in flight
  // elsewhere is simply absent from the claim.
  const claimedKeys = new Set(
    await BatchAnalysisModel.claimCellsForGeneration({
      rowId,
      columnKeys: analysis.columns.map((column) => column.key),
    }),
  );
  const columns = analysis.columns.filter((column) =>
    claimedKeys.has(column.key),
  );

  if (columns.length === 0) {
    await BatchAnalysisModel.completeRow({
      runId,
      doneCells: 0,
      erroredCells: 0,
    });
    return;
  }

  const { outcomes } = await executeRow({ analysis, row, columns });

  let doneCells = 0;
  const failures = new Map<string, string[]>();

  for (const outcome of outcomes) {
    if (outcome.ok) {
      await BatchAnalysisModel.writeCellResult({
        rowId,
        columnKey: outcome.columnKey,
        content: outcome.content,
        citations: outcome.citations,
        flag: outcome.flag,
      });
      doneCells += 1;
    } else {
      // Group identical errors so a whole-row failure is one UPDATE rather than
      // one per column.
      const keys = failures.get(outcome.error) ?? [];
      keys.push(outcome.columnKey);
      failures.set(outcome.error, keys);
    }
  }

  let erroredCells = 0;
  for (const [error, columnKeys] of failures) {
    await BatchAnalysisModel.writeCellError({ rowId, columnKeys, error });
    erroredCells += columnKeys.length;
  }

  const updated = await BatchAnalysisModel.completeRow({
    runId,
    doneCells,
    erroredCells,
  });

  if (updated && updated.completedRows >= updated.totalRows) {
    logger.info(
      {
        runId,
        analysisId: analysis.id,
        status: updated.status,
        doneCells: updated.doneCells,
        erroredCells: updated.erroredCells,
      },
      "[BatchAnalysis] Run finalized",
    );
  }
}
