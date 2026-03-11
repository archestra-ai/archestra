import { createHash } from "node:crypto";
import type pino from "pino";
import defaultLogger from "@/logging";
import {
  ConnectorRunModel,
  KbChunkModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
} from "@/models";
import { secretManager } from "@/secrets-manager";
import { taskQueueService } from "@/task-queue";
import type { AclEntry } from "@/types/kb-document";
import type {
  ConnectorCredentials,
  ConnectorDocument,
} from "@/types/knowledge-connector";
import { chunkDocument } from "./chunker";
import {
  BaseConnector,
  extractErrorMessage,
} from "./connectors/base-connector";
import { getConnector } from "./connectors/registry";

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

    // Load credentials from secrets manager
    const credentials = await this.loadCredentials(connector.secretId, log);

    // Get the connector implementation
    const connectorImpl = getConnector(connector.connectorType);

    // Interrupt any stale "running" runs left by previous attempts
    const interrupted =
      await ConnectorRunModel.interruptActiveRuns(connectorId);
    if (interrupted > 0) {
      log.info(
        { connectorId, interrupted },
        "[ConnectorSync] Interrupted stale running runs",
      );
    }

    // Create a connector run record
    const run = await ConnectorRunModel.create({
      connectorId,
      status: "running",
      startedAt: new Date(),
      documentsProcessed: 0,
      documentsIngested: 0,
    });

    // Bind runId to logger so every log line in this sync includes it
    const runLog = log.child({ runId: run.id, connectorId });

    // Propagate the run-scoped logger into the connector implementation
    if (connectorImpl instanceof BaseConnector) {
      connectorImpl.setLogger(runLog);
    }

    // Update connector lastSyncStatus to running
    await KnowledgeBaseConnectorModel.update(connectorId, {
      lastSyncStatus: "running",
    });

    // Estimate total items for progress display
    try {
      const totalItems = await connectorImpl.estimateTotalItems({
        config: connector.config as Record<string, unknown>,
        credentials,
        checkpoint: connector.checkpoint as Record<string, unknown> | null,
      });

      if (totalItems !== null && totalItems > 0) {
        await ConnectorRunModel.update(run.id, { totalItems });
        runLog.info({ totalItems }, "[ConnectorSync] Estimated total items");
      }
    } catch (error) {
      runLog.warn(
        {
          error: extractErrorMessage(error),
        },
        "[ConnectorSync] Failed to estimate total items, continuing without",
      );
    }

    let documentsProcessed = 0;
    let documentsIngested = 0;
    let itemErrors = 0;
    let batchCount = 0;
    const startTime = Date.now();
    let stoppedEarly = false;

    try {
      const syncGenerator = connectorImpl.sync({
        config: connector.config as Record<string, unknown>,
        credentials,
        checkpoint: connector.checkpoint as Record<string, unknown> | null,
      });

      for await (const batch of syncGenerator) {
        const ingestedDocumentIds: string[] = [];
        for (const doc of batch.documents) {
          documentsProcessed++;
          try {
            const result = await this.ingestDocument({
              doc,
              connectorId,
              connectorType: connector.connectorType,
              organizationId: connector.organizationId,
              log: runLog,
            });
            if (result.ingested) {
              documentsIngested++;
            }
            if (result.ingested && result.documentId) {
              ingestedDocumentIds.push(result.documentId);
            }
          } catch (docError) {
            runLog.warn(
              {
                documentId: doc.id,
                error: extractErrorMessage(docError),
              },
              "[ConnectorSync] Failed to ingest document",
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

        // Update run progress + flush logs after each batch
        await ConnectorRunModel.update(run.id, {
          documentsProcessed,
          documentsIngested,
          itemErrors,
          logs: options?.getLogOutput?.() ?? null,
        });

        // Update connector checkpoint
        await KnowledgeBaseConnectorModel.update(connectorId, {
          checkpoint: batch.checkpoint,
        });

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
              "[ConnectorSync] Time budget exceeded, stopping early for continuation",
            );
            break;
          }
        }
      }

      // Set totalBatches so batch_embedding handlers can coordinate
      if (batchCount > 0) {
        await ConnectorRunModel.update(run.id, { totalBatches: batchCount });
      }

      if (stoppedEarly) {
        // Partial completion — will be continued by a follow-up run
        await ConnectorRunModel.update(run.id, {
          status: "partial",
          completedAt: new Date(),
          documentsProcessed,
          documentsIngested,
          logs: options?.getLogOutput?.() ?? null,
        });

        await KnowledgeBaseConnectorModel.update(connectorId, {
          lastSyncStatus: "partial",
        });

        runLog.info(
          { documentsProcessed, documentsIngested },
          "[ConnectorSync] Partial sync completed, continuation needed",
        );

        return { runId: run.id, status: "partial" };
      }

      if (batchCount === 0) {
        // No documents ingested — finalize immediately
        const now = new Date();
        const finalStatus =
          itemErrors > 0 ? "completed_with_errors" : "success";
        await ConnectorRunModel.update(run.id, {
          status: finalStatus,
          completedAt: now,
          documentsProcessed,
          documentsIngested,
          itemErrors,
          logs: options?.getLogOutput?.() ?? null,
        });

        await KnowledgeBaseConnectorModel.update(connectorId, {
          lastSyncStatus: finalStatus,
          lastSyncAt: now,
          lastSyncError: null,
        });
      } else {
        // Batches were enqueued — update progress but leave status as "running"
        // The last batch_embedding task will finalize the run
        await ConnectorRunModel.update(run.id, {
          documentsProcessed,
          documentsIngested,
          logs: options?.getLogOutput?.() ?? null,
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

      runLog.info(
        {
          documentsProcessed,
          documentsIngested,
          batchCount,
        },
        "[ConnectorSync] Sync completed successfully",
      );

      return { runId: run.id, status: "success" };
    } catch (error) {
      const errorMessage = extractErrorMessage(error);

      await ConnectorRunModel.update(run.id, {
        status: "failed",
        completedAt: new Date(),
        documentsProcessed,
        documentsIngested,
        error: errorMessage,
        logs: options?.getLogOutput?.() ?? null,
      });

      await KnowledgeBaseConnectorModel.update(connectorId, {
        lastSyncStatus: "failed",
        lastSyncError: errorMessage,
        lastSyncAt: new Date(),
      });

      runLog.error({ error: errorMessage }, "[ConnectorSync] Sync failed");

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
    log: pino.Logger;
  }): Promise<{ ingested: boolean; documentId: string | null }> {
    const { doc, connectorId, connectorType, organizationId, log } = params;

    const contentHash = createHash("sha256").update(doc.content).digest("hex");

    // Lookup existing document by connector + source ID
    const existing = await KbDocumentModel.findBySourceId({
      connectorId,
      sourceId: doc.id,
    });

    if (existing) {
      // Same content hash → skip (unchanged)
      if (existing.contentHash === contentHash) {
        log.debug(
          {
            documentId: doc.id,
            existingDocId: existing.id,
          },
          "[ConnectorSync] Document unchanged, skipping",
        );
        return { ingested: false, documentId: null };
      }

      // Content has changed — update existing document
      await KbDocumentModel.update(existing.id, {
        title: doc.title,
        content: doc.content,
        contentHash,
        sourceUrl: doc.sourceUrl ?? null,
        metadata: {
          ...doc.metadata,
          connectorType,
        },
        embeddingStatus: "pending",
      });

      // Re-chunk: content changed, so replace stale chunks
      await KbChunkModel.deleteByDocument(existing.id);
      await this.chunkAndStore({
        documentId: existing.id,
        title: doc.title,
        content: doc.content,
        acl: existing.acl as AclEntry[],
        log,
      });

      log.debug(
        {
          documentId: doc.id,
          kbDocumentId: existing.id,
        },
        "[ConnectorSync] Updated existing document with new content",
      );
      return { ingested: true, documentId: existing.id };
    }

    // Create new document
    const created = await KbDocumentModel.create({
      organizationId,
      sourceId: doc.id,
      connectorId,
      title: doc.title,
      content: doc.content,
      contentHash,
      sourceUrl: doc.sourceUrl,
      acl: [],
      metadata: {
        ...doc.metadata,
        connectorType,
      },
    });

    await this.chunkAndStore({
      documentId: created.id,
      title: doc.title,
      content: doc.content,
      acl: [],
      log,
    });

    log.debug(
      {
        documentId: doc.id,
      },
      "[ConnectorSync] Document ingested into kb_documents",
    );
    return { ingested: true, documentId: created.id };
  }

  private async chunkAndStore(params: {
    documentId: string;
    title: string;
    content: string;
    acl: AclEntry[];
    log: pino.Logger;
  }): Promise<void> {
    const { documentId, title, content, acl, log } = params;

    const chunks = await chunkDocument({ title, content });

    if (chunks.length === 0) return;

    await KbChunkModel.insertMany(
      chunks.map((chunk) => ({
        documentId,
        content: chunk.content,
        chunkIndex: chunk.chunkIndex,
        acl,
      })),
    );

    log.debug(
      { documentId, chunkCount: chunks.length },
      "[ConnectorSync] Document chunked and stored",
    );
  }

  private async loadCredentials(
    secretId: string | null,
    log: pino.Logger,
  ): Promise<ConnectorCredentials> {
    if (!secretId) {
      throw new Error("Connector has no associated secret");
    }

    const secret = await secretManager().getSecret(secretId);
    if (!secret) {
      throw new Error(`Secret not found: ${secretId}`);
    }

    log.debug({ secretId }, "[ConnectorSync] Credentials loaded");

    const data = secret.secret as Record<string, unknown>;
    return {
      email: (data.email as string) || "",
      apiToken: (data.apiToken as string) || "",
    };
  }
}

export const connectorSyncService = new ConnectorSyncService();
