import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ModelInputModality, TextSearchLanguage } from "@archestra/shared";
import type pino from "pino";
import config from "@/config";
import defaultLogger from "@/logging";
import {
  ConnectorRunModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import * as metrics from "@/observability/metrics";
import { taskQueueService } from "@/task-queue";
import type {
  AclEntry,
  ConnectorDocument,
  ConnectorRun,
  ConnectorSyncStatus,
  KnowledgeBaseConnector,
} from "@/types";
import { chunkAndStoreDocument } from "./chunk-and-store";
import { resolveConnectorCredentials } from "./connector-credentials";
import {
  BaseConnector,
  extractErrorMessage,
} from "./connectors/base-connector";
import { getConnector } from "./connectors/registry";
import { toKnowledgeBaseUserMessage } from "./errors";
import { resolveEmbeddingConfig, resolveOcrConfig } from "./kb-llm-client";
import { OCR_RUN_PAGE_BUDGET } from "./pdf-ocr";
import { enqueuePermissionSyncAfterContentSync } from "./permission-sync-trigger";
import { knowledgeRetrievalBackend } from "./retrieval-backends/registry";
import { knowledgeSourceAccessControlService } from "./source-access-control";

/**
 * Identity of this worker process, used as the connector-run lease owner. The
 * fencing epoch (not this string) is what enforces correctness; the owner is a
 * human-readable tie-breaker and heartbeat guard.
 */
const WORKER_ID = `${hostname()}#${process.pid}`;

/**
 * Fixed-memory membership filter for successful source ids reported after a
 * connector's exact dedupe set has reached its own safety ceiling. It is lazy
 * (ordinary runs allocate nothing), has no false negatives, and uses 32 MiB
 * regardless of how many overflow sources a huge domain produces. A
 * cryptographic digest plus twelve probes keeps false positives negligible for
 * millions of overflow ids without rebuilding an unbounded Set.
 */
class RecoveredSourceFilter {
  private static readonly BYTE_COUNT = 32 * 1024 * 1024;
  private static readonly BIT_MASK = RecoveredSourceFilter.BYTE_COUNT * 8 - 1;
  private static readonly HASH_COUNT = 12;

  private readonly bits = new Uint8Array(RecoveredSourceFilter.BYTE_COUNT);

  add(sourceId: string): void {
    const digest = createHash("sha256").update(sourceId).digest();
    let hash = digest.readUInt32LE(0);
    const step = digest.readUInt32LE(4) | 1;
    for (let i = 0; i < RecoveredSourceFilter.HASH_COUNT; i++) {
      const bitIndex = hash & RecoveredSourceFilter.BIT_MASK;
      this.bits[bitIndex >>> 3] |= 1 << (bitIndex & 7);
      hash = (hash + step) >>> 0;
    }
  }

  has(sourceId: string): boolean {
    const digest = createHash("sha256").update(sourceId).digest();
    let hash = digest.readUInt32LE(0);
    const step = digest.readUInt32LE(4) | 1;
    for (let i = 0; i < RecoveredSourceFilter.HASH_COUNT; i++) {
      const bitIndex = hash & RecoveredSourceFilter.BIT_MASK;
      if ((this.bits[bitIndex >>> 3] & (1 << (bitIndex & 7))) === 0) {
        return false;
      }
      hash = (hash + step) >>> 0;
    }
    return true;
  }
}

/**
 * Service that orchestrates the sync of data from external connectors
 * (e.g., Jira, Confluence) into kb_documents.
 *
 * Documents are stored once per connector. The knowledge_base_connector_assignment
 * junction table resolves which KBs a document belongs to.
 */
class ConnectorSyncService {
  async executeSync(
    connectorId: string,
    options?: {
      logger?: pino.Logger;
      getLogOutput?: () => string;
      maxDurationMs?: number;
    },
  ): Promise<{ runId: string; status: string }> {
    const log = options?.logger ?? defaultLogger;

    const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
    if (!connector) {
      throw new Error(`Connector not found: ${connectorId}`);
    }

    // Single-flight: claim the connector's one running-run slot and take a
    // liveness lease. If another worker holds a live lease we skip — no second
    // execution runs concurrently. A run whose lease has expired (crashed/hung
    // owner) is reclaimed inside claim() before we take over.
    const leaseTtlSeconds = config.kb.connectorRunLeaseTtlSeconds;
    const claim = await ConnectorRunModel.claim({
      connectorId,
      owner: WORKER_ID,
      leaseTtlSeconds,
    });
    if (claim.outcome === "busy") {
      log.info(
        { connectorId },
        "A sync is already running for this connector; skipping duplicate run",
      );
      return { runId: "", status: "skipped" };
    }

    const run = claim.run;
    const epoch = run.leaseEpoch;

    const runLog = log.child({
      runId: run.id,
      connectorId,
      connectorName: connector.name,
      connectorType: connector.connectorType,
    });

    // Heartbeat: renew the lease across the whole ingest phase so the reaper
    // never mistakes this live run for an orphan. Renewal is fenced by owner +
    // epoch; a `false` result means we were reclaimed.
    //
    // Invariant: the heartbeat interval must stay well under the lease TTL
    // (defaults 90s interval / 300s TTL, ~3.3x) so that a couple of missed
    // beats — a GC pause or a slow batch — don't expire a live run. The sync
    // also yields to the event loop between batches, so a CPU-heavy batch can't
    // starve this timer for long. claim() already seeded the lease to now()+TTL,
    // but we fire one beat immediately so the lease is refreshed from the moment
    // ingest begins rather than only after the first interval elapses.
    const beat = () => {
      ConnectorRunModel.renewLease({
        runId: run.id,
        owner: WORKER_ID,
        epoch,
        leaseTtlSeconds,
      })
        .then((held) => {
          if (!held) runLog.warn("Connector run lease lost during heartbeat");
        })
        .catch((error) => {
          runLog.warn(
            { error: extractErrorMessage(error) },
            "Connector run heartbeat failed",
          );
        });
    };
    beat();
    const heartbeat = setInterval(
      beat,
      config.kb.connectorRunHeartbeatIntervalSeconds * 1000,
    );
    // `.unref()` so the timer can't keep the process alive on its own.
    heartbeat.unref();

    try {
      return await this.runClaimedSync({
        connector,
        run,
        epoch,
        runLog,
        options,
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async runClaimedSync(params: {
    connector: KnowledgeBaseConnector;
    run: ConnectorRun;
    epoch: number;
    runLog: pino.Logger;
    options?: {
      getLogOutput?: () => string;
      maxDurationMs?: number;
    };
  }): Promise<{ runId: string; status: string }> {
    const { connector, run, epoch, runLog, options } = params;
    const connectorId = connector.id;

    // Load credentials from secrets manager. The document ACL is intentionally
    // NOT computed once here: visibility/teamIds can change after a run starts,
    // and no ACL writer may trust a start-of-run snapshot. The current ownership
    // rule is re-read from the connector row at each batch boundary (ACL-write
    // time) — see the batch loop below.
    // Resolving credentials can fail on its own (a missing secret, a Google
    // OAuth client that was rotated out from under the connector). That has to
    // land on the run row: it already exists, so an escaping throw would leave
    // it "running" until the lease reaper collects it, with nothing saying why.
    let credentials: Awaited<ReturnType<typeof resolveConnectorCredentials>>;
    try {
      credentials = await resolveConnectorCredentials(connector);
    } catch (error) {
      const message = extractErrorMessage(error);
      runLog.error(
        { error: message },
        "Could not resolve connector credentials",
      );
      await ConnectorRunModel.updateIfOwned({
        runId: run.id,
        epoch,
        data: {
          status: "failed",
          completedAt: new Date(),
          error: message,
          logs: options?.getLogOutput?.() ?? null,
        },
      });
      await KnowledgeBaseConnectorModel.update(connectorId, {
        lastSyncStatus: "failed",
        lastSyncError: message,
      });
      return { runId: run.id, status: "failed" };
    }

    // Get the connector implementation
    const connectorImpl = getConnector(connector.connectorType);
    if (connectorImpl instanceof BaseConnector) {
      connectorImpl.setLogger(runLog);
    }

    // Mark the connector running. lastSyncAt is set to the run's own startedAt
    // (not a fresh Date) so the finalization guard `connector.lastSyncAt >
    // run.startedAt` only fires for a genuinely newer run — not this run's own
    // optimistic write, which previously left the connector stuck "running"
    // after slow syncs.
    await KnowledgeBaseConnectorModel.update(connectorId, {
      lastSyncStatus: "running",
      lastSyncAt: run.startedAt,
    });

    let documentsProcessed = 0;
    let documentsIngested = 0;
    let itemErrors = 0;
    let itemsSkipped = 0;
    let documentsWithoutText = 0;
    let unsupportedItemsSkipped = 0;
    // Item counters are written as deltas (`increments`), never absolute:
    // batch-embedding handlers add their own failures/skips to the same run
    // columns concurrently via `completeBatch`, and an absolute SET here would
    // erase those. These markers track what this loop has already flushed.
    let flushedItemErrors = 0;
    let flushedItemsSkipped = 0;
    // Per-item fetch fallbacks. Optional sub-resource failures stay warnings;
    // a fallback that omits the top-level document increments itemErrors so a
    // modified source that was not refreshed cannot leave a green run.
    let itemFetchFailures = 0;
    // A domain-wide connector can fail to fetch a source through one identity
    // and then recover it through another. Defer those unavailable-item counts
    // until the generator closes, removing ids that later produce a document.
    const provisionalUnavailableSourceIds = new Set<string>();
    // Normally a connector's own dedupe prevents success-before-failure for a
    // source. A connector that has degraded that guarantee can explicitly
    // report successful source ids so reconciliation remains order-independent.
    let recoveredUnavailableSourceIds: RecoveredSourceFilter | undefined;
    let batchCount = 0;
    const startTime = Date.now();
    let stoppedEarly = false;

    // Resolve the embedding model's supported input modalities (and accepted
    // image formats) so connectors can conditionally ingest non-text content.
    // Must happen before estimateTotalItems so the estimate matches sync behavior.
    let embeddingInputModalities: ModelInputModality[] | undefined;
    let embeddingAcceptedImageMimeTypes: string[] | undefined;
    try {
      const embeddingConfig = await resolveEmbeddingConfig(
        connector.organizationId,
      );
      embeddingInputModalities = embeddingConfig?.inputModalities ?? undefined;
      embeddingAcceptedImageMimeTypes =
        embeddingConfig?.acceptedImageMimeTypes ?? undefined;
    } catch {
      // Non-fatal: proceed without modality info
    }

    // Arm OCR for the run when the organization has it configured. Resolved
    // once here — not per document — and degraded to "sync without OCR" on
    // any resolution fault: OCR is an optional enhancement and must never
    // fail a sync that would have succeeded without it. The deadline aligns
    // with the sync's own 90%-of-budget early stop so page transcription can
    // never push a run past its wall-clock budget.
    try {
      const ocrConfig = await resolveOcrConfig(connector.organizationId);
      if (ocrConfig && connectorImpl instanceof BaseConnector) {
        const budgetMs =
          options?.maxDurationMs ??
          (config.kb.connectorSyncMaxDurationSeconds
            ? config.kb.connectorSyncMaxDurationSeconds * 1000
            : undefined);
        connectorImpl.setOcrContext({
          config: ocrConfig,
          connectorId: connector.id,
          // No wall-clock budget on the run means no OCR deadline either.
          deadlineAt: budgetMs
            ? startTime + budgetMs * 0.9
            : Number.POSITIVE_INFINITY,
          budget: { remainingPages: OCR_RUN_PAGE_BUDGET },
          log: runLog,
          connectorType: connector.connectorType,
        });
        runLog.info(
          { model: ocrConfig.modelName, provider: ocrConfig.provider },
          "OCR armed: textless PDF pages will be transcribed",
        );
      }
    } catch (error) {
      runLog.warn(
        // Prefer the taxonomy's actionable message ("provider X cannot accept
        // PDF input…") over the generic Error message when one exists.
        {
          error:
            toKnowledgeBaseUserMessage(error) ?? extractErrorMessage(error),
        },
        "OCR is configured but unusable — syncing without it",
      );
    }

    // Estimate total items for progress display
    try {
      const totalItems = await connectorImpl.estimateTotalItems({
        config: connector.config as Record<string, unknown>,
        credentials,
        checkpoint: connector.checkpoint as Record<string, unknown> | null,
        embeddingInputModalities,
        embeddingAcceptedImageMimeTypes,
      });

      if (totalItems !== null && totalItems > 0) {
        await ConnectorRunModel.updateIfOwned({
          runId: run.id,
          epoch,
          data: { totalItems },
        });
        runLog.info({ totalItems }, "Estimated total items");
      }
    } catch (error) {
      runLog.warn(
        {
          error: extractErrorMessage(error),
        },
        "Failed to estimate total items, continuing without",
      );
    }

    try {
      const syncGenerator = connectorImpl.sync({
        config: connector.config as Record<string, unknown>,
        credentials,
        checkpoint: connector.checkpoint as Record<string, unknown> | null,
        embeddingInputModalities,
        embeddingAcceptedImageMimeTypes,
      });

      for await (const batch of syncGenerator) {
        // Fence the payload writes and refresh the lease at each batch boundary.
        // renewLease is owner+epoch fenced: a `false` result means we were
        // reclaimed, so we stop BEFORE writing this batch's kb_documents/kb_chunks
        // — a zombie owner can't keep touching rows a newer run now owns (the
        // payload writes are now fenced at the same batch granularity as the
        // bookkeeping). Renewing here — synchronously, coupled to actual work —
        // also means a slow batch's liveness doesn't hinge on the heartbeat timer
        // alone, which a CPU-blocked event loop starves: every batch starts with a
        // full lease TTL of headroom. (A single batch that blocks longer than the
        // TTL can still be reclaimed — inherent to a lease-based scheme.)
        const stillHeld = await ConnectorRunModel.renewLease({
          runId: run.id,
          owner: WORKER_ID,
          epoch,
          leaseTtlSeconds: config.kb.connectorRunLeaseTtlSeconds,
        });
        if (!stillHeld) {
          runLog.info(
            { documentsProcessed, documentsIngested },
            "Run lease lost (reclaimed); stopping before ingesting the next batch",
          );
          return { runId: run.id, status: "superseded" };
        }

        // Re-read the connector's CURRENT visibility/teamIds at ACL-write time.
        // A visibility/teamIds change after the run started must take effect for
        // THIS batch's writes rather than a stale start-of-run snapshot; the row
        // is the source of truth and its `aclConfigEpoch` is bumped on any such
        // change. Ownership is applied per the current mode: content-sync authors
        // org-wide/team-scoped ACLs, while the permission-sync pass owns auto-sync
        // ACLs (content-sync becomes a no-op author for them). This closes the
        // TOCTOU window to at most one batch.
        // A null re-read means the connector was deleted mid-run (findById is
        // notDeleted-filtered). Stop before writing this batch rather than
        // falling back to the start-of-run snapshot: the delete path already
        // failed our lease, and this closes the same window for a delete that
        // lands between the renewal above and these writes.
        const currentConnector =
          await KnowledgeBaseConnectorModel.findById(connectorId);
        if (!currentConnector) {
          runLog.info(
            { documentsProcessed, documentsIngested },
            "Connector was deleted mid-run; stopping before ingesting the next batch",
          );
          return { runId: run.id, status: "superseded" };
        }
        const documentAcl =
          this.buildDocumentAccessControlList(currentConnector);
        const isAutoSync =
          currentConnector.visibility === "auto-sync-permissions";

        const ingestedDocumentIds: string[] = [];
        const failedSourceIds = new Set<string>();
        for (const doc of batch.documents) {
          documentsProcessed++;
          try {
            const result = await this.ingestDocument({
              doc,
              connectorId,
              connectorType: connector.connectorType,
              organizationId: connector.organizationId,
              ftsLanguage: connector.ftsLanguage,
              acl: documentAcl,
              // Auto-sync connectors: the permission-sync pass owns per-doc ACLs.
              // New and changed source revisions are locked fail-closed until
              // that pass evaluates the matching upstream revision.
              isAutoSync,
              log: runLog,
            });
            if (result.ingested) {
              documentsIngested++;
            }
            if (result.ingested && result.documentId) {
              ingestedDocumentIds.push(result.documentId);
            }
          } catch (docError) {
            itemErrors++;
            failedSourceIds.add(doc.id);
            runLog.warn(
              {
                documentId: doc.id,
                error: extractErrorMessage(docError),
              },
              "Failed to ingest document",
            );
          }
        }

        // Enqueue embedding as a separate task
        if (ingestedDocumentIds.length > 0) {
          batchCount++;
          await taskQueueService.enqueue({
            taskType: "batch_embedding",
            payload: {
              documentIds: ingestedDocumentIds,
              connectorRunId: run.id,
            },
          });
        }

        // A scoped reconciliation is authoritative only when every current
        // source id in that scope was durably ingested/enqueued. Advancing the
        // cursor after a failed item and then deleting against a partial seen
        // set would turn a transient extraction/database failure into data
        // loss. Throw before reconciliation/checkpoint so the source page is
        // replayed at least once.
        for (const scope of batch.reconcileScopes ?? []) {
          const failed = scope.seenSourceIds.find((sourceId) =>
            failedSourceIds.has(sourceId),
          );
          if (failed) {
            throw new Error(
              `Cannot reconcile source scope after failed document ${failed}`,
            );
          }
          await KbDocumentModel.deleteMissingFromMetadataScope({
            connectorId,
            metadataFilter: scope.metadataFilter,
            seenSourceIds: scope.seenSourceIds,
          });
        }
        if (batch.completionSweep) {
          await KbDocumentModel.deleteOutsideMetadataGeneration({
            connectorId,
            metadataKey: batch.completionSweep.metadataKey,
            generation: batch.completionSweep.generation,
          });
        }

        // safeItemFetch can represent either a degraded optional sub-resource
        // or a top-level item that could not be produced. Only the latter is
        // an item error; both remain in the failure total used by empty-run
        // diagnosis and retain the last-known-good indexed document.
        if (batch.failures?.length) {
          let unavailableItems = 0;
          let provisionalUnavailableItems = 0;
          for (const failure of batch.failures) {
            if (failure.itemUnavailable && failure.recoverySourceId) {
              if (
                !recoveredUnavailableSourceIds?.has(failure.recoverySourceId)
              ) {
                provisionalUnavailableSourceIds.add(failure.recoverySourceId);
              }
              provisionalUnavailableItems++;
              continue;
            }
            itemFetchFailures++;
            if (failure.itemUnavailable) {
              unavailableItems++;
            }
          }
          itemErrors += unavailableItems;
          documentsProcessed += unavailableItems;
          runLog.warn(
            {
              failures: batch.failures.length,
              unavailableItems,
              provisionalUnavailableItems,
            },
            unavailableItems > 0 || provisionalUnavailableItems > 0
              ? "Batch completed with unavailable items (see item warnings above)"
              : "Batch completed with sub-resource fallbacks (see item warnings above)",
          );
        }
        for (const doc of batch.documents) {
          provisionalUnavailableSourceIds.delete(doc.id);
        }
        for (const skipped of batch.skipped ?? []) {
          provisionalUnavailableSourceIds.delete(
            skipped.sourceId ?? String(skipped.itemId),
          );
        }
        for (const sourceId of batch.recoveredSourceIds ?? []) {
          recoveredUnavailableSourceIds ??= new RecoveredSourceFilter();
          recoveredUnavailableSourceIds.add(sourceId);
          provisionalUnavailableSourceIds.delete(sourceId);
        }

        // Track skipped items from this batch. Items the connector found but
        // could not extract any text from (scanned PDFs without a text layer,
        // unparseable files) are counted separately and logged at warn with
        // the document's name — otherwise they'd look successfully indexed
        // while never being searchable (issue #7157).
        if (batch.skipped?.length) {
          itemsSkipped += batch.skipped.length;
          documentsProcessed += batch.skipped.length;
          const noTextRetirementTargets = batch.skipped
            .filter((item) => item.category === "no_extractable_text")
            .map((item) => ({
              sourceId: item.sourceId ?? String(item.itemId),
              sourceScope: item.sourceScope,
            }));
          const removedStaleDocuments =
            await KbDocumentModel.deleteByConnectorAndSources({
              connectorId,
              targets: noTextRetirementTargets,
            });
          if (removedStaleDocuments > 0) {
            runLog.info(
              { removedStaleDocuments },
              "Retired stale indexed documents for definitive no-text skips",
            );
          }
          for (const s of batch.skipped) {
            if (s.category === "no_extractable_text") {
              documentsWithoutText++;
              // A source can change from a readable document to a scanned,
              // empty, or unparseable version without changing its external
              // ID. Retire the last indexed copy so stale text and chunks do
              // not remain searchable after this definitive skip.
              const sourceId = s.sourceId ?? String(s.itemId);
              runLog.warn(
                {
                  itemId: s.itemId,
                  sourceId,
                  name: s.name,
                  reason: s.reason,
                },
                "Document yielded no extractable text and was not indexed",
              );
            } else if (s.category === "unsupported_type") {
              unsupportedItemsSkipped++;
              runLog.debug(
                { itemId: s.itemId, name: s.name, reason: s.reason },
                "Unsupported item type skipped",
              );
            } else {
              runLog.debug(
                { itemId: s.itemId, name: s.name, reason: s.reason },
                "Item skipped",
              );
            }
          }
        }

        // Update run progress + flush logs after each batch, fenced by the
        // lease epoch. A null result means we were reclaimed (lease expired /
        // superseded), so stop cooperatively rather than resurrecting a dead
        // run or clobbering the connector checkpoint a newer run now owns.
        const stillOwned = await ConnectorRunModel.updateIfOwned({
          runId: run.id,
          epoch,
          data: {
            documentsProcessed,
            documentsIngested,
            documentsWithoutText,
            logs: options?.getLogOutput?.() ?? null,
          },
          increments: {
            itemErrors: itemErrors - flushedItemErrors,
            itemsSkipped: itemsSkipped - flushedItemsSkipped,
          },
        });
        if (stillOwned) {
          flushedItemErrors = itemErrors;
          flushedItemsSkipped = itemsSkipped;
        }

        if (!stillOwned) {
          runLog.info(
            { documentsProcessed, documentsIngested },
            "Run lease lost (reclaimed); stopping sync",
          );
          return { runId: run.id, status: "superseded" };
        }

        // Advance the connector checkpoint, gated atomically on this run still
        // being active so a reclaimed zombie owner cannot regress it.
        await KnowledgeBaseConnectorModel.setCheckpointIfRunActive({
          connectorId,
          runId: run.id,
          checkpoint: batch.checkpoint,
        });

        // Yield so the heartbeat timer (and other tasks) get to run between
        // batches even when a batch did CPU-heavy chunking with few awaits.
        await yieldToEventLoop();

        // Check time budget: stop early if we've used 90% of maxDurationMs and there's more data
        if (options?.maxDurationMs && batch.hasMore) {
          const elapsed = Date.now() - startTime;
          if (elapsed > options.maxDurationMs * 0.9) {
            stoppedEarly = true;
            runLog.info(
              {
                elapsedMs: elapsed,
                maxDurationMs: options.maxDurationMs,
                documentsProcessed,
              },
              "Time budget exceeded, stopping early for continuation",
            );
            break;
          }
        }
      }

      // Count only provisional failures that no later identity recovered.
      // Set semantics also ensure repeated failed attempts for one source are
      // reported as one unavailable item, not one error per viewer.
      const unresolvedUnavailableItems = provisionalUnavailableSourceIds.size;
      itemErrors += unresolvedUnavailableItems;
      documentsProcessed += unresolvedUnavailableItems;
      itemFetchFailures += unresolvedUnavailableItems;
      if (stoppedEarly) {
        // Publish the terminal partial status and the batch fence atomically.
        // Otherwise the last embedding task can finalize the run as success in
        // between those writes, losing progress and starting the continuation
        // from the wrong terminal state.
        const updated = await ConnectorRunModel.updateIfOwned({
          runId: run.id,
          epoch,
          data: {
            status: "partial",
            completedAt: new Date(),
            totalBatches: batchCount,
            documentsProcessed,
            documentsIngested,
            documentsWithoutText,
            logs: options?.getLogOutput?.() ?? null,
          },
          increments: {
            itemErrors: itemErrors - flushedItemErrors,
            itemsSkipped: itemsSkipped - flushedItemsSkipped,
          },
        });

        if (!updated) {
          return { runId: run.id, status: "superseded" };
        }
        await KnowledgeBaseConnectorModel.update(connectorId, {
          lastSyncStatus: "partial",
          lastSyncError: null,
        });

        const durationSeconds = (Date.now() - startTime) / 1000;
        metrics.rag.reportConnectorSync({
          connectorType: connector.connectorType,
          status: "partial",
          durationSeconds,
          documentsProcessed,
          documentsIngested,
          documentsWithoutText,
        });

        runLog.info(
          { documentsProcessed, documentsIngested },
          "Partial sync completed, continuation needed",
        );

        return { runId: run.id, status: "partial" };
      }

      if (batchCount === 0) {
        // No documents ingested — finalize immediately.
        const now = new Date();

        // An incremental run that finds nothing new is the normal steady
        // state and stays green. A run that indexes nothing when the
        // connector holds nothing either is the misconfiguration signature:
        // the identity cannot see the content, or a filter excludes all of
        // it. Reporting that as plain success is how a connector goes weeks
        // indexing nothing with a green tick beside it.
        const emptyConnector =
          itemErrors === 0 &&
          (await KbDocumentModel.countByConnector(connectorId)) === 0;
        const finalStatus: ConnectorSyncStatus =
          itemErrors > 0
            ? "completed_with_errors"
            : emptyConnector
              ? "no_documents"
              : "success";
        const diagnosis = emptyConnector
          ? describeEmptySync({
              itemsSkipped,
              documentsProcessed,
              itemFetchFailures,
              documentsWithoutText,
              unsupportedItemsSkipped,
            })
          : null;

        const updated = await ConnectorRunModel.updateIfOwned({
          runId: run.id,
          epoch,
          data: {
            status: finalStatus,
            completedAt: now,
            totalBatches: 0,
            documentsProcessed,
            documentsIngested,
            documentsWithoutText,
            error: diagnosis,
            logs: options?.getLogOutput?.() ?? null,
          },
          increments: {
            itemErrors: itemErrors - flushedItemErrors,
            itemsSkipped: itemsSkipped - flushedItemsSkipped,
          },
        });

        if (updated) {
          if (diagnosis) {
            runLog.warn(
              { itemsSkipped, documentsProcessed, itemFetchFailures },
              diagnosis,
            );
          }
          await KnowledgeBaseConnectorModel.update(connectorId, {
            lastSyncStatus: finalStatus,
            lastSyncAt: now,
            lastSyncError: diagnosis,
          });
          // Even an ingest-free sync triggers a (deduped, cheap-delta)
          // permission pass: it may follow an interrupted run whose own
          // trigger was lost, and in follow-documents mode it is the only
          // automatic pass.
          await enqueuePermissionSyncAfterContentSync({
            connector,
            documentsIngested,
          });
        }
      } else {
        // Publish progress and totalBatches in one fenced write. Once visible,
        // the last batch may finalize safely without racing a later progress
        // update that would be rejected by the terminal-state fence.
        const progress = await ConnectorRunModel.updateIfOwned({
          runId: run.id,
          epoch,
          data: {
            totalBatches: batchCount,
            documentsProcessed,
            documentsIngested,
            documentsWithoutText,
            logs: options?.getLogOutput?.() ?? null,
          },
          increments: {
            itemErrors: itemErrors - flushedItemErrors,
            itemsSkipped: itemsSkipped - flushedItemsSkipped,
          },
        });
        if (!progress) {
          return { runId: run.id, status: "superseded" };
        }

        // Handle the edge case where all batches completed before the atomic
        // progress/totalBatches publication above.
        // finalizeBatchesIfComplete atomically checks and transitions if ready.
        const finalizedRun = await ConnectorRunModel.finalizeBatchesIfComplete(
          run.id,
        );
        if (
          finalizedRun &&
          (finalizedRun.status === "success" ||
            finalizedRun.status === "completed_with_errors")
        ) {
          await KnowledgeBaseConnectorModel.update(connectorId, {
            lastSyncStatus: finalizedRun.status,
            lastSyncAt: finalizedRun.completedAt ?? new Date(),
          });
          // Content trigger (all batches drained synchronously here rather
          // than in the batch-embedding handler).
          await enqueuePermissionSyncAfterContentSync({
            connector,
            documentsIngested,
          });
        }
      }

      metrics.rag.reportConnectorSync({
        connectorType: connector.connectorType,
        status: "success",
        durationSeconds: (Date.now() - startTime) / 1000,
        documentsProcessed,
        documentsIngested,
        documentsWithoutText,
      });

      runLog.info(
        {
          documentsProcessed,
          documentsIngested,
          batchCount,
        },
        "Sync completed successfully",
      );

      return { runId: run.id, status: "success" };
    } catch (error) {
      const errorMessage = extractErrorMessage(error);

      // Fenced: only mark this run failed (and mirror to the connector) while we
      // still own it. If it was reclaimed mid-flight, a newer run owns the state.
      const failed = await ConnectorRunModel.updateIfOwned({
        runId: run.id,
        epoch,
        data: {
          status: "failed",
          completedAt: new Date(),
          documentsProcessed,
          documentsIngested,
          documentsWithoutText,
          error: errorMessage,
          logs: options?.getLogOutput?.() ?? null,
        },
        increments: {
          itemErrors: itemErrors - flushedItemErrors,
          itemsSkipped: itemsSkipped - flushedItemsSkipped,
        },
      });

      if (failed) {
        await KnowledgeBaseConnectorModel.update(connectorId, {
          lastSyncStatus: "failed",
          lastSyncError: errorMessage,
          lastSyncAt: new Date(),
        });
      }

      const durationSeconds = (Date.now() - startTime) / 1000;
      metrics.rag.reportConnectorSync({
        connectorType: connector.connectorType,
        status: "failed",
        durationSeconds,
        documentsProcessed,
        documentsIngested,
        documentsWithoutText,
      });

      runLog.error({ error: errorMessage }, "Sync failed");

      return { runId: run.id, status: "failed" };
    }
  }

  /**
   * Ingest a single connector document into kb_documents.
   * Lookup by connectorId + sourceId. Compare contentHash to detect changes.
   * Returns false if the document already exists with the same content (skipped).
   */
  private async ingestDocument(params: {
    doc: ConnectorDocument;
    connectorId: string;
    connectorType: string;
    organizationId: string;
    ftsLanguage: TextSearchLanguage;
    acl: AclEntry[];
    isAutoSync: boolean;
    log: pino.Logger;
  }): Promise<{ ingested: boolean; documentId: string | null }> {
    const {
      doc,
      connectorId,
      connectorType,
      organizationId,
      ftsLanguage,
      acl,
      isAutoSync,
      log,
    } = params;

    // Extracted text (PDF/OOXML, or a plain-text file mis-decoded as UTF-8) can
    // contain NUL bytes, which Postgres text columns reject — the whole document
    // insert would otherwise fail and the document be lost. Sanitize once here so
    // the row, its content hash, and its chunks all derive from the same clean
    // text (and the hash stays stable, so a later clean re-sync still dedupes).
    const content = stripNullBytes(doc.content);
    const title = stripNullBytes(doc.title);

    // Include media data in hash so unchanged images are properly skipped.
    const hashMetadata = metadataForContentHash(
      doc.metadata,
      doc.operationalMetadataKeys,
    );
    const hashInput = doc.mediaContent
      ? `${doc.mediaContent.mimeType}:${doc.mediaContent.data}` +
        (hashMetadata
          ? "\n" +
            JSON.stringify(hashMetadata, Object.keys(hashMetadata).sort())
          : "")
      : hashMetadata
        ? content +
          "\n" +
          JSON.stringify(hashMetadata, Object.keys(hashMetadata).sort())
        : content;
    const contentHash = createHash("sha256").update(hashInput).digest("hex");

    // Lookup existing document by connector + source ID
    const existing = await KbDocumentModel.findBySourceId({
      connectorId,
      sourceId: doc.id,
    });

    if (existing) {
      // Auto-sync connectors preserve the permission-pass-owned ACL only while
      // the source payload and its security-relevant revision are unchanged.
      const effectiveAcl = isAutoSync ? (existing.acl as AclEntry[]) : acl;

      // Same content hash → skip (unchanged)
      if (existing.contentHash === contentHash) {
        const existingChunkCount =
          await knowledgeRetrievalBackend.countDocumentChunks(existing.id);

        if (existingChunkCount === 0) {
          await this.chunkAndStore({
            documentId: existing.id,
            title,
            content,
            mediaContent: doc.mediaContent,
            metadata: doc.metadata,
            connectorType,
            connectorId,
            organizationId,
            ftsLanguage,
            acl: effectiveAcl,
            log,
          });

          await KbDocumentModel.update(existing.id, {
            embeddingStatus: "pending",
          });

          log.warn(
            {
              documentId: doc.id,
              existingDocId: existing.id,
            },
            "Document had no chunks despite unchanged content, repaired and re-queued",
          );
          return { ingested: true, documentId: existing.id };
        }

        // A provider failure leaves the source text and chunks intact so a
        // later connector run can retry without re-fetching/re-chunking. The
        // content hash still matches, but treating that row as an ordinary
        // unchanged document would make the failure permanent.
        if (existing.embeddingStatus === "failed") {
          await KbDocumentModel.update(existing.id, {
            title,
            sourceUrl: doc.sourceUrl ?? null,
            metadata: doc.metadata,
            embeddingStatus: "pending",
          });

          log.warn(
            {
              documentId: doc.id,
              existingDocId: existing.id,
            },
            "Document embedding previously failed, re-queued unchanged chunks",
          );
          return { ingested: true, documentId: existing.id };
        }

        // Baseline generations and source revisions are operational metadata,
        // not content. Keep them current without re-chunking unchanged text.
        if (
          JSON.stringify(existing.metadata ?? {}) !==
            JSON.stringify(doc.metadata ?? {}) ||
          existing.title !== title ||
          existing.sourceUrl !== (doc.sourceUrl ?? null)
        ) {
          await KbDocumentModel.update(existing.id, {
            title,
            sourceUrl: doc.sourceUrl ?? null,
            metadata: doc.metadata,
          });
        }

        log.debug(
          {
            documentId: doc.id,
            existingDocId: existing.id,
          },
          "Document unchanged, skipping",
        );
        return { ingested: false, documentId: null };
      }

      // Content or security-relevant source metadata changed. Auto-sync locks
      // the new revision until permission sync evaluates it; other visibility
      // modes keep the connector-level ACL.
      await KbDocumentModel.update(existing.id, {
        title,
        content,
        contentHash,
        sourceUrl: doc.sourceUrl ?? null,
        // A changed payload must never inherit a permission result evaluated
        // for its older M-Files revision. Lock first; the permission pass
        // unlocks only after evaluating cached+latest source revisions.
        acl: isAutoSync ? [] : acl,
        metadata: doc.metadata,
        embeddingStatus: "pending",
      });
      const chunkAcl = isAutoSync ? [] : acl;

      // Re-chunk: content changed, so replace stale chunks
      await knowledgeRetrievalBackend.deleteDocumentChunks(existing.id);
      await this.chunkAndStore({
        documentId: existing.id,
        title,
        content,
        mediaContent: doc.mediaContent,
        metadata: doc.metadata,
        connectorType,
        connectorId,
        organizationId,
        ftsLanguage,
        acl: chunkAcl,
        log,
      });

      log.debug(
        {
          documentId: doc.id,
          kbDocumentId: existing.id,
        },
        "Updated existing document with new content",
      );
      return { ingested: true, documentId: existing.id };
    }

    // Create new document
    const created = await KbDocumentModel.create({
      organizationId,
      sourceId: doc.id,
      connectorId,
      title,
      content,
      contentHash,
      sourceUrl: doc.sourceUrl,
      acl,
      metadata: doc.metadata,
    });

    await this.chunkAndStore({
      documentId: created.id,
      title,
      content,
      mediaContent: doc.mediaContent,
      metadata: doc.metadata,
      connectorType,
      connectorId,
      organizationId,
      ftsLanguage,
      acl,
      log,
    });

    log.debug(
      {
        documentId: doc.id,
      },
      "Document ingested into kb_documents",
    );
    return { ingested: true, documentId: created.id };
  }

  /**
   * Delegates to the shared helper so the upload path (which stores documents
   * without a sync) chunks identically — see `chunk-and-store.ts`.
   */
  private async chunkAndStore(
    params: Parameters<typeof chunkAndStoreDocument>[0],
  ): Promise<void> {
    await chunkAndStoreDocument(params);
  }

  private buildDocumentAccessControlList(
    connector: KnowledgeBaseConnector,
  ): AclEntry[] {
    return knowledgeSourceAccessControlService.buildConnectorDocumentAccessControlList(
      { connector },
    );
  }
}

export const connectorSyncService = new ConnectorSyncService();

/**
 * Why a run that indexed nothing probably indexed nothing.
 *
 * Only reached when the connector holds no documents at all, so this never
 * second-guesses a healthy incremental sync that simply found no changes.
 * Names the cause when the counters give one away, and otherwise lists the
 * three things that are actually worth checking.
 */
function describeEmptySync(params: {
  itemsSkipped: number;
  documentsProcessed: number;
  itemFetchFailures: number;
  documentsWithoutText: number;
  unsupportedItemsSkipped: number;
}): string {
  const {
    itemsSkipped,
    documentsProcessed,
    itemFetchFailures,
    documentsWithoutText,
    unsupportedItemsSkipped,
  } = params;

  // Items were found and every one of them failed to come back. Pointing at
  // the sharing configuration here would send someone to the wrong console.
  if (itemFetchFailures > 0 && itemsSkipped === 0) {
    return `Indexed nothing: ${itemFetchFailures} item${itemFetchFailures === 1 ? "" : "s"} were found but could not be fetched. See the run logs for the individual failures — the credential can list this source but not read its contents.`;
  }
  if (itemsSkipped > 0 && itemsSkipped === documentsProcessed) {
    // Blaming the file-type filter when the items were readable types with no
    // text (a folder of scanned PDFs) would send someone to the wrong setting.
    if (documentsWithoutText === itemsSkipped && itemFetchFailures === 0) {
      return `Indexed nothing: all ${itemsSkipped} item${itemsSkipped === 1 ? "" : "s"} found contained no extractable text (scanned or image-only PDFs, or files that could not be parsed). The run details name each one.`;
    }
    if (unsupportedItemsSkipped === itemsSkipped && itemFetchFailures === 0) {
      return `Indexed nothing: all ${itemsSkipped} item${itemsSkipped === 1 ? "" : "s"} found were skipped as unsupported types. Widen or remove the file-type filter, or point the connector at content it can read.`;
    }
  }

  if (itemsSkipped > 0) {
    const otherItemsSkipped = Math.max(
      0,
      itemsSkipped - documentsWithoutText - unsupportedItemsSkipped,
    );
    const causes: string[] = [];
    if (itemFetchFailures > 0) {
      causes.push(
        `${itemFetchFailures} item${itemFetchFailures === 1 ? "" : "s"} could not be fetched`,
      );
    }
    if (documentsWithoutText > 0) {
      causes.push(`${documentsWithoutText} contained no extractable text`);
    }
    if (unsupportedItemsSkipped > 0) {
      causes.push(`${unsupportedItemsSkipped} had unsupported types`);
    }
    if (otherItemsSkipped > 0) {
      causes.push(
        `${otherItemsSkipped} ${otherItemsSkipped === 1 ? "was" : "were"} skipped for other reasons`,
      );
    }
    const prefix =
      itemFetchFailures === 0 && itemsSkipped === documentsProcessed
        ? `Indexed nothing: all ${itemsSkipped} item${itemsSkipped === 1 ? "" : "s"} found were skipped — `
        : "Indexed nothing: ";
    return `${prefix}${causes.join("; ")}. See the run logs and run details for each affected item.`;
  }
  return "Indexed nothing: the source returned no items at all. Check that the content is shared with the identity this connector authenticates as, that any folder or project scope points at something that identity can see, and that a file-type filter is not excluding everything. Test connection reports which of those it is.";
}

/**
 * Remove NUL (U+0000) bytes from a string. Postgres `text`/`jsonb` columns
 * cannot store NUL and node-postgres throws when a bound parameter contains one,
 * which would fail an entire document insert. Binary text extraction (PDF, OOXML)
 * and plain-text files mis-decoded as UTF-8 routinely emit NUL. Returns the input
 * unchanged (same reference) when there is nothing to strip — the common case.
 */
function stripNullBytes(text: string): string {
  return text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
}

function metadataForContentHash(
  metadata: Record<string, unknown> | undefined,
  operationalKeys: string[] | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || !operationalKeys?.length) return metadata;
  const ignored = new Set(operationalKeys);
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !ignored.has(key)),
  );
}
