import { embeddingService } from "@/knowledge-base";
import { ConnectorRunModel } from "@/models";
import * as metrics from "@/observability/metrics";
import type { TaskHandlerContext } from "@/types";
import { finalizeConnectorAfterEmbeddingDrain } from "./batch-embedding-finalizer";

export async function handleBatchEmbedding(
  payload: Record<string, unknown>,
  context?: TaskHandlerContext,
): Promise<void> {
  const documentIds = payload.documentIds as string[];
  const connectorRunId = (payload.connectorRunId as string | null) ?? null;

  if (!documentIds?.length) {
    throw new Error("Missing documentIds in batch_embedding payload");
  }

  // The run's lease is intentionally NOT renewed here. During the drain phase the
  // liveness signal is the existence of pending/processing batch_embedding tasks,
  // not the lease — the reaper (reapExpiredRuns) skips any run that still has
  // embedding work queued. A lease renewal here would only cover batches being
  // *processed*, not ones still queued behind a backlog, so it can't stand in for
  // that check; the task-existence signal is what keeps a slow drain alive.

  let outcome: Awaited<ReturnType<typeof embeddingService.processDocuments>>;
  try {
    outcome = await embeddingService.processDocuments(
      documentIds,
      connectorRunId ?? undefined,
    );
    metrics.rag.reportEmbeddingBatch({
      documentCount: documentIds.length,
      status: outcome.failedDocumentCount > 0 ? "error" : "success",
    });
  } catch (error) {
    // processDocuments records per-document failures itself; a throw here is an
    // unexpected fault (e.g. the database is down) — let the task queue retry it.
    metrics.rag.reportEmbeddingBatch({
      documentCount: documentIds.length,
      status: "error",
    });
    throw error;
  }

  if (!connectorRunId) {
    return;
  }

  // Record any embedding failures — and skipped image chunks — on the connector
  // run atomically with the batch completion, so the cause is visible in the run
  // (not just the logs).
  const hasFailure = outcome.failedDocumentCount > 0;
  const hasSkips = outcome.skippedImageChunkCount > 0;
  const updatedRun = await ConnectorRunModel.completeBatch(
    connectorRunId,
    hasFailure || hasSkips
      ? {
          ...(hasFailure
            ? {
                failedItems: outcome.failedDocumentCount,
                error: outcome.errorMessage ?? "Embedding failed",
              }
            : {}),
          ...(hasSkips ? { skippedItems: outcome.skippedImageChunkCount } : {}),
        }
      : undefined,
    context?.taskId,
  );

  await finalizeConnectorAfterEmbeddingDrain(updatedRun);
}
