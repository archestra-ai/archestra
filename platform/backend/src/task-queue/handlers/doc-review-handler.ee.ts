// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { executeReviewCell } from "@/knowledge-base/doc-review-runner.ee";
import logger from "@/logging";
import { DocReviewModel, KbDocumentModel } from "@/models";
import type { TaskHandlerContext } from "@/types";

const BATCH_SIZE = 5;

export async function handleDocReviewRun(
  payload: Record<string, unknown>,
  _context?: TaskHandlerContext,
): Promise<void> {
  const reviewId = payload.reviewId as string;
  if (!reviewId) {
    throw new Error("Missing reviewId in doc_review_run payload");
  }

  const rowIds = await DocReviewModel.findPendingCellRows(reviewId);
  if (rowIds.length === 0) {
    logger.info({ reviewId }, "[DocReviewHandler] No pending rows for review run");
    return;
  }

  // Import task queue service dynamically or pass task enqueuing
  const { taskQueueService } = await import("@/task-queue");

  // Chunk rowIds into batch tasks
  for (let i = 0; i < rowIds.length; i += BATCH_SIZE) {
    const chunk = rowIds.slice(i, i + BATCH_SIZE);
    await taskQueueService.enqueue({
      taskType: "doc_review_batch",
      payload: {
        reviewId,
        rowIds: chunk,
      },
    });
  }

  logger.info(
    { reviewId, totalRows: rowIds.length, batches: Math.ceil(rowIds.length / BATCH_SIZE) },
    "[DocReviewHandler] Enqueued doc_review_batch tasks",
  );
}

export async function handleDocReviewBatch(
  payload: Record<string, unknown>,
  _context?: TaskHandlerContext,
): Promise<void> {
  const reviewId = payload.reviewId as string;
  const rowIds = payload.rowIds as string[];

  if (!reviewId || !rowIds?.length) {
    throw new Error("Missing reviewId or rowIds in doc_review_batch payload");
  }

  for (const rowId of rowIds) {
    const cells = await DocReviewModel.findCellsByRow(rowId);
    if (!cells.length) continue;

    for (const cell of cells) {
      if (cell.status === "completed") continue; // Skip completed cells! Resumability!

      try {
        const doc = await KbDocumentModel.findById(cell.documentId);
        if (!doc) {
          await DocReviewModel.failCell(cell.id, "Document not found");
          continue;
        }

        // Find matching column definition from review columns
        const [gridData] = await Promise.all([
          DocReviewModel.findGrid(reviewId, doc.organizationId),
        ]);

        const column = gridData?.columns.find((c) => c.id === cell.columnId);
        if (!column) {
          await DocReviewModel.failCell(cell.id, `Column ${cell.columnId} not found`);
          continue;
        }

        const result = await executeReviewCell({
          organizationId: doc.organizationId,
          document: doc,
          column,
        });

        await DocReviewModel.completeCell(cell.id, {
          value: result.value,
          citations: result.citations,
          tokensUsed: result.tokensUsed,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(
          { cellId: cell.id, error: msg },
          "[DocReviewHandler] Cell execution failed",
        );
        await DocReviewModel.failCell(cell.id, msg);
      }
    }
  }
}
