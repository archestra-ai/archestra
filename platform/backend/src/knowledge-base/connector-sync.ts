import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ModelInputModality } from "@archestra/shared";
import type pino from "pino";
import config from "@/config";
import defaultLogger from "@/logging";
import {
  ConnectorRunModel,
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import * as metrics from "@/observability/metrics";
import { taskQueueService } from "@/task-queue";
import type {
  AclEntry,
  ConnectorDocument,
  ConnectorRun,
  KnowledgeBaseConnector,
} from "@/types";
import { chunkDocument } from "./chunker";
import { resolveConnectorCredentials } from "./connector-credentials";
import {
  BaseConnector,
  extractErrorMessage,
} from "./connectors/base-connector";
import { getConnector } from "./connectors/registry";
import { resolveEmbeddingConfig } from "./kb-llm-client";
import { knowledgeSourceAccessControlService } from "./source-access-control";

/**
 * Identity of this worker process, used as the connector-run lease owner. The
 * fencing epoch (not this string) is what enforces correctness; the owner is a
 * human-readable tie-breaker and heartbeat guard.
 */
const WORKER_ID = `${hostname()}#${process.pid}`;

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

    // Load credentials from secrets manager
    const [credentials, documentAcl] = await Promise.all([
      resolveConnectorCredentials(connector),
      this.buildDocumentAccessControlList(connector),
    ]);

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
    let batchCount = 0;
    const startTime = Date.now();
    let stoppedEarly = false;

    // Resolve the embedding model's supported input modalities so connectors
    // can conditionally ingest non-text content (e.g. images).
    // Must happen before estimateTotalItems so the estimate matches sync behavior.
    let embeddingInputModalities: ModelInputModality[] | undefined;
    try {
      const embeddingConfig = await resolveEmbeddingConfig(
        connector.organizationId,
      );
      embeddingInputModalities = embeddingConfig?.inputModalities ?? undefined;
    } catch {
      // Non-fatal: proceed without modality info
    }

    // Estimate total items for progress display
    try {
      const totalItems = await connectorImpl.estimateTotalItems({
        config: connector.config as Record<string, unknown>,
        credentials,
        checkpoint: connector.checkpoint as Record<string, unknown> | null,
        embeddingInputModalities,
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

        const ingestedDocumentIds: string[] = [];
        for (const doc of batch.documents) {
          documentsProcessed++;
          try {
            const result = await this.ingestDocument({
              doc,
              connectorId,
              connectorType: connector.connectorType,
              organizationId: connector.organizationId,
              acl: documentAcl,
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

        // Track item-level failures from this batch
        if (batch.failures?.length) {
          itemErrors += batch.failures.length;
        }

        // Track skipped items from this batch
        if (batch.skipped?.length) {
          itemsSkipped += batch.skipped.length;
          documentsProcessed += batch.skipped.length;
          for (const s of batch.skipped) {
            runLog.debug(
              { itemId: s.itemId, name: s.name, reason: s.reason },
              "Item skipped",
            );
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
            itemErrors,
            itemsSkipped,
            logs: options?.getLogOutput?.() ?? null,
          },
        });

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

      // Set totalBatches so batch_embedding handlers can coordinate (fenced).
      if (batchCount > 0) {
        await ConnectorRunModel.updateIfOwned({
          runId: run.id,
          epoch,
          data: { totalBatches: batchCount },
        });
      }

      if (stoppedEarly) {
        // Partial completion — will be continued by a follow-up run.
        const updated = await ConnectorRunModel.updateIfOwned({
          runId: run.id,
          epoch,
          data: {
            status: "partial",
            completedAt: new Date(),
            documentsProcessed,
            documentsIngested,
            itemErrors,
            itemsSkipped,
            logs: options?.getLogOutput?.() ?? null,
          },
        });

        if (updated) {
          await KnowledgeBaseConnectorModel.update(connectorId, {
            lastSyncStatus: "partial",
            lastSyncError: null,
          });
        }

        const durationSeconds = (Date.now() - startTime) / 1000;
        metrics.rag.reportConnectorSync({
          connectorType: connector.connectorType,
          status: "partial",
          durationSeconds,
          documentsProcessed,
          documentsIngested,
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
        const finalStatus =
          itemErrors > 0 ? "completed_with_errors" : "success";
        const updated = await ConnectorRunModel.updateIfOwned({
          runId: run.id,
          epoch,
          data: {
            status: finalStatus,
            completedAt: now,
            documentsProcessed,
            documentsIngested,
            itemErrors,
            itemsSkipped,
            logs: options?.getLogOutput?.() ?? null,
          },
        });

        if (updated) {
          await KnowledgeBaseConnectorModel.update(connectorId, {
            lastSyncStatus: finalStatus,
            lastSyncAt: now,
            lastSyncError: null,
          });
        }
      } else {
        // Batches were enqueued — update progress but leave status as "running";
        // the last batch_embedding task finalizes the run.
        await ConnectorRunModel.updateIfOwned({
          runId: run.id,
          epoch,
          data: {
            documentsProcessed,
            documentsIngested,
            logs: options?.getLogOutput?.() ?? null,
          },
        });

        // Handle edge case: all batches may have completed before totalBatches was set.
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
        }
      }

      metrics.rag.reportConnectorSync({
        connectorType: connector.connectorType,
        status: "success",
        durationSeconds: (Date.now() - startTime) / 1000,
        documentsProcessed,
        documentsIngested,
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
          itemErrors,
          itemsSkipped,
          error: errorMessage,
          logs: options?.getLogOutput?.() ?? null,
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
    acl: AclEntry[];
    log: pino.Logger;
  }): Promise<{ ingested: boolean; documentId: string | null }> {
    const { doc, connectorId, connectorType, organizationId, acl, log } =
      params;

    // Extracted text (PDF/OOXML, or a plain-text file mis-decoded as UTF-8) can
    // contain NUL bytes, which Postgres text columns reject — the whole document
    // insert would otherwise fail and the document be lost. Sanitize once here so
    // the row, its content hash, and its chunks all derive from the same clean
    // text (and the hash stays stable, so a later clean re-sync still dedupes).
    const content = stripNullBytes(doc.content);
    const title = stripNullBytes(doc.title);

    // Include media data in hash so unchanged images are properly skipped.
    const hashInput = doc.mediaContent
      ? `${doc.mediaContent.mimeType}:${doc.mediaContent.data}` +
        (doc.metadata
          ? "\n" +
            JSON.stringify(doc.metadata, Object.keys(doc.metadata).sort())
          : "")
      : doc.metadata
        ? content +
          "\n" +
          JSON.stringify(doc.metadata, Object.keys(doc.metadata).sort())
        : content;
    const contentHash = createHash("sha256").update(hashInput).digest("hex");

    // Lookup existing document by connector + source ID
    const existing = await KbDocumentModel.findBySourceId({
      connectorId,
      sourceId: doc.id,
    });

    if (existing) {
      // Same content hash → skip (unchanged)
      if (existing.contentHash === contentHash) {
        const existingChunkCount = await KbChunkModel.countByDocument(
          existing.id,
        );

        if (existingChunkCount === 0) {
          await this.chunkAndStore({
            documentId: existing.id,
            title,
            content,
            mediaContent: doc.mediaContent,
            metadata: doc.metadata,
            connectorType,
            acl,
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

        log.debug(
          {
            documentId: doc.id,
            existingDocId: existing.id,
          },
          "Document unchanged, skipping",
        );
        return { ingested: false, documentId: null };
      }

      // Content has changed — update existing document
      await KbDocumentModel.update(existing.id, {
        title,
        content,
        contentHash,
        sourceUrl: doc.sourceUrl ?? null,
        acl,
        metadata: doc.metadata,
        embeddingStatus: "pending",
      });

      // Re-chunk: content changed, so replace stale chunks
      await KbChunkModel.deleteByDocument(existing.id);
      await this.chunkAndStore({
        documentId: existing.id,
        title,
        content,
        mediaContent: doc.mediaContent,
        metadata: doc.metadata,
        connectorType,
        acl,
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

  private async chunkAndStore(params: {
    documentId: string;
    title: string;
    content: string;
    mediaContent?: { mimeType: string; data: string };
    metadata?: Record<string, unknown>;
    connectorType: string;
    acl: AclEntry[];
    log: pino.Logger;
  }): Promise<void> {
    const {
      documentId,
      title,
      content,
      mediaContent,
      metadata,
      connectorType,
      acl,
      log,
    } = params;

    // For media (image) documents: create a single chunk whose content is the
    // data URL. The embedding pipeline detects this prefix and routes to the
    // multimodal embedding API instead of text embedding.
    if (mediaContent) {
      const dataUrl = `data:${mediaContent.mimeType};base64,${mediaContent.data}`;
      await KbChunkModel.insertMany([
        {
          documentId,
          content: dataUrl,
          chunkIndex: 0,
          metadataSuffixSemantic: null,
          metadataSuffixKeyword: null,
          acl,
        },
      ]);
      metrics.rag.reportChunksCreated(connectorType, 1);
      log.debug({ documentId }, "Image document stored as single media chunk");
      return;
    }

    const chunks = await chunkDocument({ title, content, metadata });

    if (chunks.length === 0) return;

    await KbChunkModel.insertMany(
      chunks.map((chunk) => ({
        documentId,
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        metadataSuffixSemantic: chunk.metadataSuffixSemantic,
        metadataSuffixKeyword: chunk.metadataSuffixKeyword,
        acl,
      })),
    );

    metrics.rag.reportChunksCreated(connectorType, chunks.length);

    log.debug(
      { documentId, chunkCount: chunks.length },
      "Document chunked and stored",
    );
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
 * Remove NUL (U+0000) bytes from a string. Postgres `text`/`jsonb` columns
 * cannot store NUL and node-postgres throws when a bound parameter contains one,
 * which would fail an entire document insert. Binary text extraction (PDF, OOXML)
 * and plain-text files mis-decoded as UTF-8 routinely emit NUL. Returns the input
 * unchanged (same reference) when there is nothing to strip — the common case.
 */
function stripNullBytes(text: string): string {
  return text.includes("\u0000") ? text.replaceAll("\u0000", "") : text;
}
